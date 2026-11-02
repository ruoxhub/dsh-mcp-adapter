/**
 * dsh-mcp-adapter — pi-mcp-adapter's behavior, written against DeepSeek Harness.
 *
 * Why this plugin exists at all: dsh's profile decides which MCP servers exist, and that profile
 * path is fixed by the program (`$DSH_HOME/profiles/<name>`), so a repository cannot declare its
 * own MCP servers. Its shipped MCP bridge also starts every configured server for the life of the
 * session, and puts every tool definition in context.
 *
 * What this does instead, per Agent:
 *   - reads `.mcp.json` / `$DSH_HOME/mcp-adapter/mcp.json` for that session's project;
 *   - keeps every server stopped until a tool call needs it, and stops it again after it idles;
 *   - puts one `mcp` proxy tool in context instead of hundreds, backed by a cached catalog;
 *   - holds a project server until that exact definition was approved, because a cloned repository
 *     is not a trust boundary.
 *
 * @module dsh-mcp-adapter
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { approveToolDefinition } from './approve.ts'
import { DEFAULT_SETTINGS, resolveDshHome } from './config.ts'
import { getKnownPreset, listKnownPresets } from './presets.ts'
import { mcpAdapterProjection, publishCurrent, recordWriter } from './projection.ts'
import { createMcpRouter, createMcpWebRoutes, ROUTES } from './routes.ts'
import { McpServersService } from './service.ts'
import { McpSession } from './session.ts'
import type { McpSessionSettings } from './session.ts'
import { approveProjectServer } from './status.ts'

export const name = 'mcp-adapter'

// dsh mounts a plugin here; every service it touches must be named here or cordis refuses the
// property read. `workingDirectory` is optional in a composition, so it is reached through
// `ctx.get` instead. `sessionProjections` is deliberately absent: the Web panel's read path is
// optional, and a composition without the projection registry must not lose the `mcp` tool.
export const inject = ['systemPrompt', 'commands', 'tools', 'webServer']

export const REARM_DEBOUNCE_MS = 2_000

/** The DSH workspace registry as this plugin reads it: `list()` yields every registered row. */
interface WorkspaceRegistrySurface {
  list?: () => Array<{ path?: unknown; title?: unknown }>
}

/**
 * Every registered workspace as a panel option.
 *
 * The registry is the authority for which folders exist; session cwds are not evidence, because
 * deleting a workspace keeps its folder and session logs. A composition without a registry (or a
 * throwing one) degrades to no options, leaving the active project root as the only entry.
 */
function listRegisteredWorkspaces(registry: WorkspaceRegistrySurface | undefined): Array<{ path: string; title: string }> {
  try {
    const items = registry?.list?.()
    if (!Array.isArray(items)) return []
    return items
      .filter((item): item is { path: string; title?: unknown } => typeof item?.path === 'string' && item.path.trim() !== '')
      .map((item) => ({
        path: item.path,
        title: typeof item.title === 'string' ? item.title : '',
      }))
  } catch {
    return []
  }
}

/**
 * The validated Loader entry: `AdapterSettings` plus the fields only the entry carries.
 *
 * `McpSessionSettings` is the session's own view of exactly those fields, so the entry reuses it
 * instead of restating `dshHome` / `servers` / `configFiles`, and adds the one key the source
 * returned but no consumer reads past the early return.
 */
export interface AdapterConfig extends McpSessionSettings {
  enabled: boolean
}

/** An object-shaped value, arrays included. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `error?.message ?? error`, without reading a property off a primitive. */
function messageOf(error: unknown): string {
  if (isRecord(error) && error.message !== undefined && error.message !== null) return String(error.message)
  return String(error)
}

/**
 * A `projectServers` value that is not one of the three literals: say so, then fail closed.
 *
 * Failing closed to `ask` is the point. Widening a typo to the `allow` default would turn a
 * misspelt "permit" into "run this repository's servers", which is exactly the decision the user
 * meant to make explicitly.
 */
function warnUnknownProjectServers(value: unknown): 'ask' {
  console.warn(`[dsh-mcp-adapter] projectServers: ${JSON.stringify(value)} is not one of ask | allow | deny — using ask`)
  return 'ask'
}

/** Validate the Loader entry. The adapter's own settings file is read separately, per project. */
export function sanitizeConfig(config: Record<string, unknown> = {}): AdapterConfig {
  const idleTimeout = config.idleTimeout
  const projectServers = config.projectServers
  return {
    enabled: config.enabled !== false,
    dshHome: typeof config.dshHome === 'string' && config.dshHome.trim().length > 0 ? config.dshHome : resolveDshHome(),
    // Inline servers, highest precedence — the same shape as a `.mcp.json` `mcpServers` entry.
    servers: isRecord(config.servers) ? config.servers : {},
    // Extra config files, highest precedence last. Absolute, or relative to the session directory.
    configFiles: Array.isArray(config.configFiles) ? config.configFiles : [],
    // Optional defaults, overridden by each project's own `settings`.
    idleTimeout: typeof idleTimeout === 'number' && Number.isFinite(idleTimeout) ? idleTimeout : 10,
    // The Loader entry has no timeout key: a request timeout is a per-server setting, and
    // `pickPolicySettings` never forwards this one. The field is declared because a live session
    // carries the full settings layer, so the entry states the default `loadConfig` would apply —
    // inert either way, exactly as the source's omission left it.
    requestTimeoutMs: DEFAULT_SETTINGS.requestTimeoutMs,
    // Unset takes the default; a value that is not one of the three literals is a typo at a trust
    // boundary, so it fails closed to `ask` instead of silently widening to the `allow` default.
    projectServers: projectServers === undefined
      ? DEFAULT_SETTINGS.projectServers
      : projectServers === 'ask' || projectServers === 'allow' || projectServers === 'deny'
        ? projectServers
        : warnUnknownProjectServers(projectServers),
    directTools: config.directTools === true || config.directTools === 'search' ? config.directTools : false,
    // Approval policy: true, "destructive", or a list of tool names.
    approveTools: config.approveTools === true || config.approveTools === 'destructive' || Array.isArray(config.approveTools)
      ? config.approveTools
      : false,
    // Adopt other agents' global MCP files: false, true, or a host list.
    importHosts: config.importHosts === true || Array.isArray(config.importHosts) ? config.importHosts : false,
    exposeResources: config.exposeResources !== false,
    toolPrefix: typeof config.toolPrefix === 'string' ? config.toolPrefix : '',
    maxOutputChars: typeof config.maxOutputChars === 'number' && Number.isFinite(config.maxOutputChars) && config.maxOutputChars > 0
      ? config.maxOutputChars
      : DEFAULT_SETTINGS.maxOutputChars,
  }
}

export function apply(ctx: Context, rawConfig?: Record<string, unknown>): void {
  const settings = sanitizeConfig(rawConfig)
  if (!settings.enabled) return

  /** agent -> McpSession */
  const sessions = new WeakMap<Agent, McpSession>()
  const activeAgents = new Set<Agent>()
  const rearmTimers = new WeakMap<Agent, ReturnType<typeof setTimeout>>()
  // `ctx.get(name)` defaults to required and throws when the service is absent. Both of these
  // are optional in some compositions, so both are read with `required = false`.
  const projections = ctx.get?.('sessionProjections', false)

  /** Push one Agent's status to the Web panel. Optional everywhere: no registry, no panel data. */
  async function publish(agent: Agent): Promise<void> {
    if (projections === undefined) return
    const session = sessions.get(agent)
    if (session === undefined) return
    // The marker is an ignorable plugin record, so a failed write costs the panel its data and
    // nothing else: `recordWriter` already reports false instead of throwing.
    const commit = await recordWriter(agent.session)
    // Flush so a browser attached to another Host generation replays the marker from the log; the
    // in-process case is served by the projection control stream either way.
    const sessionsService = ctx.get?.('sessions', false)
    await publishCurrent(
      agent.session,
      session,
      sessionsService === undefined ? async () => {} : (live: typeof agent.session) => sessionsService.flush(live),
      commit,
    )
  }

  // The panel's workspace list is the DSH workspace registry, read the same way skill-manager
  // does: non-strict, because a headless composition has no registry and must still mount.
  const registry = ctx.get('workspaceRegistry', false) as WorkspaceRegistrySurface | undefined
  const service = new McpServersService({
    dshHome: settings.dshHome,
    projectServers: settings.projectServers,
    workspaces: () => listRegisteredWorkspaces(registry),
    onEvictServer: async (name: string) => {
      for (const agent of activeAgents) {
        const session = sessions.get(agent)
        if (session) {
          try {
            await session.pool.remove(name)
          } catch {
            // ignore removal errors
          }
          session.catalogStale = true
          await publish(agent)
        }
      }
    },
  })
  // `ctx.webServer` is declared in `inject`, so it is safe to read; `ctx.router` is NOT a DSH
  // service at all, and reading an undeclared property on the Cordis proxy throws instead of
  // returning undefined. Every optional service is therefore reached through `ctx.get(name, false)`.
  const webServer = ctx.get('webServer', false)
  if (webServer?.register) {
    const webRoutes = createMcpWebRoutes(service)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const disposers = webRoutes.map((r) => webServer.register(r))
        return () => { disposers.forEach((d) => typeof d === 'function' && d()) }
      }, 'mcp-adapter:web-routes')
    } else {
      webRoutes.forEach((r) => webServer.register(r))
    }
  }
  // DSH has no `router` service; the REST surface is served by the `webServer` routes above.
  // `ctx.get('router', false)` never throws, so an absent service simply skips this branch.
  const router = ctx.get('router', false)
  if (router?.get && router?.post) {
    createMcpRouter(router, service)
  }

  async function arm(agent: Agent): Promise<McpSession> {
    activeAgents.add(agent)
    const existing = sessions.get(agent)
    if (existing !== undefined) return existing
    const session = new McpSession({
      ctx: agent.ctx,
      agent,
      settings,
      logger: ctx.logger,
      stat: statSync,
      // A tool call starts the server it needs, so the panel's snapshot has to be refreshed then.
      onStatus: () => { void publish(agent) },
    })
    sessions.set(agent, session)
    session.startIdleSweep()
    try {
      await session.sync()
      session.registerTools()
      registerApproveTool(agent, session)
    } catch (error) {
      ctx.logger.warn(`mcp-adapter: session setup failed: ${messageOf(error)}`)
      return session
    }
    // Cold start: a server that has no cached catalog must be asked for one, because search, the
    // status line, and direct tools are all built from it. Not awaited — a slow server must not
    // hold up the Agent's first step.
    session.refreshCatalog()
      .then(() => publish(agent))
      .catch((error: unknown) => {
        ctx.logger.warn(`mcp-adapter: catalog refresh failed: ${messageOf(error)}`)
      })
    // `eager` and `keep-alive` servers are supposed to be up before anything asks. Also unawaited,
    // for the same reason: an unreachable keep-alive server must not delay the first step.
    session.warmEager()
      .then(() => publish(agent))
      .catch((error: unknown) => {
        ctx.logger.warn(`mcp-adapter: eager start failed: ${messageOf(error)}`)
      })
    return session
  }

  /**
   * The Web panel approves a project server by asking for it in the conversation, because a Client
   * package outside the shipped Remote assembly has no callable namespace. Registering the tool on
   * the Agent is what makes that one message enough.
   */
  function registerApproveTool(agent: Agent, session: McpSession): void {
    const tool = approveToolDefinition(
      () => session,
      () => rearm(agent),
      () => publish(agent),
    )
    try {
      ctx.effect(() => agent.ctx.tools.register(tool), 'mcp-adapter:approve-tool')
    } catch {
      // An Agent scope that refuses the registration keeps `/mcp-adapter approve` working.
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    await arm(agent)
  })

  /** Approving changes which servers mount; the Agent's runtime is rebuilt the same way `/reload` does it. */
  async function rearm(agent: Agent): Promise<void> {
    const session = sessions.get(agent)
    if (session === undefined) return
    await session.dispose()
    sessions.delete(agent)
    await arm(agent)
  }

  // The Web panel reads the `mcpAdapter` projection. Without the registry the panel says so and the
  // command and tool surfaces are unaffected, so this never blocks activation.
  if (projections !== undefined) {
    try {
      projections.register(mcpAdapterProjection)
    } catch (error) {
      ctx.logger.warn(`mcp-adapter: Web panel projection unavailable: ${messageOf(error)}`)
    }
  } else {
    ctx.logger.info('mcp-adapter: no sessionProjections service, so the Web panel has no data source')
  }

  ctx.on('agent/disposed', async ({ agent }) => {
    activeAgents.delete(agent)
    const session = sessions.get(agent)
    if (session === undefined) return
    sessions.delete(agent)
    const timer = rearmTimers.get(agent)
    if (timer !== undefined) clearTimeout(timer)
    await session.dispose()
  })

  // A config edit made mid-session lands on the next step, never on the one being assembled.
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload.agent
    const session = sessions.get(agent)
    if (session !== undefined && !rearmTimers.has(agent) && session.configChanged()) {
      const timer = setTimeout(async () => {
        rearmTimers.delete(agent)
        await session.dispose()
        sessions.delete(agent)
        await arm(agent)
        await publish(agent)
      }, REARM_DEBOUNCE_MS)
      timer.unref?.()
      rearmTimers.set(agent, timer)
    }
    return next()
  })

  ctx.systemPrompt.context({
    name: 'mcp-adapter:servers',
    // `getContextOrder` is absent in some compositions; the adapter must not fail to load over it.
    order: ctx.systemPrompt.getContextOrder?.('HARNESS_SOURCE') ?? 900,
    interpolate: false,
    text: (context) => {
      const agent = context.agent
      const session = agent === undefined ? undefined : sessions.get(agent)
      return session?.summary() ?? ''
    },
  })

  ctx.commands.register({
    name: 'mcp-adapter',
    description: 'dsh-mcp-adapter: MCP server status, project-server approval, catalog refresh, presets',
    input: { hint: 'status | approve <server> | reload | tools | presets | add <presetId>' },
    // Every branch returns a `CommandResult`: `CommandRuntime.execute` throws a TypeError for
    // anything else, so a bare string here would fail the command at the UI boundary, not in tests.
    handler: async (invocation): Promise<CommandResult> => {
      const agent = invocation.agent
      const session = sessions.get(agent)
      if (session === undefined) return { kind: 'success', text: 'MCP is not initialized for this session yet — send a message first.' }
      const [verb = 'status', target] = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean)

      if (verb === 'approve') {
        if (target === undefined) return { kind: 'error', text: 'usage: /mcp-adapter approve <server>' }
        const projectRoot = session.projectRoot
        const result = approveProjectServer(session, target)
        if (!result.ok) return { kind: 'error', text: result.error }
        await rearm(agent)
        return { kind: 'success', text: `Approved "${target}" for ${projectRoot}.` }
      }

      if (verb === 'presets') {
        const presets = listKnownPresets()
        const lines = ['Available MCP server presets:']
        for (const preset of presets) {
          lines.push(`- ${preset.id} (${preset.name}): ${preset.summary}`)
        }
        lines.push('', 'Run `/mcp-adapter add <presetId>` to add one to this project.')
        return { kind: 'success', text: lines.join('\n') }
      }

      if (verb === 'add') {
        if (!target) return { kind: 'error', text: 'usage: /mcp-adapter add <presetId>' }
        const preset = getKnownPreset(target)
        if (!preset) return { kind: 'error', text: `Unknown preset "${target}". Run /mcp-adapter presets to view available presets.` }
        const service = new McpServersService({ dshHome: settings.dshHome, projectServers: settings.projectServers })
        try {
          await service.installPreset({
            presetId: target,
            scope: 'workspace',
            cwd: session.projectRoot,
          })
          await rearm(agent)
          return { kind: 'success', text: `Added preset "${preset.name}" to ${session.projectRoot}/.mcp.json and approved.` }
        } catch (err: unknown) {
          return { kind: 'error', text: `Failed to add preset: ${err instanceof Error ? err.message : String(err)}` }
        }
      }

      if (verb === 'reload') {
        await rearm(agent)
        return { kind: 'success', text: 'MCP configuration reloaded.' }
      }

      if (verb === 'tools') {
        await session.refreshCatalog()
        const names = [...session.catalog.tools.keys()].sort()
        return { kind: 'success', text: names.length === 0 ? 'No MCP tools available.' : names.join('\n') }
      }

      const lines = [`project root: ${session.projectRoot}`]
      for (const status of session.pool.status()) {
        const count = [...session.catalog.tools.values()].filter((tool) => tool.server === status.name).length
        lines.push(`${status.name}: ${status.state}, ${count} tool(s)${status.lastError ? ` — ${status.lastError}` : ''}`)
      }
      for (const blocked of session.blocked) lines.push(`${blocked.name}: blocked — ${blocked.reason}`)
      for (const problem of session.errors) lines.push(`problem: ${problem}`)
      if (session.pool.names().length === 0 && session.blocked.length === 0) {
        lines.push(`no MCP servers found — add one to ${join(settings.dshHome, 'mcp-adapter', 'mcp.json')} or this project's .mcp.json`)
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}

export { createMcpRouter, createMcpWebRoutes, ROUTES } from './routes.ts'
export { McpServersService } from './service.ts'
