// Backend persistence service and probe for MCP servers across user and workspace scopes.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import {
  adapterHome,
  DEFAULT_SETTINGS,
  isDisabledEntry,
  normalizeEntry,
  parseJsonText,
  resolveDshHome,
  resolveProjectRoot,
  SERVER_NAME_PATTERN,
} from './config.ts'
import { getKnownPreset, type KnownServerPreset, listKnownPresets, listCatalogEntries } from './presets.ts'
import { cachePath, purgeCacheEntry } from './cache.ts'
import { ServerPool } from './servers.ts'
import { scanExternalMcp } from './imports.ts'
import { approvalsPath, approve, isApproved, removeApproval } from './trust.ts'
import type {
  ExternalMcpCandidate,
  ExternalMcpScanResult,
  McpCatalogEntry,
  McpServerDetail,
  ProbeResult,
  Scope,
} from './types.ts'

export type {
  ExternalMcpCandidate,
  ExternalMcpScanResult,
  KnownServerPreset,
  McpCatalogEntry,
  McpServerDetail,
  ProbeResult,
  Scope,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `error?.message ?? error`, without reading a property off a primitive. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null
  const parsed = parseJsonText(readFileSync(filePath, 'utf8'), filePath)
  if (!isRecord(parsed)) throw new Error(`${filePath}: root must be a JSON object`)
  return parsed
}

function safeWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const content = `${JSON.stringify(data, null, 2)}\n`
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(tmpPath, content, 'utf8')
    renameSync(tmpPath, filePath)
  } catch {
    writeFileSync(filePath, content, 'utf8')
  } finally {
    if (existsSync(tmpPath)) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // Ignore temporary cleanup errors
      }
    }
  }
}

/** Check if an executable exists on the system without spawning it. */
export function findExecutable(command: string, cwd?: string): string | null {
  if (!command || typeof command !== 'string') return null
  const isWindows = process.platform === 'win32'
  const pathext = isWindows
    ? (process.env.PATHEXT ? process.env.PATHEXT.split(';') : ['.COM', '.EXE', '.BAT', '.CMD'])
    : ['']

  // If command includes path separators, inspect the exact location
  if (command.includes('/') || command.includes('\\')) {
    const target = cwd ? resolve(cwd, command) : resolve(command)
    if (existsSync(target)) return target
    if (isWindows) {
      for (const ext of pathext) {
        const candidate = `${target}${ext.toLowerCase()}`
        if (existsSync(candidate)) return candidate
        const candidateUpper = `${target}${ext.toUpperCase()}`
        if (existsSync(candidateUpper)) return candidateUpper
      }
    }
    return null
  }

  // Otherwise search PATH directories
  const pathEnv = process.env.PATH || ''
  const delimiter = isWindows ? ';' : ':'
  const dirs = pathEnv.split(delimiter).filter(Boolean)

  for (const dir of dirs) {
    if (isWindows) {
      const alreadyHasExt = pathext.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()))
      if (alreadyHasExt) {
        const full = join(dir, command)
        if (existsSync(full)) return full
      }
      for (const ext of pathext) {
        const candidate = join(dir, `${command}${ext.toLowerCase()}`)
        if (existsSync(candidate)) return candidate
        const candidateUpper = join(dir, `${command}${ext.toUpperCase()}`)
        if (existsSync(candidateUpper)) return candidateUpper
      }
    } else {
      const full = join(dir, command)
      if (existsSync(full)) return full
    }
  }
  return null
}

/** Infer category from server name and definition keywords. */
export function inferCategory(name: string, raw: Record<string, unknown>): string {
  if (typeof raw.category === 'string' && raw.category.trim()) {
    return raw.category.trim()
  }
  const text = `${name} ${raw.command ?? ''} ${raw.description ?? ''}`.toLowerCase()
  if (/(browser|puppeteer|playwright|chrome|web)/.test(text)) return 'browser'
  if (/(system|desktop|os|terminal|bash|shell|computer|sys)/.test(text)) return 'system'
  if (/(doc|pdf|office|markdown|notion|file)/.test(text)) return 'document'
  if (/(database|sql|postgres|sqlite|redis|storage|memory|data)/.test(text)) return 'database'
  return 'custom'
}

function toServerDetail(
  name: string,
  scope: Scope,
  raw: Record<string, unknown>,
  ctx: { dshHome: string; projectRoot: string; projectServers: 'ask' | 'allow' | 'deny' },
): McpServerDetail {
  const category = inferCategory(name, raw)
  const isHttp = Boolean(raw.url ?? raw.serverUrl ?? raw.httpUrl)
  const isSocket = Boolean(raw.socket)
  const transport: 'stdio' | 'http' | 'socket' = isHttp ? 'http' : isSocket ? 'socket' : 'stdio'

  let status: 'ready' | 'starting' | 'error' | 'blocked' | 'idle' = 'ready'
  if (raw.disabled === true || raw.enabled === false) {
    status = 'idle'
  } else if (scope === 'workspace') {
    try {
      const normalized = normalizeEntry(name, raw)
      if (!isDisabledEntry(normalized)) {
        // The row reports the gate the session actually applies, so `allow` has to be consulted
        // here too: reading the approval record alone would label a server "blocked" while the
        // session mounts and runs it.
        if (ctx.projectServers === 'allow') {
          status = 'ready'
        } else if (ctx.projectServers === 'deny') {
          status = 'blocked'
        } else {
          const appPath = approvalsPath(adapterHome(ctx.dshHome))
          const approved = isApproved(appPath, ctx.projectRoot, name, normalized)
          status = approved ? 'ready' : 'blocked'
        }
      }
    } catch {
      status = 'error'
    }
  } else {
    try {
      normalizeEntry(name, raw)
    } catch {
      status = 'error'
    }
  }

  const rawUrl = raw.url ?? raw.serverUrl ?? raw.httpUrl
  const headers = isRecord(raw.headers)
    ? Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, String(v)]))
    : undefined
  const command = Array.isArray(raw.command)
    ? String(raw.command[0])
    : typeof raw.command === 'string'
      ? raw.command
      : undefined

  const args = Array.isArray(raw.command)
    ? raw.command.slice(1).map(String)
    : Array.isArray(raw.args)
      ? raw.args.map(String)
      : undefined

  const env = isRecord(raw.env)
    ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]))
    : undefined

  return {
    name,
    scope,
    category,
    transport,
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(rawUrl !== undefined ? { url: String(rawUrl) } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    ...(typeof raw.timeoutMs === 'number'
      ? { timeoutMs: raw.timeoutMs }
      : typeof raw.requestTimeoutMs === 'number'
        ? { timeoutMs: raw.requestTimeoutMs }
        : {}),
    ...(typeof raw.protocolVersion === 'string' ? { protocolVersion: raw.protocolVersion } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    status,
    raw: { ...raw },
  }
}

/** One workspace the panel can manage; `path` is the project root holding `.mcp.json`. */
export interface WorkspaceOption {
  path: string
  title: string
}

/** A refusal the web route reports as its own status instead of a 500. */
function badRequest(message: string): Error {
  const error = new Error(message) as Error & { statusCode?: number }
  error.statusCode = 400
  return error
}

export interface McpServersServiceOptions {
  dshHome?: string
  /**
   * The `projectServers` gate the session applies, so a workspace row reports the same verdict the
   * session reached. Defaulted to the adapter's own default: a panel that guessed a different gate
   * than the session applied is exactly the "blocked but actually running" lie this field prevents.
   */
  projectServers?: 'ask' | 'allow' | 'deny'
  /**
   * Every workspace the host knows (the DSH workspace registry). Optional: a composition without
   * one still gets the active project root as the only entry.
   */
  workspaces?: () => WorkspaceOption[]
  /**
   * Optional eviction hook to close/evict running connections from active pools.
   *
   * `projectRoot` says which pools the write concerned: absent for a user-global write (the
   * definition is shared by every workspace, so every pool must drop it), and the workspace root
   * for a workspace write (another workspace's pool may run a same-named server of its own, and
   * dropping that one would kill a connection nothing touched).
   */
  onEvictServer?: (name: string, projectRoot?: string) => Promise<void> | void
}

export class McpServersService {
  private readonly dshHome: string
  private readonly projectServers: 'ask' | 'allow' | 'deny'
  private readonly registeredWorkspaces?: () => WorkspaceOption[]
  private readonly onEvictServer?: (name: string, projectRoot?: string) => Promise<void> | void

  constructor(options?: McpServersServiceOptions) {
    this.dshHome = options?.dshHome ?? resolveDshHome()
    this.projectServers = options?.projectServers ?? DEFAULT_SETTINGS.projectServers
    this.registeredWorkspaces = options?.workspaces
    this.onEvictServer = options?.onEvictServer
  }

  /**
   * Resolve the workspace a panel request names.
   *
   * The panel's `cwd` arrives from the browser, so it cannot be trusted to be *the* project; but a
   * session may legitimately live outside every registered workspace (DSH creates sessions from a
   * bare `cwd` too), so this refuses only the two things it can name definitively:
   *
   * 1. A directory inside a registered workspace resolves to that registered path, not to a `.git`
   *    ancestor. The registry is what DSH treated as the project, and a subdirectory of a
   *    repository is its own workspace there.
   * 2. Anything else keeps the old `findProjectRoot` resolution.
   *
   * No directory at all resolves to `''`: the caller then reads user-global config only, instead of
   * silently adopting the harness process' own launch directory.
   * @param cwd - the request's directory, if it named one.
   * @returns the project root, or `''` when the request named no directory.
   */
  resolveTarget(cwd: string | undefined): string {
    if (cwd === undefined || cwd.trim() === '') return ''
    return resolveProjectRoot(cwd.trim(), this.registered().map((item) => item.path))
  }

  /** The registry's entries, or none when the registry is absent or throws. */
  private registered(): WorkspaceOption[] {
    try {
      return (this.registeredWorkspaces?.() ?? []).filter(
        (item): item is WorkspaceOption => typeof item?.path === 'string' && item.path.trim() !== '',
      )
    } catch {
      // An unavailable registry leaves the active root as the only known workspace.
      return []
    }
  }

  /**
   * Every registered workspace in registry order, plus the active root when the registry does not
   * know it.
   *
   * The order must not depend on the active root: a menu that reshuffles every time the user picks
   * a different workspace makes the next pick unreliable. The active root is therefore appended
   * only when absent, never promoted.
   */
  private resolveWorkspaces(activeRoot: string): WorkspaceOption[] {
    const registered = this.registered()
    const out: WorkspaceOption[] = []
    const add = (path: string, title: unknown): void => {
      if (path === '') return
      const resolved = resolve(path)
      if (out.some((item) => resolve(item.path) === resolved)) return
      out.push({
        path: resolved,
        title: typeof title === 'string' && title.trim() !== '' ? title.trim() : basename(resolved) || resolved,
      })
    }
    for (const item of registered) add(item.path, item.title)
    add(activeRoot, registered.find((item) => resolve(item.path) === resolve(activeRoot))?.title ?? basename(activeRoot))
    return out
  }

  /**
   * List servers across user and/or workspace scopes.
   */
  async listServers(options: { cwd?: string; scope?: Scope } = {}): Promise<{
    servers: McpServerDetail[]
    workspaceRoot: string
    workspaces: WorkspaceOption[]
  }> {
    const workspaceRoot = this.resolveTarget(options.cwd)
    const workspaces = this.resolveWorkspaces(workspaceRoot)
    const servers: McpServerDetail[] = []

    // User scope
    if (options.scope !== 'workspace') {
      const userPath = join(this.dshHome, 'mcp-adapter', 'mcp.json')
      const userJson = safeReadJson(userPath)
      const rawServers = userJson?.mcpServers ?? userJson?.servers
      if (isRecord(rawServers)) {
        for (const [name, raw] of Object.entries(rawServers)) {
          if (!isRecord(raw)) continue
          servers.push(toServerDetail(name, 'user', raw, { dshHome: this.dshHome, projectRoot: workspaceRoot, projectServers: this.projectServers }))
        }
      }
    }

    // Workspace scope. With no resolved workspace there is no project file to read; a relative
    // `.mcp.json` would resolve against the harness process' own directory.
    if (options.scope !== 'user' && workspaceRoot !== '') {
      const wsPath = join(workspaceRoot, '.mcp.json')
      const wsJson = safeReadJson(wsPath)
      const rawServers = wsJson?.mcpServers ?? wsJson?.servers
      if (isRecord(rawServers)) {
        for (const [name, raw] of Object.entries(rawServers)) {
          if (!isRecord(raw)) continue
          servers.push(toServerDetail(name, 'workspace', raw, { dshHome: this.dshHome, projectRoot: workspaceRoot, projectServers: this.projectServers }))
        }
      }
    }

    return { servers, workspaceRoot, workspaces }
  }

  /**
   * Save or update an MCP server in the target scope.
   */
  async saveServer(options: {
    scope: Scope
    cwd?: string
    name: string
    originalName?: string
    originalScope?: Scope
    server: Record<string, unknown>
  }): Promise<{ ok: boolean }> {
    if (!SERVER_NAME_PATTERN.test(options.name)) {
      throw new Error(`Invalid server name: "${options.name}". Name must match ${SERVER_NAME_PATTERN}`)
    }

    // Both ends of a scope change live in the same workspace file, so either end needs the root.
    const touchesWorkspace = options.scope === 'workspace' || options.originalScope === 'workspace'
    const workspaceRoot = this.workspaceRootFor(options.cwd, touchesWorkspace)
    const targetPath = options.scope === 'user'
      ? join(this.dshHome, 'mcp-adapter', 'mcp.json')
      : join(workspaceRoot, '.mcp.json')

    const prevName = options.originalName?.trim() || options.name
    const prevScope = options.originalScope || options.scope
    const isRename = prevName !== options.name
    const isScopeChange = prevScope !== options.scope

    if (isScopeChange) {
      // 1. Write to target scope
      const data = safeReadJson(targetPath) ?? {}
      if (!isRecord(data.mcpServers)) {
        data.mcpServers = {}
      }
      ;(data.mcpServers as Record<string, unknown>)[options.name] = options.server
      safeWriteJson(targetPath, data)

      // 2. Remove old entry from old scope
      const oldTargetPath = prevScope === 'user'
        ? join(this.dshHome, 'mcp-adapter', 'mcp.json')
        : join(workspaceRoot, '.mcp.json')
      const oldData = safeReadJson(oldTargetPath)
      if (oldData) {
        let changed = false
        if (isRecord(oldData.mcpServers) && prevName in oldData.mcpServers) {
          delete (oldData.mcpServers as Record<string, unknown>)[prevName]
          changed = true
        }
        if (isRecord(oldData.servers) && prevName in oldData.servers) {
          delete (oldData.servers as Record<string, unknown>)[prevName]
          changed = true
        }
        if (changed) {
          safeWriteJson(oldTargetPath, oldData)
        }
      }

      if (prevScope === 'workspace') {
        removeApproval(approvalsPath(adapterHome(this.dshHome)), workspaceRoot, prevName)
      }
    } else {
      // Same scope
      const data = safeReadJson(targetPath) ?? {}
      if (!isRecord(data.mcpServers)) {
        data.mcpServers = {}
      }
      if (isRename) {
        if (prevName in (data.mcpServers as Record<string, unknown>)) {
          delete (data.mcpServers as Record<string, unknown>)[prevName]
        }
        if (isRecord(data.servers) && prevName in (data.servers as Record<string, unknown>)) {
          delete (data.servers as Record<string, unknown>)[prevName]
        }
        if (options.scope === 'workspace') {
          removeApproval(approvalsPath(adapterHome(this.dshHome)), workspaceRoot, prevName)
        }
      }
      ;(data.mcpServers as Record<string, unknown>)[options.name] = options.server
      safeWriteJson(targetPath, data)
    }

    // User explicit save of workspace server counts as user trust -> auto-approve
    if (options.scope === 'workspace') {
      try {
        const normalized = normalizeEntry(options.name, options.server)
        if (!isDisabledEntry(normalized)) {
          approve(approvalsPath(adapterHome(this.dshHome)), workspaceRoot, options.name, normalized)
        }
      } catch {
        // If entry fails validation, saving succeeds; approval fails gracefully
      }
    }

    // A workspace write only concerns that workspace's pools; a user-global write concerns all.
    const evictScope = touchesWorkspace ? workspaceRoot : undefined

    // Evict old identity from cache & pool if renamed or moved
    if (isRename || isScopeChange) {
      purgeCacheEntry(cachePath(adapterHome(this.dshHome)), prevName)
      try {
        await this.onEvictServer?.(prevName, evictScope)
      } catch {
        // Eviction errors do not fail the save
      }
    }

    // Invalidate new server cache & running connection so changes take effect immediately
    purgeCacheEntry(cachePath(adapterHome(this.dshHome)), options.name)
    try {
      await this.onEvictServer?.(options.name, evictScope)
    } catch {
      // Eviction errors do not fail the save
    }

    return { ok: true }
  }

  /**
   * The project root a workspace-scoped operation writes to.
   *
   * A workspace write without a directory is refused instead of being aimed at the harness process'
   * own working directory: the panel always has the session's workspace, so a request that lacks
   * one is a programming error, not a request to write somewhere real.
   * @param cwd - the request's directory, if it named one.
   * @returns the project root.
   * @throws an error with `statusCode: 400` when no workspace could be resolved.
   */
  private requireWorkspaceRoot(cwd: string | undefined): string {
    const root = this.resolveTarget(cwd)
    if (root === '') throw badRequest('Workspace scope needs the session workspace directory; the request named none')
    return root
  }

  /** The project root a save/delete/toggle needs, or `''` when the operation stays in user scope. */
  private workspaceRootFor(cwd: string | undefined, touchesWorkspace: boolean): string {
    return touchesWorkspace ? this.requireWorkspaceRoot(cwd) : ''
  }

  /**
   * Approve a project/workspace server by recording its definition hash.
   */
  async approveServer(options: { cwd?: string; name: string }): Promise<{ ok: boolean }> {
    const workspaceRoot = this.requireWorkspaceRoot(options.cwd)
    const wsPath = join(workspaceRoot, '.mcp.json')
    const wsJson = safeReadJson(wsPath)
    const rawServers = wsJson?.mcpServers ?? wsJson?.servers

    if (!isRecord(rawServers) || !rawServers[options.name]) {
      throw new Error(`Server "${options.name}" not found in workspace at ${workspaceRoot}`)
    }

    const raw = rawServers[options.name]
    const normalized = normalizeEntry(options.name, raw)
    if (isDisabledEntry(normalized)) {
      throw new Error(`Server "${options.name}" is disabled in config, so it needs no approval`)
    }

    approve(approvalsPath(adapterHome(this.dshHome)), workspaceRoot, options.name, normalized)
    return { ok: true }
  }

  /**
   * Delete an MCP server from the specified scope.
   */
  async deleteServer(options: { scope: Scope; cwd?: string; name: string }): Promise<{ ok: boolean }> {
    const workspaceRoot = this.workspaceRootFor(options.cwd, options.scope === 'workspace')
    const targetPath = options.scope === 'user'
      ? join(this.dshHome, 'mcp-adapter', 'mcp.json')
      : join(workspaceRoot, '.mcp.json')

    const data = safeReadJson(targetPath)
    if (data) {
      let changed = false
      if (isRecord(data.mcpServers) && options.name in data.mcpServers) {
        delete (data.mcpServers as Record<string, unknown>)[options.name]
        changed = true
      }
      if (isRecord(data.servers) && options.name in data.servers) {
        delete (data.servers as Record<string, unknown>)[options.name]
        changed = true
      }
      if (changed) {
        safeWriteJson(targetPath, data)
      }
    }

    if (options.scope === 'workspace') {
      removeApproval(approvalsPath(adapterHome(this.dshHome)), workspaceRoot, options.name)
    }

    // Invalidate disk cache and evict running process from ServerPool. A workspace delete drops
    // only that workspace's pools; a user-global delete drops the definition every pool shares.
    purgeCacheEntry(cachePath(adapterHome(this.dshHome)), options.name)
    try {
      await this.onEvictServer?.(options.name, options.scope === 'workspace' ? workspaceRoot : undefined)
    } catch {
      // Eviction errors do not fail the delete
    }

    return { ok: true }
  }

  /**
   * Migrate an MCP server between user (global) and workspace scopes atomically.
   */
  async migrateScope(options: {
    name: string
    fromScope: Scope
    toScope: Scope
    cwd?: string
  }): Promise<{ ok: boolean }> {
    if (options.fromScope === options.toScope) {
      return { ok: true }
    }
    const workspaceRoot = this.workspaceRootFor(options.cwd, true)

    const fromPath = options.fromScope === 'user'
      ? join(this.dshHome, 'mcp-adapter', 'mcp.json')
      : join(workspaceRoot, '.mcp.json')

    const toPath = options.toScope === 'user'
      ? join(this.dshHome, 'mcp-adapter', 'mcp.json')
      : join(workspaceRoot, '.mcp.json')

    // 1. Read source
    const fromData = safeReadJson(fromPath)
    const fromServers = fromData?.mcpServers ?? fromData?.servers
    if (!isRecord(fromServers) || !(options.name in fromServers)) {
      throw new Error(`Server "${options.name}" not found in ${options.fromScope} scope`)
    }
    const serverConfig = fromServers[options.name]

    // 2. Check destination collision
    const toData = safeReadJson(toPath) || { mcpServers: {} }
    const toServers = toData.mcpServers ?? toData.servers
    if (isRecord(toServers) && options.name in toServers) {
      const err: any = new Error(`Server "${options.name}" already exists in ${options.toScope} scope`)
      err.statusCode = 409
      throw err
    }

    // 3. Write destination
    if (!isRecord(toData.mcpServers)) {
      toData.mcpServers = {}
    }
    ;(toData.mcpServers as Record<string, unknown>)[options.name] = serverConfig
    safeWriteJson(toPath, toData)

    // 4. Delete from source
    if (fromData) {
      if (isRecord(fromData.mcpServers) && options.name in fromData.mcpServers) {
        delete (fromData.mcpServers as Record<string, unknown>)[options.name]
      }
      if (isRecord(fromData.servers) && options.name in fromData.servers) {
        delete (fromData.servers as Record<string, unknown>)[options.name]
      }
      safeWriteJson(fromPath, fromData)
    }

    // 5. Approvals housekeeping
    if (options.fromScope === 'workspace') {
      removeApproval(approvalsPath(adapterHome(this.dshHome)), workspaceRoot, options.name)
    }
    if (options.toScope === 'workspace') {
      try {
        const normalized = normalizeEntry(options.name, serverConfig)
        if (!isDisabledEntry(normalized)) {
          approve(approvalsPath(adapterHome(this.dshHome)), workspaceRoot, options.name, normalized)
        }
      } catch {
        // ignore
      }
    }

    // 6. Invalidate cache and evict running process. A migration touches the workspace file, so
    // its pools are the ones that must reconnect; the user-global end is shared and is not.
    purgeCacheEntry(cachePath(adapterHome(this.dshHome)), options.name)
    try {
      await this.onEvictServer?.(options.name, workspaceRoot)
    } catch {
      // ignore
    }

    return { ok: true }
  }

  /**
   * Probe an MCP server endpoint for reachability and latency.
   */
  /**
   * Probe an MCP server by starting it and completing the MCP handshake.
   *
   * This used to answer `ok: true` for any command that existed on PATH and any URL that returned
   * HTTP 200, so a random web page and a non-MCP binary both "passed". A probe is only worth a
   * button if it fails on things that cannot serve MCP, so it now goes through the same
   * `ServerPool` the Agent uses: spawn, initialize, tools/list, then close. That also honours an
   * entry's `headers`, `env`, `httpTransport`, `caFile` and `protocolVersion`, which a bare
   * `fetch(url)` ignored — an authenticated endpoint used to always look broken.
   */
  async probeServer(server: Record<string, unknown>): Promise<ProbeResult> {
    // A socket entry cannot be pooled (`loadConfig` refuses one), so it keeps the raw connect.
    if (typeof server.socket === 'string' && !server.url && !server.command) {
      const start = performance.now()
      return new Promise<ProbeResult>((probeResolve) => {
        const socket = net.connect(server.socket as string)
        let resolved = false
        const finish = (result: ProbeResult) => {
          if (resolved) return
          resolved = true
          socket.destroy()
          probeResolve(result)
        }
        socket.setTimeout(5000)
        socket.once('connect', () => {
          finish({ ok: true, latencyMs: Math.round(performance.now() - start) })
        })
        socket.once('error', (err) => {
          finish({ ok: false, error: err.message, latencyMs: Math.round(performance.now() - start) })
        })
        socket.once('timeout', () => {
          finish({ ok: false, error: 'Connection timed out', latencyMs: Math.round(performance.now() - start) })
        })
      })
    }

    const name = typeof server.name === 'string' && server.name.length > 0 ? server.name : 'probe'
    let config
    try {
      config = normalizeEntry(name, server)
    } catch (error: unknown) {
      return { ok: false, error: messageOf(error) }
    }
    if (isDisabledEntry(config)) {
      return { ok: false, error: 'Server is disabled' }
    }

    const pool = new ServerPool({ home: adapterHome(this.dshHome) })
    const start = performance.now()
    try {
      await pool.configure([{ config }])
      const catalog = await pool.catalog(name, { refresh: true })
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - start),
        toolCount: catalog.tools.length,
      }
    } catch (error: unknown) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        error: messageOf(error) || 'Handshake failed',
      }
    } finally {
      try {
        await pool.closeAll()
      } catch {
        // A failed close must not turn a completed probe into an error.
      }
    }
  }
  /**
   * List curated MCP server presets.
   */
  listPresets(): KnownServerPreset[] {
    return listKnownPresets()
  }

  /**
   * Install a curated preset into user or workspace scope.
   */
  async installPreset(options: {
    presetId: string
    scope: Scope
    cwd?: string
    envOverrides?: Record<string, string>
  }): Promise<{ ok: boolean; path: string; serverName: string }> {
    const preset = getKnownPreset(options.presetId)
    if (!preset) {
      throw new Error(`Unknown preset id: "${options.presetId}"`)
    }

    const serverDef = { ...preset.entry }
    if (options.envOverrides && Object.keys(options.envOverrides).length > 0) {
      const currentEnv = isRecord(serverDef.env) ? { ...serverDef.env } : {}
      serverDef.env = { ...currentEnv, ...options.envOverrides }
    }

    await this.saveServer({
      name: preset.id,
      scope: options.scope,
      cwd: options.cwd,
      server: serverDef,
    })

    const workspaceRoot = this.workspaceRootFor(options.cwd, options.scope === 'workspace')
    const targetPath = options.scope === 'user'
      ? join(this.dshHome, 'mcp-adapter', 'mcp.json')
      : join(workspaceRoot, '.mcp.json')

    return {
      ok: true,
      path: targetPath,
      serverName: preset.name,
    }
  }

  /**
   * Toggle a server between enabled and disabled in-place.
   */
  async toggleServer(options: {
    name: string
    scope: Scope
    cwd?: string
    enabled: boolean
  }): Promise<{ ok: boolean; enabled: boolean }> {
    const workspaceRoot = this.workspaceRootFor(options.cwd, options.scope === 'workspace')
    const targetPath = options.scope === 'user'
      ? join(this.dshHome, 'mcp-adapter', 'mcp.json')
      : join(workspaceRoot, '.mcp.json')

    const data = safeReadJson(targetPath)
    if (!data) {
      throw new Error(`Configuration file not found at ${targetPath}`)
    }

    const container = isRecord(data.mcpServers)
      ? data.mcpServers
      : isRecord(data.servers)
        ? data.servers
        : null

    if (!container || !isRecord(container[options.name])) {
      throw new Error(`Server "${options.name}" not found in ${options.scope} scope`)
    }

    const serverDef = container[options.name] as Record<string, unknown>
    if (options.enabled) {
      delete serverDef.disabled
      delete serverDef.enabled
    } else {
      serverDef.disabled = true
      delete serverDef.enabled
    }

    safeWriteJson(targetPath, data)

    if (!options.enabled) {
      // Evict running process from pool, scoped to the workspace the entry was switched off in.
      try {
        await this.onEvictServer?.(options.name, options.scope === 'workspace' ? workspaceRoot : undefined)
      } catch {
        // Eviction errors do not fail the toggle
      }
    } else {
      // Invalidate cache
      purgeCacheEntry(cachePath(adapterHome(this.dshHome)), options.name)
      if (options.scope === 'workspace') {
        try {
          const normalized = normalizeEntry(options.name, serverDef)
          if (!isDisabledEntry(normalized)) {
            approve(approvalsPath(adapterHome(this.dshHome)), workspaceRoot, options.name, normalized)
          }
        } catch {
          // Graceful approval
        }
      }
    }

    return { ok: true, enabled: options.enabled }
  }

  /**
   * Scan host machine and external AI coding tools for MCP configurations.
   */
  scanExternal(options: { cwd?: string } = {}): ExternalMcpScanResult {
    // No project named means no project files to scan; the machine-wide sources still are.
    const workspaceRoot = this.resolveTarget(options.cwd)
    return scanExternalMcp(workspaceRoot === '' ? {} : { projectPath: workspaceRoot })
  }

  /**
   * Batch import candidates from external tool scan into target scope.
   */
  async importExternal(options: {
    items: ExternalMcpCandidate[]
    scope: Scope
    cwd?: string
  }): Promise<{ ok: boolean; importedCount: number; errors: string[] }> {
    const errors: string[] = []
    let importedCount = 0

    for (const item of options.items) {
      try {
        const serverDef: Record<string, unknown> = {
          transport: item.transport,
          ...(item.command ? { command: item.command } : {}),
          ...(item.args && item.args.length > 0 ? { args: item.args } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(item.headers && Object.keys(item.headers).length > 0 ? { headers: item.headers } : {}),
          ...(item.env && Object.keys(item.env).length > 0 ? { env: item.env } : {}),
          ...(item.description ? { description: item.description } : {}),
          ...(item.disabled ? { disabled: true } : {}),
        }

        await this.saveServer({
          name: item.id,
          scope: options.scope,
          cwd: options.cwd,
          server: serverDef,
        })
        importedCount += 1
      } catch (err: unknown) {
        errors.push(`Failed to import "${item.id}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return { ok: true, importedCount, errors }
  }

  /**
   * List curated MCP catalog entries for Market view.
   */
  listCatalog(): McpCatalogEntry[] {
    return listCatalogEntries()
  }

}
