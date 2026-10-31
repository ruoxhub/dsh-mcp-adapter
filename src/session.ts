// One Agent's MCP session: config, connection pool, catalog, and the tools it registers.
//
// dsh gives a plugin an Agent-scoped context (`agent.ctx`), and a tool registered there is visible
// only to that Agent. That is the right unit for this adapter: two sessions in different projects
// must not see each other's servers, and closing a session must stop its servers.

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { needsApproval, requireApproval } from './approval.ts'
import { cachedEntry, loadCache, saveCache, storeEntry, cachePath } from './cache.ts'
import type { CatalogCache } from './cache.ts'
import { buildCatalog, searchTools } from './catalog.ts'
import type { BuildCatalogEntry } from './catalog.ts'
import { isDisabledEntry, loadConfig } from './config.ts'
import type { AdapterSettings } from './config.ts'
import { directToolDefinition, resolveDirectTools } from './direct.ts'
import { flattenPromptResult, parsePromptArgs, promptCommandName } from './prompts.ts'
import { createProxyExecutor, PROXY_DESCRIPTION, PROXY_PARAMETERS, PROXY_TOOL_NAME } from './proxy.ts'
import type { SpillStoreLike } from './proxy.ts'
import { ServerPool } from './servers.ts'
import type { Logger } from './servers.ts'
import { approvalsPath, approve, definitionHash, partition } from './trust.ts'
import type { BlockedServer } from './trust.ts'
import type { Catalog, CatalogPrompt, CatalogTool, ContentBlock, ServerConfig, ToolRunLike } from './types.ts'

export const IDLE_SWEEP_INTERVAL_MS = 30_000

/** What `signature()` reads off a file: the two fields that change when the file does. */
export interface StatLike {
  mtimeMs: number
  size: number
}

/**
 * The Loader entry plus the fields the per-project reload needs: where the harness home is, the
 * inline servers, and the extra config files. `home` is the adapter state directory `sync()` records
 * from the loaded config; a caller may supply it, but `sanitizeConfig` never does.
 */
export interface McpSessionSettings extends AdapterSettings {
  dshHome: string
  servers: Record<string, unknown>
  configFiles: unknown[]
  home?: string
}

/** What the session needs at construction. */
export interface McpSessionOptions {
  /** The Agent's own Cordis context (tools/commands register here). */
  ctx: Context
  /** The dsh Agent. */
  agent: Agent
  /** Validated Loader config. */
  settings: McpSessionSettings
  /** Cordis logger. */
  logger: Logger
  /** `statSync`, injected so tests do not need the real filesystem. */
  stat: (path: string) => StatLike
  /**
   * Called after a tool call changed which servers are running.
   *
   * A lazy server is started by the call itself, so without this the panel would keep showing the
   * server as stopped until something else published a snapshot.
   */
  onStatus?: () => void
}

/** An object-shaped value, arrays included. */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * `error?.message ?? error`, without reading a property off a primitive. A thrown value is whatever
 * the pool or the SDK raised, so it arrives as `unknown` here.
 */
function messageOf(error: unknown): string {
  if (isObjectLike(error) && error.message !== undefined && error.message !== null) return String(error.message)
  return String(error)
}

/** A cheap identity for "these config files, with these contents". */
function signature(paths: string[], stat: (path: string) => StatLike): string {
  return paths.map((path) => {
    try {
      const info = stat(path)
      return `${path}:${info.mtimeMs}:${info.size}`
    } catch {
      return `${path}:-`
    }
  }).join('|')
}

/**
 * The adapter's own policy keys, so nothing has to remember to add one in two places.
 *
 * `requestTimeoutMs` IS forwarded: it is the settings-level default every server inherits, and a
 * per-server value still wins because the pool reads the entry first. It was previously excluded,
 * which made the documented setting inert — a server with no `requestTimeoutMs` silently used the
 * pool's 60 s constant no matter what the user configured.
 */
function pickPolicySettings(settings: McpSessionSettings): Pick<AdapterSettings, 'idleTimeout' | 'projectServers' | 'directTools' | 'approveTools' | 'exposeResources' | 'toolPrefix' | 'importHosts' | 'maxOutputChars' | 'requestTimeoutMs'> {
  return {
    idleTimeout: settings.idleTimeout,
    requestTimeoutMs: settings.requestTimeoutMs,
    projectServers: settings.projectServers,
    directTools: settings.directTools,
    approveTools: settings.approveTools,
    exposeResources: settings.exposeResources,
    toolPrefix: settings.toolPrefix,
    importHosts: settings.importHosts,
    maxOutputChars: settings.maxOutputChars,
  }
}

/**
 * The source's `value?.content ?? [{ type: 'text', text: String(value ?? '') }]`.
 *
 * `createProxyExecutor` always returns `{ content: ContentBlock[] }` and this adapter's
 * `ContentBlock` is text-only, so the array case is narrowed block by block instead of handed to
 * the tool contract unvalidated. Anything else — a value with no usable `content`, which the proxy
 * never produces — renders as its string form, exactly as the source's fallback did.
 */
function proxyBlocks(value: unknown): ContentBlock[] {
  const content = isObjectLike(value) ? value.content : undefined
  if (isTextBlocks(content)) return content
  return [{ type: 'text', text: String(value ?? '') }]
}

/** Whether a value is a list of text blocks, the only block shape this adapter emits. */
function isTextBlocks(value: unknown): value is ContentBlock[] {
  if (!Array.isArray(value)) return false
  const blocks: unknown[] = value
  return blocks.every((block) => isObjectLike(block) && block.type === 'text' && typeof block.text === 'string')
}

export class McpSession {
  ctx: Context
  agent: Agent
  settings: McpSessionSettings
  logger: Logger
  stat: (path: string) => StatLike
  pool: ServerPool
  catalog: Catalog
  blocked: BlockedServer[]
  errors: string[]
  configSignature: string
  projectRoot: string
  disposers: Array<() => void>
  directDisposers: Map<string, () => void>
  /** Prompt command disposers; created by the first `syncPromptCommands()`. */
  promptDisposers: Map<string, () => void> | undefined
  activated: Set<string>
  timer: ReturnType<typeof setInterval> | undefined
  closed: boolean
  catalogStale: boolean
  /** Set once `registerTools()` ran; `rebuildCatalog()` re-syncs prompt commands only after it. */
  toolsRegistered: boolean | undefined
  /** The persisted catalog cache, loaded by `sync()`. */
  cache: CatalogCache | undefined
  /** The adapter state directory the cache lives in, recorded by `sync()`. */
  cachePathResolver: string | undefined
  /**
   * The execution context of the tool call in flight. `createProxyExecutor` assigns it before any
   * other member is touched, so approval and the MCP request share one call id and one signal.
   */
  execContext: ToolRunLike | undefined
  /** Called after a tool call changed which servers are running; see {@link McpSessionOptions.onStatus}. */
  onStatus: (() => void) | undefined

  constructor({ ctx, agent, settings, logger, stat, onStatus }: McpSessionOptions) {
    this.ctx = ctx
    this.agent = agent
    this.settings = settings
    this.logger = logger
    this.stat = stat
    this.onStatus = onStatus
    // `home` is the adapter state directory the pool records and never reads; the Loader entry has
    // no such field, so the source passed `undefined` here.
    this.pool = new ServerPool({ home: settings.home ?? '', logger, onCatalog: () => this.invalidateCatalog() })
    this.catalog = buildCatalog(new Map<string, BuildCatalogEntry>(), settings)
    this.blocked = []
    this.errors = []
    this.configSignature = ''
    this.projectRoot = ''
    this.disposers = []
    this.directDisposers = new Map()
    this.activated = new Set()
    this.timer = undefined
    this.closed = false
    this.catalogStale = true
  }

  get home(): string {
    return this.settings.home ?? this.cachePathResolver ?? ''
  }

  get maxOutputChars(): number {
    return this.settings.maxOutputChars ?? 40_000
  }

  /**
   * The host's spill backend, when the composition mounts one.
   *
   * Read through `ctx.get(name, false)` because `spillStore` is optional: a composition without
   * `dsh-spill-local` must still spill, through this adapter's own file.
   */
  get spillStore(): SpillStoreLike | undefined {
    const store = this.ctx.get?.('spillStore', false)
    if (store === null || typeof store !== 'object') return undefined
    return typeof (store as { saveText?: unknown }).saveText === 'function' ? (store as SpillStoreLike) : undefined
  }

  /** The session a host-side spill record is grouped by. */
  get sessionId(): string | undefined {
    const id = this.agent?.session?.id
    return typeof id === 'string' ? id : undefined
  }

  /** Read config and prepare the pool. Does not connect anything. */
  async sync(): Promise<void> {
    const cwd = this.agent?.session?.header?.cwd ?? process.cwd()
    const loaded = loadConfig({
      cwd,
      dshHome: this.settings.dshHome,
      servers: this.settings.servers,
      configFiles: this.settings.configFiles,
      // The Loader entry is the base layer; a project's own `settings` file overrides it inside
      // loadConfig. Every adapter policy belongs here, or it silently reverts to the default.
      settings: pickPolicySettings(this.settings),
    })
    this.projectRoot = loaded.projectRoot
    this.errors = [...loaded.errors]
    this.configSignature = signature(loaded.paths, this.stat)
    const { mount, blocked } = partition({
      servers: loaded.servers,
      projectRoot: loaded.projectRoot,
      policy: loaded.settings.projectServers,
      approvalsFile: approvalsPath(loaded.home),
    })
    this.blocked = blocked
    this.settings = { ...this.settings, ...loaded.settings, home: loaded.home }
    this.pool.settings = this.settings
    // `partition` drops disabled entries, but its result type still carries the union: narrow once
    // so every later read of a server field is checked.
    const mounted: Array<{ config: ServerConfig }> = []
    for (const entry of mount) {
      if (!isDisabledEntry(entry.config)) mounted.push({ config: entry.config })
    }
    await this.pool.configure(mounted)
    // Warm catalogs from the cache so search and describe work before any server starts.
    const cache = loadCache(cachePath(loaded.home))
    for (const { config } of mounted) {
      const cached = cachedEntry(cache, config.name, config)
      const entry = this.pool.get(config.name)
      if (entry === undefined) continue
      entry.catalog = cached ?? undefined
    }
    this.cache = cache
    this.cachePathResolver = loaded.home
    await this.rebuildCatalog()
  }

  /**
   * Start the servers whose lifecycle says they should already be running.
   *
   * Kept separate from `sync()` because `sync()` must stay offline: it runs on every config edit and
   * on the cold path, and a `keep-alive` server that is unreachable must not make the session's
   * setup fail. `index.ts` calls this after `registerTools()`, unawaited.
   */
  async warmEager(): Promise<void> {
    await this.pool.warmEager()
    if (this.catalogStale) await this.rebuildCatalog()
  }

  /** Rebuild the model-facing catalog from every server's cached or live catalog. */
  async rebuildCatalog(): Promise<Catalog> {
    const entries = new Map<string, BuildCatalogEntry>()
    for (const name of this.pool.names()) {
      const entry = this.pool.get(name)
      if (entry === undefined) continue
      const catalog = entry.catalog ?? { tools: [], resources: [], prompts: [], instructions: '' }
      entries.set(name, { config: entry.config, catalog })
    }
    this.catalog = buildCatalog(entries, this.settings)
    this.catalogStale = false
    this.syncDirectTools()
    if (this.promptDisposers !== undefined || this.toolsRegistered) this.syncPromptCommands()
    return this.catalog
  }

  /**
   * Make sure every server has a catalog: cache first, live for the ones that have none.
   * This is the step that starts a server — a cold session must start servers to learn their tools,
   * exactly like pi-mcp-adapter's first-session metadata fetch.
   */
  async refreshCatalog(): Promise<Catalog> {
    const missing = this.pool.names().filter((name) => this.pool.get(name)?.catalog === undefined)
    if (missing.length > 0) {
      await Promise.all(missing.map(async (name) => {
        try {
          const catalog = await this.pool.catalog(name)
          const entry = this.pool.get(name)
          if (entry === undefined) return
          const cache = this.cache
          if (cache === undefined) throw new Error('mcp-adapter: refreshCatalog() ran before sync(), so there is no cache to write')
          storeEntry(cache, name, entry.config, catalog)
          this.persistCache()
        } catch (error) {
          this.errors.push(`${name}: ${messageOf(error)}`)
        }
      }))
    }
    if (this.catalogStale) await this.rebuildCatalog()
    return this.catalog
  }

  persistCache(): void {
    try {
      const home = this.cachePathResolver
      const cache = this.cache
      if (home === undefined || cache === undefined) throw new Error('the session has not synced yet, so it has no cache path')
      saveCache(cachePath(home), cache)
    } catch (error) {
      this.logger.debug?.(`mcp-adapter: could not write the metadata cache: ${messageOf(error)}`)
    }
  }

  invalidateCatalog(): void {
    this.catalogStale = true
  }

  /**
   * One call path for the proxy, direct tools, and prompts: resolve the tool, apply the approval
   * policy, then dispatch. Keeping it in one place is why nothing can call an MCP tool ungated.
   */
  async callApproved(toolName: string, args: unknown, exec: ToolRunLike | undefined): Promise<unknown> {
    await this.refreshCatalog()
    const tool = this.catalog.tools.get(toolName)
      ?? [...this.catalog.tools.values()].find((candidate) => candidate.originalName === toolName)
    if (tool === undefined) throw new Error(`unknown MCP tool "${toolName}"`)
    const config = this.pool.get(tool.server)?.config
    if (needsApproval(config, tool, this.settings)) {
      await requireApproval(this.agent, this.ctx, tool, exec, config, this.settings)
    }
    try {
      return await this.pool.callTool(tool.server, tool.originalName, args, exec)
    } finally {
      // The call may have started the server it needed, so the panel's snapshot is stale either way.
      this.onStatus?.()
    }
  }

  /** Register the proxy tool and, for servers that asked for them, direct tools. */
  registerTools(): void {
    this.toolsRegistered = true
    const proxy = this.proxyDefinition()
    this.disposers.push(this.ctx.tools.register(proxy))
    this.syncDirectTools()
    this.syncPromptCommands()
  }

  /**
   * Expose each server prompt as `/mcp__<server>__<prompt>`. dsh registers commands per scope, so
   * this is the same mapping pi-mcp-adapter makes onto Pi's slash commands.
   *
   * The handler returns a `CommandResult`, not a bare string: `CommandRuntime` rejects any other
   * return shape with a TypeError, so both the rendered prompt and the missing-argument refusal are
   * `{ kind, text }`.
   */
  syncPromptCommands(): void {
    this.promptDisposers ??= new Map()
    const wanted = new Map<string, CatalogPrompt>()
    for (const prompt of this.catalog.prompts.values()) {
      wanted.set(promptCommandName(prompt.server, prompt.name), prompt)
    }
    for (const [name, dispose] of this.promptDisposers) {
      if (wanted.has(name)) continue
      this.promptDisposers.delete(name)
      try {
        dispose()
      } catch {
        // Already gone.
      }
    }
    for (const [name, prompt] of wanted) {
      if (this.promptDisposers.has(name)) continue
      const argumentsHint = (prompt.arguments ?? []).map((argument) => argument.name).join(' ')
      const dispose = this.ctx.commands.register({
        name,
        description: prompt.description || `MCP prompt from ${prompt.server}`,
        input: { hint: argumentsHint.length > 0 ? argumentsHint : 'no arguments' },
        handler: async (invocation): Promise<CommandResult> => {
          const { args, missing } = parsePromptArgs(invocation?.rawInput ?? '', prompt.arguments ?? [])
          if (missing.length > 0) return { kind: 'error', text: `missing required argument(s): ${missing.join(', ')}` }
          const result = await this.pool.getPrompt(prompt.server, prompt.name, args)
          return { kind: 'success', text: flattenPromptResult(result) }
        },
      })
      this.promptDisposers.set(name, dispose)
    }
  }

  proxyDefinition(): ToolDefinition {
    return {
      name: PROXY_TOOL_NAME,
      description: PROXY_DESCRIPTION,
      parameters: PROXY_PARAMETERS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => proxyBlocks(value),
      },
      execute: createProxyExecutor(() => this),
    }
  }

  entries(): Map<string, BuildCatalogEntry> {
    const map = new Map<string, BuildCatalogEntry>()
    for (const name of this.pool.names()) {
      const entry = this.pool.get(name)
      if (entry === undefined) continue
      map.set(name, { config: entry.config, catalog: entry.catalog ?? { tools: [], resources: [], prompts: [], instructions: '' } })
    }
    return map
  }

  /** Add or drop direct tools whose definition changed. Never re-registers an unchanged tool. */
  syncDirectTools(): void {
    const wanted = new Map<string, { tool: CatalogTool; hidden: boolean }>()
    for (const name of this.pool.names()) {
      const entry = this.pool.get(name)
      if (entry === undefined) continue
      const config = entry.config
      const serverTools = [...this.catalog.tools.values()].filter((tool) => tool.server === config.name)
      const { names, hidden } = resolveDirectTools(config, serverTools, this.settings)
      for (const toolName of names) {
        const tool = this.catalog.tools.get(toolName)
        if (tool === undefined) continue
        wanted.set(toolName, { tool, hidden: hidden.has(toolName) })
      }
    }
    for (const [name, dispose] of this.directDisposers) {
      if (wanted.has(name)) continue
      this.directDisposers.delete(name)
      this.activated.delete(name)
      try {
        dispose()
      } catch {
        // Already gone.
      }
    }
    for (const [name, spec] of wanted) {
      if (this.directDisposers.has(name)) continue
      if (!spec.hidden) this.activated.add(name)
      const dispose = this.ctx.tools.register(directToolDefinition(
        spec.tool,
        (toolName, args, exec) => this.callApproved(toolName, args, exec),
        () => this.activated.has(name),
        () => this.appendStructuredContent(spec.tool.server),
      ))
      this.directDisposers.set(name, dispose)
    }
    this.applyVisibility()
  }

  /**
   * Whether one server's `structuredContent` should be shown alongside its `content`.
   *
   * Read live from the pool rather than captured at registration, because a config edit re-syncs the
   * entry while the tool definition stays registered.
   */
  appendStructuredContent(server: string): boolean {
    return this.pool.get(server)?.config.appendStructuredContent !== false
  }

  /** Hide search-activated direct tools that no search has matched yet. */
  applyVisibility(): void {    const hidden = [...this.directDisposers.keys()].filter((name) => !this.activated.has(name))
    if (hidden.length === 0) return
    try {
      this.ctx.tools.restrict({ deny: hidden })
    } catch {
      // A scoped tool cannot be masked; the tool's own active check still refuses execution.
    }
  }

  /** Activate direct tools a search matched. Additive: nothing is ever deactivated here. */
  activateMatches(query: string): string[] {
    const page = searchTools(this.catalog, query, { limit: 50, includeSchemas: false })
    const added: string[] = []
    for (const item of page.items) {
      if (!this.directDisposers.has(item.name) || this.activated.has(item.name)) continue
      this.activated.add(item.name)
      added.push(item.name)
    }
    if (added.length > 0) this.applyVisibility()
    return added
  }

  /** Approve a project server and pick it up without restarting the session. */
  approve(serverName: string): string {
    const cwd = this.agent?.session?.header?.cwd ?? process.cwd()
    const loaded = loadConfig({ cwd, dshHome: this.settings.dshHome, servers: this.settings.servers, configFiles: this.settings.configFiles })
    const entry = loaded.servers.get(serverName)
    if (entry === undefined) throw new Error(`no MCP server named "${serverName}"`)
    if (entry.origin !== 'project') throw new Error(`"${serverName}" comes from ${entry.origin}, so it needs no approval`)
    // A disabled entry has no definition to hash. The source handed it to `definitionHash` anyway,
    // which hashed an empty http triple and recorded a record that `partition` then ignores.
    if (isDisabledEntry(entry.config)) throw new Error(`"${serverName}" is disabled in its config, so it needs no approval`)
    approve(approvalsPath(loaded.home), loaded.projectRoot, serverName, entry.config)
    return definitionHash(entry.config)
  }

  /** Start the idle sweep. One timer per session; unref'd so it never holds the process open. */
  startIdleSweep(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      this.pool.sweepIdle(this.settings).catch((error) => this.logger.debug?.(`mcp-adapter: idle sweep failed: ${messageOf(error)}`))
    }, IDLE_SWEEP_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** True when a config file changed since the last sync. */
  configChanged(): boolean {
    const cwd = this.agent?.session?.header?.cwd ?? process.cwd()
    const loaded = loadConfig({
      cwd,
      dshHome: this.settings.dshHome,
      servers: this.settings.servers,
      configFiles: this.settings.configFiles,
      // The Loader entry is the base layer; a project's own `settings` file overrides it inside
      // loadConfig. Every adapter policy belongs here, or it silently reverts to the default.
      settings: pickPolicySettings(this.settings),
    })
    return signature(loaded.paths, this.stat) !== this.configSignature
  }

  /** One line per mounted/blocked server, for the model's context. */
  summary(): string {
    const lines: string[] = []
    const mounted = this.pool.names()
    if (mounted.length > 0) lines.push(`MCP servers available: ${mounted.join(', ')} — reach their tools with the mcp tool.`)
    if (this.blocked.length > 0) lines.push(`MCP servers blocked by project trust: ${this.blocked.map((entry) => entry.name).join(', ')} — run /mcp-adapter approve <name>.`)
    if (this.errors.length > 0) lines.push(`MCP config problems: ${this.errors.join('; ')}.`)
    return lines.join('\n')
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.promptDisposers !== undefined) {
      for (const [, dispose] of this.promptDisposers) {
        try {
          dispose()
        } catch {
          // Best effort at teardown.
        }
      }
      this.promptDisposers.clear()
    }
    for (const [, dispose] of this.directDisposers) {
      try {
        dispose()
      } catch {
        // Best effort at teardown.
      }
    }
    this.directDisposers.clear()
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Best effort at teardown.
      }
    }
    await this.pool.closeAll()
  }
}
