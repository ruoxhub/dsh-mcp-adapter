// Backend persistence service and probe for MCP servers across user and workspace scopes.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import {
  adapterHome,
  findProjectRoot,
  isDisabledEntry,
  normalizeEntry,
  parseJsonText,
  resolveDshHome,
  SERVER_NAME_PATTERN,
} from './config.ts'
import { getKnownPreset, type KnownServerPreset, listKnownPresets } from './presets.ts'
import { cachePath, purgeCacheEntry } from './cache.ts'
import { approvalsPath, approve, isApproved, removeApproval } from './trust.ts'
import type { McpServerDetail, ProbeResult, Scope } from './types.ts'

export type { KnownServerPreset, McpServerDetail, ProbeResult, Scope }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  ctx: { dshHome: string; projectRoot: string },
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
      const normalized = normalizeEntry(name, raw, { projectRoot: ctx.projectRoot })
      if (!isDisabledEntry(normalized)) {
        const appPath = approvalsPath(adapterHome(ctx.dshHome))
        const approved = isApproved(appPath, ctx.projectRoot, name, normalized)
        status = approved ? 'ready' : 'blocked'
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
  }
}

/** One workspace the panel can manage; `path` is the project root holding `.mcp.json`. */
export interface WorkspaceOption {
  path: string
  title: string
}

export interface McpServersServiceOptions {
  dshHome?: string
  /**
   * Every workspace the host knows (the DSH workspace registry). Optional: a composition without
   * one still gets the active project root as the only entry.
   */
  workspaces?: () => WorkspaceOption[]
  /**
   * Optional eviction hook to close/evict running connections from active pools.
   */
  onEvictServer?: (name: string) => Promise<void> | void
}

export class McpServersService {
  private readonly dshHome: string
  private readonly registeredWorkspaces?: () => WorkspaceOption[]
  private readonly onEvictServer?: (name: string) => Promise<void> | void

  constructor(options?: McpServersServiceOptions) {
    this.dshHome = options?.dshHome ?? resolveDshHome()
    this.registeredWorkspaces = options?.workspaces
    this.onEvictServer = options?.onEvictServer
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
    let registered: WorkspaceOption[] = []
    try {
      registered = (this.registeredWorkspaces?.() ?? []).filter(
        (item): item is WorkspaceOption => typeof item?.path === 'string' && item.path.trim() !== '',
      )
    } catch {
      // An unavailable registry leaves the active root as the only known workspace.
    }
    const out: WorkspaceOption[] = []
    const add = (path: string, title: unknown): void => {
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
    const effectiveCwd = resolve(options.cwd ?? process.cwd())
    const workspaceRoot = findProjectRoot(effectiveCwd)
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
          servers.push(toServerDetail(name, 'user', raw, { dshHome: this.dshHome, projectRoot: workspaceRoot }))
        }
      }
    }

    // Workspace scope
    if (options.scope !== 'user') {
      const wsPath = join(workspaceRoot, '.mcp.json')
      const wsJson = safeReadJson(wsPath)
      const rawServers = wsJson?.mcpServers ?? wsJson?.servers
      if (isRecord(rawServers)) {
        for (const [name, raw] of Object.entries(rawServers)) {
          if (!isRecord(raw)) continue
          servers.push(toServerDetail(name, 'workspace', raw, { dshHome: this.dshHome, projectRoot: workspaceRoot }))
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

    const effectiveCwd = options.cwd ? resolve(options.cwd) : process.cwd()
    const workspaceRoot = findProjectRoot(effectiveCwd)
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
        const normalized = normalizeEntry(options.name, options.server, { projectRoot: workspaceRoot })
        if (!isDisabledEntry(normalized)) {
          approve(approvalsPath(adapterHome(this.dshHome)), workspaceRoot, options.name, normalized)
        }
      } catch {
        // If entry fails validation, saving succeeds; approval fails gracefully
      }
    }

    // Evict old identity from cache & pool if renamed or moved
    if (isRename || isScopeChange) {
      purgeCacheEntry(cachePath(adapterHome(this.dshHome)), prevName)
      try {
        await this.onEvictServer?.(prevName)
      } catch {
        // Eviction errors do not fail the save
      }
    }

    // Invalidate new server cache & running connection so changes take effect immediately
    purgeCacheEntry(cachePath(adapterHome(this.dshHome)), options.name)
    try {
      await this.onEvictServer?.(options.name)
    } catch {
      // Eviction errors do not fail the save
    }

    return { ok: true }
  }

  /**
   * Approve a project/workspace server by recording its definition hash.
   */
  async approveServer(options: { cwd?: string; name: string }): Promise<{ ok: boolean }> {
    const effectiveCwd = resolve(options.cwd ?? process.cwd())
    const workspaceRoot = findProjectRoot(effectiveCwd)
    const wsPath = join(workspaceRoot, '.mcp.json')
    const wsJson = safeReadJson(wsPath)
    const rawServers = wsJson?.mcpServers ?? wsJson?.servers

    if (!isRecord(rawServers) || !rawServers[options.name]) {
      throw new Error(`Server "${options.name}" not found in workspace at ${effectiveCwd}`)
    }

    const raw = rawServers[options.name]
    const normalized = normalizeEntry(options.name, raw, { projectRoot: workspaceRoot })
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
    const effectiveCwd = options.cwd ? resolve(options.cwd) : process.cwd()
    const workspaceRoot = findProjectRoot(effectiveCwd)
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

    // Invalidate disk cache and evict running process from ServerPool
    purgeCacheEntry(cachePath(adapterHome(this.dshHome)), options.name)
    try {
      await this.onEvictServer?.(options.name)
    } catch {
      // Eviction errors do not fail the delete
    }

    return { ok: true }
  }

  /**
   * Probe an MCP server endpoint for reachability and latency.
   */
  async probeServer(server: Record<string, unknown>): Promise<ProbeResult> {
    const command = Array.isArray(server.command)
      ? String(server.command[0])
      : typeof server.command === 'string'
        ? server.command
        : undefined

    if (command) {
      const start = performance.now()
      const cwd = typeof server.cwd === 'string' ? server.cwd : undefined
      const found = findExecutable(command, cwd)
      const latencyMs = Math.round(performance.now() - start)
      if (found) {
        return { ok: true, latencyMs }
      }
      return { ok: false, latencyMs, error: `Command not found: "${command}"` }
    }

    const url = typeof server.url === 'string'
      ? server.url
      : typeof server.serverUrl === 'string'
        ? server.serverUrl
        : typeof server.httpUrl === 'string'
          ? server.httpUrl
          : undefined

    if (url) {
      const timeoutMs = typeof server.timeoutMs === 'number' && server.timeoutMs > 0
        ? Math.min(server.timeoutMs, 5000)
        : 5000
      const start = performance.now()
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          await fetch(url, { signal: controller.signal, method: 'GET' })
        } finally {
          clearTimeout(timer)
        }
        const latencyMs = Math.round(performance.now() - start)
        return { ok: true, latencyMs }
      } catch (error: unknown) {
        const latencyMs = Math.round(performance.now() - start)
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, latencyMs, error: message || 'Connection failed' }
      }
    }

    if (typeof server.socket === 'string') {
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

    return { ok: false, error: 'Server configuration must specify command or url' }
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

    const effectiveCwd = options.cwd ? resolve(options.cwd) : process.cwd()
    const workspaceRoot = findProjectRoot(effectiveCwd)
    const targetPath = options.scope === 'user'
      ? join(this.dshHome, 'mcp-adapter', 'mcp.json')
      : join(workspaceRoot, '.mcp.json')

    return {
      ok: true,
      path: targetPath,
      serverName: preset.name,
    }
  }
}
