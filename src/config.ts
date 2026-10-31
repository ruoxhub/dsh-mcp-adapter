// Config discovery, merge, and normalization — the part every other module reads.
//
// Sources, lowest precedence first. This mirrors what pi-mcp-adapter reads, minus everything that
// only exists because Pi has a config dir of its own:
//
//   $DSH_HOME/mcp-adapter/mcp.json          user-global servers
//   $DSH_HOME/mcp-adapter/mcp-adapter.json  user-global settings + servers
//   <project>/.mcp.json                     project servers        (need approval)
//   <project>/.dsh/mcp-adapter.json         project overrides      (need approval)
//
// `mcpServers` is the shared key; `servers` is accepted so a dsh-native file reads naturally.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { importHostServers } from './imports.ts'
import type { ServerConfig } from './types.ts'

/** Server names become tool-name segments, so they follow the same character set dsh enforces. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const PROJECT_FILES = ['.dsh/mcp-adapter.json', '.mcp.json']

/** The adapter's own policy keys; a server entry may override the per-server ones. */
export interface AdapterSettings {
  /** Minutes a lazy server may sit idle before it is stopped. 0 keeps it until the session ends. */
  idleTimeout: number
  /** Milliseconds for one MCP request. */
  requestTimeoutMs: number
  /** `ask` holds a project server until its exact definition was approved. */
  projectServers: 'ask' | 'allow' | 'deny'
  /** Register every server's tools as first-class tools instead of through the `mcp` proxy. */
  directTools: boolean | 'search'
  /** Include MCP resources as tools. */
  exposeResources: boolean
  /** Ask before calling tools: true, "destructive", or a list of names. */
  approveTools: boolean | 'destructive' | string[]
  /** Prefix prepended to every tool name, `server_tool` by default. */
  toolPrefix: string
  /** Adopt MCP servers from other agents' global config files. false, true, or a host list. */
  importHosts: boolean | string[]
  /** Maximum character length of tool output before spilling to disk. Default: 40000. */
  maxOutputChars: number
}

/** Settings defaults; a server entry may override the per-server ones. */
export const DEFAULT_SETTINGS: AdapterSettings = {
  /** Minutes a lazy server may sit idle before it is stopped. 0 keeps it until the session ends. */
  idleTimeout: 10,
  /** Milliseconds for one MCP request. */
  requestTimeoutMs: 60_000,
  /** `ask` holds a project server until its exact definition was approved. */
  projectServers: 'ask',
  /** Register every server's tools as first-class tools instead of through the `mcp` proxy. */
  directTools: false,
  /** Include MCP resources as tools. */
  exposeResources: true,
  /** Ask before calling tools: true, "destructive", or a list of names. */
  approveTools: false,
  /** Prefix prepended to every tool name, `server_tool` by default. */
  toolPrefix: '',
  /** Adopt MCP servers from other agents' global config files. false, true, or a host list. */
  importHosts: false,
  /** Maximum character length of tool output before spilling to disk. Default: 40000. */
  maxOutputChars: 40_000,
}

/**
 * The policy keys a cloned repository may not set: each one can mount code the user never approved
 * (`projectServers`, `importHosts`), auto-approve calls the user would have been asked about
 * (`approveTools`, `directTools`), or both. A `.mcp.json` in a repository is untrusted input, so
 * these come from the user's own file only.
 */
const USER_ONLY_SETTINGS: ReadonlySet<string> = new Set(['projectServers', 'approveTools', 'importHosts', 'directTools'])

/** The `{ name, disabled: true }` early return: a server switched off in a config file. */
export interface DisabledServerEntry {
  name: string
  disabled: true
}

/** What `normalizeEntry` returns; narrow with `isDisabledEntry` before reading a server field. */
export type ServerEntry = ServerConfig | DisabledServerEntry

export function isDisabledEntry(entry: ServerEntry): entry is DisabledServerEntry {
  return entry.disabled === true
}

/** Where a loaded server came from, in precedence order. */
export type ServerOrigin = 'global' | 'project' | 'custom' | 'imported' | 'config'

/** One entry of the merged server map. */
export interface LoadedServerEntry {
  origin: ServerOrigin
  path: string
  config: ServerEntry
}

export interface LoadConfigOptions {
  /** The session directory; selects the project files. */
  cwd?: string
  /** Harness home; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Environment for interpolation. */
  env?: NodeJS.ProcessEnv
  /** Extra files, highest precedence last. */
  configFiles?: unknown[]
  /** Inline servers from the Loader entry, highest of all. */
  servers?: Record<string, unknown>
  /** Loader defaults, overridden by a project's own `settings` file. */
  settings?: Partial<AdapterSettings>
  /** Home directory searched for other agents' config files. */
  homeDir?: string
}

export interface LoadedConfig {
  projectRoot: string
  home: string
  servers: Map<string, LoadedServerEntry>
  settings: AdapterSettings
  errors: string[]
  loaded: string[]
  paths: string[]
}

/** One discovered config source before it is read. */
interface ConfigSource {
  path: string
  scope: 'global' | 'project' | 'custom'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `${VAR}`, `$env:VAR` and `{env:VAR}` expand from the environment other agents' files assume. */
export function expandEnv(value: unknown, environment: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value !== 'string') return value
  return value
    .replace(/\$\{(\w+)\}/g, (_, name: string) => environment[name] ?? '')
    .replace(/\$env:(\w+)/g, (_, name: string) => environment[name] ?? '')
    .replace(/\{env:(\w+)\}/g, (_, name: string) => environment[name] ?? '')
}

/** Strip a UTF-8 BOM and `//` / block comments, then parse; a trailing comma stays an error. */
export function parseJsonText(text: string, label: string): unknown {
  const stripped = text
    .replace(/^\uFEFF/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  try {
    return JSON.parse(stripped)
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${messageOf(error)})`)
  }
}

/** The nearest ancestor holding `.git`; without one, the starting directory. Matches dsh's own rule. */
export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** `$DSH_HOME` when set, else `~/.dsh` — the same rule the rest of the harness applies. */
export function resolveDshHome(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.DSH_HOME
  return typeof override === 'string' && override.trim().length > 0 ? resolve(override) : join(homedir(), '.dsh')
}

/** Where this adapter keeps its own state: settings, cache, approvals, OAuth records. */
export function adapterHome(dshHome: string): string {
  return join(dshHome, 'mcp-adapter')
}

function serversOf(value: unknown): Record<string, unknown> {
  const config = isRecord(value) ? value : undefined
  const servers = config?.mcpServers ?? config?.servers
  return isRecord(servers) ? servers : {}
}

function stringRecord(value: unknown, environment: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRecord(value)) return out
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && entry !== undefined) out[key] = String(expandEnv(String(entry), environment))
  }
  return out
}

/**
 * `httpTransport` is the canonical spelling; `transport` is what the Web panel used to write and
 * what many hand-written `.mcp.json` files carry, so it is read as an alias instead of being
 * silently dropped. `stdio` is the absence of both — it is not a transport override.
 */
function httpTransportOf(raw: Record<string, unknown>): string | undefined {
  const canonical = typeof raw.httpTransport === 'string' ? raw.httpTransport : undefined
  if (canonical !== undefined) return canonical
  const alias = raw.transport
  return alias === 'sse' || alias === 'streamable-http' ? alias : undefined
}

/**
 * `requestTimeoutMs` is canonical; `timeoutMs` is the alias the Web panel wrote and the spelling
 * shared by several other MCP clients. A non-positive or non-finite value is not a timeout, so it
 * falls through to the default rather than disabling the guard.
 */
function requestTimeoutOf(raw: Record<string, unknown>): number | undefined {
  for (const candidate of [raw.requestTimeoutMs, raw.timeoutMs]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** `['lazy', 'keep-alive', 'lazy-keep-alive', 'eager'].includes(value)`, without trusting the input. */
function lifecycleOf(value: unknown): ServerConfig['lifecycle'] {
  switch (value) {
    case 'lazy':
    case 'keep-alive':
    case 'lazy-keep-alive':
    case 'eager':
      return value
    default:
      return 'lazy'
  }
}

/**
 * One server definition. Field names follow pi-mcp-adapter so an existing `.mcp.json` works:
 * `command`/`args`/`env` for stdio, `url`/`headers` for HTTP, plus lifecycle, filters, approval.
 */
export function normalizeEntry(
  name: string,
  raw: unknown,
  { env = process.env, projectRoot }: { env?: NodeJS.ProcessEnv; projectRoot?: string } = {},
): ServerEntry {
  if (!isRecord(raw)) throw new Error(`server "${name}": entry must be an object`)
  if (raw.disabled === true || raw.enabled === false) return { name, disabled: true }

  const url = expandEnv(raw.url ?? raw.serverUrl ?? raw.httpUrl, env)
  const socket = typeof raw.socket === 'string' ? raw.socket : undefined
  const commandField: unknown[] | undefined = Array.isArray(raw.command) ? raw.command : undefined
  const expandedCommand = expandEnv(commandField ? commandField[0] : raw.command, env)
  const command = typeof expandedCommand === 'string' ? expandedCommand : undefined
  const rawArgs: unknown[] = commandField ? commandField.slice(1) : Array.isArray(raw.args) ? raw.args : []
  const args = rawArgs.map((arg) => String(expandEnv(String(arg), env)))

  if (!url && !socket && typeof expandedCommand !== 'string') throw new Error(`server "${name}": needs "command", "url", or "socket"`)

  const oauth = raw.oauth === false ? false : raw.oauth && typeof raw.oauth === 'object' ? raw.oauth : undefined
  const auth = raw.auth === 'oauth' || raw.auth === 'bearer' || raw.auth === false ? raw.auth : undefined
  const httpTransport = httpTransportOf(raw)
  const requestTimeoutMs = requestTimeoutOf(raw)

  return {
    name,
    transport: url ? 'http' : socket ? 'socket' : 'stdio',
    ...(command === undefined ? {} : { command }),
    args,
    env: stringRecord(raw.env, env),
    inheritEnv: raw.inheritEnv !== false,
    // Project servers run from the repository they were declared in, so relative arguments work.
    cwd: typeof raw.cwd === 'string' && isAbsolute(raw.cwd) ? raw.cwd : projectRoot ?? '',
    // The source keeps every url that is not `undefined` verbatim: `url === undefined ? {} : { url }`.
    // A non-string one still reaches `new URL`, whose ToString coercion is what `String` applies here,
    // so an array-shaped url keeps connecting instead of being dropped with `transport` still `http`.
    ...(url === undefined ? {} : { url: String(url) }),
    ...(socket === undefined ? {} : { socket }),
    headers: stringRecord(raw.headers ?? raw.http_headers, env),
    ...(raw.caFile === undefined ? {} : { caFile: resolve(String(expandEnv(String(raw.caFile), env))) }),
    ...(auth === undefined ? {} : { auth }),
    ...(oauth === undefined ? {} : { oauth }),
    ...(typeof raw.bearerToken === 'string' ? { bearerToken: String(expandEnv(raw.bearerToken, env)) } : {}),
    ...(typeof raw.bearerTokenEnv === 'string' ? { bearerToken: env[raw.bearerTokenEnv] } : {}),
    lifecycle: lifecycleOf(raw.lifecycle),
    ...(typeof raw.idleTimeout === 'number' && Number.isFinite(raw.idleTimeout) && raw.idleTimeout >= 0 ? { idleTimeout: raw.idleTimeout } : {}),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    directTools: raw.directTools === true || raw.directTools === 'search' || Array.isArray(raw.directTools) ? raw.directTools : false,
    ...(Array.isArray(raw.includeTools) ? { includeTools: raw.includeTools.map(String) } : {}),
    ...(Array.isArray(raw.excludeTools) ? { excludeTools: raw.excludeTools.map(String) } : {}),
    ...(raw.searchKeywords && typeof raw.searchKeywords === 'object' ? { searchKeywords: raw.searchKeywords } : {}),
    ...(raw.approveTools === undefined ? {} : { approveTools: raw.approveTools }),
    // Other agents' files spell the allowlist `autoApprove`; keep it so a shared .mcp.json keeps
    // the intent its author wrote instead of silently asking about every call.
    ...(raw.autoApprove === undefined || raw.autoApprove === false ? {} : { autoApprove: raw.autoApprove }),
    exposeResources: raw.exposeResources !== false,
    appendStructuredContent: raw.appendStructuredContent !== false,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(typeof raw.toolPrefix === 'string' ? { toolPrefix: raw.toolPrefix } : {}),
    ...(httpTransport === undefined ? {} : { httpTransport }),
    ...(raw.protocolVersion === undefined ? {} : { protocolVersion: raw.protocolVersion }),
    debug: raw.debug === true,
  }
}

/**
 * A `socket` entry is a valid *definition* (the trust hash covers it) but this adapter has no
 * unix-socket transport, so it must be refused where servers are mounted rather than at the moment
 * a tool call happens to reach it. Refusing at config time is what turns a mid-call crash into a
 * line the panel and `mcp({})` both show.
 * @returns whether the entry was refused, so the caller skips it.
 */
function refuseUnsupportedTransport(name: string, label: string, config: ServerEntry, errors: string[]): boolean {
  if (isDisabledEntry(config) || config.transport !== 'socket') return false
  errors.push(`${label}: server "${name}" uses a unix socket, which dsh-mcp-adapter does not support; use command or url`)
  return true
}

/**
 * Load every source, merge by name (a later file replaces an earlier server outright), and
 * resolve settings. Nothing here touches the network.
 * @returns `{ projectRoot, servers, settings, errors, loaded, paths }`.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const environment = options.env ?? process.env
  const dshHome = options.dshHome ?? resolveDshHome(environment)
  const home = adapterHome(dshHome)
  const cwd = resolve(options.cwd ?? process.cwd())
  const projectRoot = findProjectRoot(cwd)

  const sources: ConfigSource[] = [
    { path: join(home, 'mcp.json'), scope: 'global' },
    { path: join(home, 'mcp-adapter.json'), scope: 'global' },
    ...PROJECT_FILES.map((relative): ConfigSource => ({ path: join(projectRoot, relative), scope: 'project' })),
  ]
  for (const entry of Array.isArray(options.configFiles) ? options.configFiles : []) {
    const spec: unknown = typeof entry === 'string' ? { path: entry } : entry
    if (spec === null || typeof spec !== 'object' || !('path' in spec) || typeof spec.path !== 'string') continue
    sources.push({
      path: isAbsolute(spec.path) ? spec.path : resolve(cwd, spec.path),
      scope: 'scope' in spec && spec.scope === 'project' ? 'project' : 'custom',
    })
  }

  const servers = new Map<string, LoadedServerEntry>()
  const errors: string[] = []
  const loaded: string[] = []
  // The Loader entry supplies defaults; a project's own `settings` overrides them, because a file
  // in the repository is a more specific statement than the plugin row that hosts the adapter.
  const settings: AdapterSettings & Record<string, unknown> = { ...DEFAULT_SETTINGS, ...(options.settings ?? {}) }
  const defaults: Record<string, unknown> = { ...DEFAULT_SETTINGS }

  for (const source of sources) {
    if (!existsSync(source.path)) continue
    let value: unknown
    try {
      value = parseJsonText(readFileSync(source.path, 'utf8'), source.path)
    } catch (error) {
      errors.push(messageOf(error))
      continue
    }
    loaded.push(source.path)
    const fileSettings = isRecord(value) ? value.settings : undefined
    if (isRecord(fileSettings)) {
      for (const [key, entry] of Object.entries(fileSettings)) {
        if (defaults[key] === undefined && key !== 'projectServers') continue
        // A cloned repository may not widen what runs or what is auto-approved; only the user's own
        // file may. `idleTimeout`, `exposeResources` and `toolPrefix` stay project-settable: they
        // tune an approved server without adding one, hiding an approval, or reaching more tools.
        if (source.scope !== 'global' && USER_ONLY_SETTINGS.has(key)) continue
        settings[key] = entry
      }
    }
    for (const [name, raw] of Object.entries(serversOf(value))) {
      if (!SERVER_NAME_PATTERN.test(name)) {
        errors.push(`${source.path}: server name "${name}" must match ${SERVER_NAME_PATTERN}`)
        continue
      }
      try {
        const config = normalizeEntry(name, raw, { env: environment, projectRoot })
        if (refuseUnsupportedTransport(name, source.path, config, errors)) continue
        servers.set(name, { origin: source.scope, path: source.path, config })
      } catch (error) {
        errors.push(`${source.path}: ${messageOf(error)}`)
      }
    }
  }

  // Adopted host files sit BELOW every native source: a server you already declared here wins.
  const imported = importHostServers(settings.importHosts, options.homeDir)
  errors.push(...imported.errors)
  for (const source of imported.sources) loaded.push(source.path)
  for (const [name, entry] of imported.servers) {
    if (servers.has(name)) continue
    if (!SERVER_NAME_PATTERN.test(name)) {
      errors.push(`${entry.path}: server name "${name}" must match ${SERVER_NAME_PATTERN}`)
      continue
    }
    try {
      const config = normalizeEntry(name, entry.raw, { env: environment, projectRoot })
      if (refuseUnsupportedTransport(name, entry.path, config, errors)) continue
      servers.set(name, { origin: 'imported', path: entry.path, config })
    } catch (error) {
      errors.push(`${entry.path}: ${messageOf(error)}`)
    }
  }

  const inline = isRecord(options.servers) ? options.servers : {}
  for (const [name, raw] of Object.entries(inline)) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      errors.push(`config.servers: server name "${name}" must match ${SERVER_NAME_PATTERN}`)
      continue
    }
    try {
      const config = normalizeEntry(name, raw, { env: environment, projectRoot })
      if (refuseUnsupportedTransport(name, 'config.servers', config, errors)) continue
      servers.set(name, { origin: 'config', path: '', config })
    } catch (error) {
      errors.push(`config.servers: ${messageOf(error)}`)
    }
  }

  return { projectRoot, home, servers, settings, errors, loaded, paths: sources.map((source) => source.path) }
}
