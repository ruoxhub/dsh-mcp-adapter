// The MCP connection pool. One entry per server; connect lazily, stop when idle, reconnect when a
// keep-alive server drops.
//
// This is the heart of the port and the reason it exists: pi-mcp-adapter's value over a plain MCP
// client is that a configured server costs nothing until it is used, and costs nothing again once
// it goes idle. Everything here is `@modelcontextprotocol/client` + node, no host surface.

import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, SSEClientTransport, SdkHttpError, StreamableHTTPClientTransport, type ClientOptions, type Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { AdapterSettings } from './config.ts'
import { fetchWithCa, readCaBundle, type FetchLike } from './tls-fetch.ts'
import { createRequestHeadersCommandFetch } from './request-headers-command.ts'
import { resolveServerToken } from './credentials.ts'
import { registerElicitationHandler, callToolPausingForElicitation, type UserQuestionsLike } from './elicitation.ts'
import type { ServerCatalog, ServerConfig } from './types.ts'
import { withTimeout } from './util.ts'

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/**
 * Default for one execution. Ten minutes: long enough for a browser session, a build or an export,
 * short enough that a wedged server still fails inside one turn.
 */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60_000
export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 30_000
/** How long a burst of list-changed notifications is coalesced before one catalog read. */
export const LIST_CHANGED_DEBOUNCE_MS = 100

/**
 * The logger surface this module ducks. Every call site stays optional: a caller that passes
 * nothing must keep working, and cordis's own logger satisfies the shape structurally.
 */
export interface Logger {
  info?: (message: string) => void
  warn?: (message: string) => void
  debug?: (message: string) => void
}

/** One live connection: the client, its transport, and when it was last used. */
export class Connection {
  client: Client
  transport: Transport
  close: () => Promise<void>
  lastUsedAt: number
  catalog: ServerCatalog | undefined
  /**
   * Whether this connection has issued `tools/list`.
   *
   * The SDK validates a call's `structuredContent` against the tool's `outputSchema` using the tool
   * list it cached from `tools/list`. A server whose catalog came from our own disk cache is never
   * listed on this connection, so without this flag the first call after a warm start would silently
   * skip that validation. Verified against `@modelcontextprotocol/client@2.2.0`: a call without a
   * prior `listTools()` on the same client returns the malformed content unchecked.
   */
  toolsListed: boolean

  constructor(client: Client, transport: Transport, close: () => Promise<void>) {
    this.client = client
    this.transport = transport
    this.close = close
    this.lastUsedAt = Date.now()
    this.catalog = undefined
    this.toolsListed = false
  }
}

/** The five states a pooled server can be in; `status()` reports the same set. */
export type PoolState = 'idle' | 'connecting' | 'connected' | 'dropped' | 'failed'

/** One server's pool entry: the definition, the thing running it, and its reconnect state. */
export interface PoolEntry {
  config: ServerConfig
  connection?: Connection
  /** The in-flight connect attempt, so concurrent callers share one instead of spawning two. */
  connecting?: Promise<Connection>
  reconnectAttempts: number
  timer?: ReturnType<typeof setTimeout>
  state: PoolState
  lastError?: string
  /** Recent stderr lines captured from the process. */
  recentStderr?: string[]
  /** The effective catalog, live or restored from cache; it outlives the connection. */
  catalog?: ServerCatalog
  /** Coalesces a burst of list-changed notifications into one catalog read. */
  changeTimer?: ReturnType<typeof setTimeout>
}

/** One row of `status()`, which is what the proxy tool and the panel read. */
export interface PoolStatus {
  name: string
  state: PoolState
  hasCatalog: boolean
  lastError?: string
  recentStderr?: string[]
  lifecycle: string
}

/** What the pool needs at construction; every callback is optional. */
export interface ServerPoolOptions {
  /** Adapter state directory (cache and approvals live there). */
  home: string
  /**
   * The directory servers run in: the session's *current* directory, read at connect time.
   *
   * A function, not a string, because the pool outlives a step: `working_directory` can move the
   * session between the moment the pool was built and the moment a lazy server first connects, and
   * a snapshot would spawn that server in a directory the session has already left. This is the
   * only place a server's directory comes from — `ServerConfig.cwd` is what a config file *wrote*,
   * and it is resolved against this value rather than replacing it.
   */
  cwd?: () => string | undefined
  onCatalog?: (name: string, catalog: ServerCatalog) => void
  /**
   * A live server announced a list change and its catalog was re-read.
   *
   * Separate from {@link ServerPoolOptions.onCatalog} because the two happen on different paths: the
   * cold-start read is followed by the session's own batched cache write (ADR-0010), while this one
   * has no such owner and must persist itself or the change dies with the process.
   */
  onCatalogRefresh?: (name: string, catalog: ServerCatalog) => void
  onStatus?: (name: string) => void
  logger?: Logger
  settings?: Partial<AdapterSettings>
  credentials?: unknown
  userQuestions?: UserQuestionsLike
  agent?: unknown
}

/** An object-shaped value, which is the only shape MCP argument maps have. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * `String(error?.message ?? error)`, without reading a property off a primitive. A thrown value is
 * whatever the SDK or a transport raised, so it arrives as `unknown` here.
 */
function messageOf(error: unknown): string {
  if (isRecord(error) && error.message !== undefined && error.message !== null) return String(error.message)
  return String(error)
}

function scrubbedEnv(): Record<string, string> {
  // Never hand the server ambient credentials it did not ask for.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue
    if (key.startsWith('DSH_')) continue
    env[key] = value
  }
  return env
}

/**
 * The directory one server process runs in.
 *
 * An entry that named a directory gets it — relative values are relative to the session's own
 * directory, so `"./servers"` keeps meaning the same thing in every checkout. An entry that named
 * none runs in the session's directory. `undefined` (a session that records no directory at all)
 * is passed through: that is the one case where the child inherits the host's launch directory,
 * because the alternative — refusing to start — would take every user-global server away from
 * headless callers for no benefit. Config discovery and approval never make this guess.
 */
/**
 * Whether a failure means the server forgot this legacy Streamable HTTP session.
 *
 * A legacy streamable session lives on the server under an `Mcp-Session-Id`; a server that was
 * restarted answers the next POST with 404, or with the 400 a freshly restarted single-session
 * server emits. The transport surfaces that as an `SdkHttpError` and does **not** fire `onclose`, so
 * without this check the pool kept a dead connection and advertised `connected` forever (ADR-0011).
 *
 * Only connections that actually hold a session id qualify: a stateless (modern) connection has no
 * session to expire, and its 404 for an unknown method must not be mistaken for one.
 */
function isExpiredSession(error: unknown, transport: Transport | undefined): boolean {
  if (!(error instanceof SdkHttpError)) return false
  if (error.data.status !== 404) return false
  return (transport as { sessionId?: string } | undefined)?.sessionId !== undefined
}

function resolveServerCwd(config: ServerConfig, sessionCwd: string | undefined): string | undefined {
  if (config.cwd === undefined || config.cwd.length === 0) return sessionCwd
  return sessionCwd === undefined ? resolve(config.cwd) : resolve(sessionCwd, config.cwd)
}

function stdioTransport(config: ServerConfig, sessionCwd: string | undefined): StdioClientTransport {
  // `normalizeEntry` guarantees a command whenever the transport is stdio (no url, no socket, or it
  // throws), so this only turns an untyped hole into a stated precondition.
  const command = config.command
  if (command === undefined) throw new Error(`server "${config.name}": a stdio transport needs a command`)
  return new StdioClientTransport({
    command,
    args: config.args ?? [],
    cwd: resolveServerCwd(config, sessionCwd),
    env: config.inheritEnv === false ? { ...config.env } : { ...scrubbedEnv(), ...config.env },
    stderr: config.debug ? 'inherit' : 'pipe',
  })
}

function httpHeaders(config: ServerConfig, overrideBearerToken?: string): Record<string, string> {
  const headers = { ...(config.headers ?? {}) }
  const token = overrideBearerToken ?? config.bearerToken
  if (token && headers.Authorization === undefined) headers.Authorization = `Bearer ${token}`
  return headers
}

function httpTransport(config: ServerConfig, baseUrl: URL, overrideBearerToken?: string): Transport {
  let customFetch: FetchLike | undefined
  if (config.caFile !== undefined && config.caFile.length > 0) {
    customFetch = fetchWithCa(readCaBundle(config.caFile))
  }
  if (config.requestHeadersCommand !== undefined) {
    customFetch = createRequestHeadersCommandFetch(config.requestHeadersCommand, customFetch ?? globalThis.fetch)
  }

  const options: {
    requestInit: { headers: Record<string, string> }
    fetch?: FetchLike
  } = {
    requestInit: { headers: httpHeaders(config, overrideBearerToken) },
    ...(customFetch ? { fetch: customFetch } : {}),
  }

  return config.httpTransport === 'sse'
    ? new SSEClientTransport(baseUrl, options)
    : new StreamableHTTPClientTransport(baseUrl, options)
}

/**
 * The SDK client options for one server.
 *
 * `protocolVersion` reaches the wire here: `"auto"` probes with `server/discover` and falls back to
 * the plain legacy handshake, a concrete version pins it. Anything else stays on the SDK default
 * (`'legacy'`), which is what a server that never mentioned the field should get.
 */
function clientOptions(
  config: ServerConfig,
  userQuestions?: UserQuestionsLike,
  onListChanged?: () => void,
): ClientOptions {
  const options: ClientOptions = {
    capabilities: {
      ...(config.roots !== false ? { roots: {} } : {}),
      ...(userQuestions ? { elicitation: { form: {} } } : {}),
    },
  }
  // A server that adds or removes tools while connected announces it; without these handlers the
  // catalog stayed whatever `tools/list` said at connect time, so a hot-reloaded server's new tools
  // were invisible until the idle sweep stopped it (ADR-0011). `autoRefresh: false` because one
  // notification is answered by one full catalog read (tools, resources, prompts) rather than by
  // three separate re-listings the SDK would otherwise run itself.
  if (onListChanged !== undefined) {
    const changed = { autoRefresh: false, debounceMs: 100, onChanged: () => onListChanged() }
    options.listChanged = { tools: changed, prompts: changed, resources: changed }
  }
  const wanted = config.protocolVersion
  if (wanted === 'auto') options.versionNegotiation = { mode: 'auto' }
  else if (typeof wanted === 'string' && wanted.length > 0 && wanted !== 'legacy') {
    options.versionNegotiation = { mode: { pin: wanted } }
  }
  return options
}

/**
 * A pool of MCP servers for one Agent.
 *
 * `catalog(name)` returns tools/resources/prompts/instructions, connecting only when the cache has
 * nothing to serve. `call()` guarantees a live connection. `close()` is what the idle timer uses.
 */

/** A server that does not implement a capability answers `Method not found`; that is not a fault. */
function isUnsupportedCapability(error: unknown): boolean {
  if (error === null || error === undefined) return false
  if (isRecord(error) && error.code === -32601) return true
  const message = String(isRecord(error) ? (error.message ?? error) : error)
  return /method not found|not supported|unsupported|is not implemented/i.test(message)
}

/**
 * The `arguments` map of a `tools/call` request, which the SDK types as a JSON object.
 *
 * The source forwarded whatever it was handed, so a malformed value only failed once it reached the
 * server, after a tool had been selected and possibly started. Refusing it here is the only way to
 * keep the signature `args: unknown` without a cast, and it fails closed instead of letting a tool
 * run with the arguments silently dropped.
 */
function toolArguments(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {}
  if (isRecord(args) && !Array.isArray(args)) return args
  throw new Error(`tools/call arguments must be a JSON object, got ${Array.isArray(args) ? 'an array' : typeof args}`)
}

/**
 * The `arguments` map of a `prompts/get` request, which MCP declares as a string map.
 *
 * The proxy hands `args` over as JSON, so a number or boolean reaches here and must become a string:
 * MCP's own `prompts/get` declares `Record<string, string>`, and refusing the whole call over a
 * `count=3` would be worse than rendering it. Anything else is refused, exactly like
 * {@link toolArguments}: `String({...})` would send the server the literal `[object Object]`, which
 * is never what the caller meant and would be accepted only to fail somewhere further away. An
 * `undefined` value is dropped rather than stringified, because JSON serialization drops it anyway.
 */
function promptArguments(args: unknown): Record<string, string> | undefined {
  if (args === undefined || args === null) return undefined
  if (!isRecord(args) || Array.isArray(args)) {
    throw new Error(`prompts/get arguments must be a JSON object, got ${Array.isArray(args) ? 'an array' : typeof args}`)
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value)
      continue
    }
    throw new Error(`prompts/get argument "${key}" must be a string, number, or boolean, got ${Array.isArray(value) ? 'an array' : typeof value}`)
  }
  return out
}

export class ServerPool {
  home: string
  settings: Partial<AdapterSettings>
  onCatalog: ((name: string, catalog: ServerCatalog) => void) | undefined
  onCatalogRefresh: ((name: string, catalog: ServerCatalog) => void) | undefined
  onStatus: ((name: string) => void) | undefined
  logger: Logger | undefined
  credentials: unknown
  userQuestions: UserQuestionsLike | undefined
  agent: unknown
  /** The session's live directory; see {@link ServerPoolOptions.cwd}. */
  cwdOf: (() => string | undefined) | undefined
  /** name -> { config, connection?, connecting?, reconnectAttempts, timer, state, lastError } */
  servers: Map<string, PoolEntry>

  constructor({ home, cwd, onCatalog, onCatalogRefresh, onStatus, logger, settings, credentials, userQuestions, agent }: ServerPoolOptions) {
    this.home = home
    this.cwdOf = cwd
    this.settings = settings ?? {}
    this.onCatalog = onCatalog
    this.onCatalogRefresh = onCatalogRefresh
    this.onStatus = onStatus
    this.logger = logger
    this.credentials = credentials
    this.userQuestions = userQuestions
    this.agent = agent
    this.servers = new Map()
  }

  /** Declare the servers this pool may run. Safe to call again after a config edit. */
  async configure(entries: Array<{ config: ServerConfig }>): Promise<void> {
    const wanted = new Set(entries.map((entry) => entry.config.name))
    for (const name of [...this.servers.keys()]) {
      if (!wanted.has(name)) await this.remove(name)
    }
    for (const { config } of entries) {
      const existing = this.servers.get(config.name)
      if (existing === undefined) {
        this.servers.set(config.name, { config, connection: undefined, connecting: undefined, reconnectAttempts: 0, timer: undefined, state: 'idle', lastError: undefined })
        continue
      }
      // A changed definition must not keep the old process or the old catalog.
      if (JSON.stringify(existing.config) !== JSON.stringify(config)) {
        await this.close(config.name)
        existing.config = config
        existing.state = 'idle'
      }
    }
  }

  get(name: string): PoolEntry | undefined {
    return this.servers.get(name)
  }

  /**
   * The timeout one server's request gets: its own value, else the settings default, else the
   * constant. The middle rung is why `settings.requestTimeoutMs` exists at all — a user who sets it
   * once should not have to repeat it on every server entry.
   */
  timeoutFor(entry: PoolEntry): number {
    if (entry.config.requestTimeoutMs !== undefined) return entry.config.requestTimeoutMs
    const configured = this.settings.requestTimeoutMs
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REQUEST_TIMEOUT_MS
  }

  /**
   * The timeout one *execution* gets: a tool call, a resource read, or a prompt render.
   *
   * Kept apart from {@link timeoutFor} because one shared value is wrong for one of the two risks.
   * A handshake that takes a minute is a broken server; a tool that drives a browser, runs a build,
   * or exports a report legitimately takes many minutes, and cutting it at the handshake budget
   * turns a working server into "MCP call failed: timed out" (ADR-0011).
   */
  executionTimeoutFor(entry: PoolEntry): number {
    if (entry.config.executionTimeoutMs !== undefined) return entry.config.executionTimeoutMs
    const configured = this.settings.executionTimeoutMs
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_EXECUTION_TIMEOUT_MS
  }

  names(): string[] {
    return [...this.servers.keys()]
  }

  status(): PoolStatus[] {
    return [...this.servers.entries()].map(([name, entry]) => ({
      name,
      state: entry.state,
      hasCatalog: entry.catalog !== undefined,
      lastError: entry.lastError,
      recentStderr: entry.recentStderr,
      lifecycle: entry.config.lifecycle,
    }))
  }

  /** Connect if needed and return the connection. Concurrent callers share one attempt. */
  async ensure(name: string, signal?: AbortSignal): Promise<Connection> {
    const entry = this.servers.get(name)
    if (entry === undefined) throw new Error(`unknown MCP server "${name}"`)
    if (entry.connection !== undefined) {
      entry.connection.lastUsedAt = Date.now()
      return entry.connection
    }
    if (entry.connecting !== undefined) return entry.connecting
    entry.connecting = this.connect(name, entry, signal).finally(() => {
      entry.connecting = undefined
    })
    return entry.connecting
  }

  async connect(name: string, entry: PoolEntry, signal: AbortSignal | undefined): Promise<Connection> {
    const config = entry.config
    entry.state = 'connecting'
    const timeoutMs = this.timeoutFor(entry)
    // Assigned once the connection exists: a notification from a connection that has already been
    // replaced must not rewrite the catalog of the one that replaced it.
    let live: Connection | undefined
    const client = new Client(
      { name: 'dsh-mcp-adapter', version: '0.1.0' },
      clientOptions(config, this.userQuestions, () => {
        if (live !== undefined && entry.connection === live) this.scheduleCatalogRefresh(name, entry)
      }),
    )
    if (config.roots !== false) {
      // The root a server is told is the directory it runs in, so a tool that resolves a relative
      // path and the process itself agree. With no known directory (a session that records none)
      // the honest answer is an empty root list, not the host process' launch directory — that is
      // where `dsh` happened to start, not a workspace.
      const cwd = resolveServerCwd(config, this.cwdOf?.())
      const roots = cwd === undefined ? [] : [{ uri: pathToFileURL(cwd).href, name: basename(cwd) || 'workspace' }]
      try {
        client.setRequestHandler('roots/list', () => ({ roots }))
      } catch {
        // Ignore registration failure on clients that do not support dynamic request handlers
      }
    }
    try {
      registerElicitationHandler(client, {
        serverName: name,
        userQuestions: this.userQuestions,
        agent: this.agent,
      })
    } catch {
      // Ignore registration failure on clients that do not support dynamic request handlers
    }
    let transport: Transport | undefined
    try {
      if (config.transport === 'stdio') {
        const stdio = stdioTransport(config, this.cwdOf?.())
        transport = stdio
        const stderrBuffer: string[] = []
        try {
          stdio.stderr?.on('data', (chunk: unknown) => {
            const lines = String(chunk).split(/\r?\n/)
            for (const line of lines) {
              const trimmed = line.trim()
              if (trimmed.length > 0) {
                stderrBuffer.push(trimmed)
                if (stderrBuffer.length > 15) stderrBuffer.shift()
              }
            }
            entry.recentStderr = [...stderrBuffer]
          })
        } catch {
          // Ignore stream registration failures.
        }
      } else if (config.transport === 'socket') {
        // `loadConfig` refuses a socket entry, so a pooled config cannot be one. This stays as an
        // assertion: if a future caller builds a ServerConfig by hand, the failure names the reason
        // instead of falling into the http branch with an undefined url.
        throw new Error(`server "${name}": unix-socket transports are not supported by dsh-mcp-adapter`)
      } else {
        let url: URL
        try {
          url = new URL(config.url ?? '')
        } catch {
          throw new Error(`server "${name}": invalid url ${JSON.stringify(config.url)}`)
        }
        let resolvedToken = config.bearerToken
        if (this.credentials) {
          resolvedToken = await resolveServerToken(name, this.credentials, config.bearerToken)
        }
        transport = httpTransport(config, url, resolvedToken)
      }
      await withTimeout(client.connect(transport), timeoutMs, `server "${name}" did not finish the MCP handshake in ${timeoutMs} ms`)
    } catch (error) {
      entry.state = 'failed'
      const baseMsg = messageOf(error)
      const stderrSummary = entry.recentStderr && entry.recentStderr.length > 0
        ? ` (stderr: ${entry.recentStderr.slice(-3).join('; ')})`
        : ''
      entry.lastError = `${baseMsg}${stderrSummary}`
      await this.safeClose(client, transport)
      throw error
    }
    const connection = new Connection(client, transport, async () => {
      await this.safeClose(client, transport)
    })
    live = connection
    entry.connection = connection
    entry.state = 'connected'
    entry.lastError = undefined
    entry.reconnectAttempts = 0
    // A keep-alive or lazy-keep-alive server that dies comes back on its own; a lazy or eager one
    // waits for the next call.
    try {
      client.onclose = () => {
        if (entry.connection !== connection) return
        entry.connection = undefined
        entry.state = 'dropped'
        this.onStatus?.(name)
        if (this.reconnects(entry)) this.scheduleReconnect(name, entry)
      }
    } catch {
      // Older SDK clients may not expose onclose; the next call reconnects anyway.
    }
    // Background transport failures (a dropped SSE stream, a rejected frame) are reported only here.
    // Without this the pool kept advertising `connected` while every later request failed.
    client.onerror = (error: Error) => {
      if (entry.connection !== connection) return
      entry.lastError = messageOf(error)
      this.logger?.debug?.(`mcp-adapter: ${name} transport error: ${entry.lastError}`)
    }
    this.onStatus?.(name)
    return connection
  }

  /**
   * Coalesce a burst of list-changed notifications into one catalog read.
   *
   * A server that adds several tools announces each as its own notification, and the SDK hands over
   * three independent `listChanged` subscriptions (tools, prompts, resources); re-reading the whole
   * catalog per notification would fan a startup burst out into dozens of `tools/list` round trips.
   * The read itself is deliberately not awaited: a notification arrives on the SDK's own dispatch
   * path, where a rejection has nowhere to go.
   */
  private scheduleCatalogRefresh(name: string, entry: PoolEntry): void {
    if (entry.changeTimer !== undefined) clearTimeout(entry.changeTimer)
    entry.changeTimer = setTimeout(() => {
      entry.changeTimer = undefined
      const connection = entry.connection
      if (connection === undefined) return
      void this.fetchCatalog(name, entry, connection)
        .then((catalog) => {
          if (entry.connection !== connection) return
          entry.catalog = catalog
          connection.catalog = catalog
          this.onCatalog?.(name, catalog)
          this.onCatalogRefresh?.(name, catalog)
          this.onStatus?.(name)
        })
        .catch((error: unknown) => {
          // A refresh that fails leaves the previous catalog in place; the failure is visible in the
          // panel rather than silently replacing real tools with nothing (ADR-0011, P0-1).
          entry.lastError = messageOf(error)
          this.logger?.debug?.(`mcp-adapter: ${name} catalog refresh failed: ${entry.lastError}`)
          this.onStatus?.(name)
        })
    }, LIST_CHANGED_DEBOUNCE_MS)
    entry.changeTimer.unref?.()
  }

  /**
   * Replace a connection whose session the server no longer recognizes, and return the replacement.
   *
   * The old connection is closed first so its transport cannot keep an SSE stream alive against a
   * session that is already gone. `ensure()` then reconnects through the normal path, which also
   * re-arms `onclose`/`onerror` and re-reads the catalog lazily.
   */
  private async reconnect(stale: Connection, entry: PoolEntry): Promise<Connection> {
    const name = entry.config.name
    this.logger?.warn?.(`mcp-adapter: ${name} lost its MCP session; reconnecting once`)
    if (entry.connection === stale) entry.connection = undefined
    try {
      await stale.close()
    } catch {
      // Already gone; the reconnect below is what matters.
    }
    return this.ensure(name)
  }

  async safeClose(client: Client | undefined, transport: Transport | undefined): Promise<void> {
    try {
      await client?.close?.()
    } catch {
      // The SDK already tore the transport down.
    }
    try {
      await transport?.close?.()
    } catch {
      // Idempotent by contract.
    }
  }

  /** Stop one server and drop its live catalog; the cached one survives. */
  async close(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (entry === undefined) return
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    // A pending catalog refresh belongs to the connection being closed; letting it fire would
    // reopen a server the idle sweep just stopped.
    if (entry.changeTimer !== undefined) {
      clearTimeout(entry.changeTimer)
      entry.changeTimer = undefined
    }
    const connection = entry.connection
    entry.connection = undefined
    entry.state = 'idle'
    if (connection !== undefined) await connection.close()
  }

  async remove(name: string): Promise<void> {
    await this.close(name)
    this.servers.delete(name)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((name) => this.close(name)))
  }

  /**
   * Stop every connection and drop the in-memory state that would otherwise keep the session's
   * catalogs, stderr tails and reconnect timers alive until the session object is collected.
   * `closeAll()` alone intentionally leaves entries readable: `status()` still reports them as
   * idle, and the idle sweep may restart a lazy server. Only a disposed session calls this.
   */
  async dispose(): Promise<void> {
    await this.closeAll()
    for (const entry of this.servers.values()) {
      entry.catalog = undefined
      entry.recentStderr = undefined
      entry.connecting = undefined
      entry.lastError = undefined
      entry.changeTimer = undefined
    }
    this.servers.clear()
  }

  /** Fetch the catalog, from the connection when it is live, from the cache otherwise. */
  async catalog(name: string, { refresh = false }: { refresh?: boolean } = {}): Promise<ServerCatalog> {
    const entry = this.servers.get(name)
    if (entry === undefined) throw new Error(`unknown MCP server "${name}"`)
    if (entry.catalog !== undefined && !refresh) {
      if (entry.connection !== undefined) entry.connection.lastUsedAt = Date.now()
      return entry.catalog
    }
    const connection = await this.ensure(name)
    const catalog = await this.fetchCatalog(name, entry, connection)
    // `entry.catalog` is the effective catalog (live or restored from cache); the connection just
    // holds the copy it fetched, so closing a server does not lose what the model already knows.
    entry.catalog = catalog
    connection.catalog = catalog
    this.onCatalog?.(name, catalog)
    return catalog
  }

  async fetchCatalog(name: string, entry: PoolEntry, connection: Connection): Promise<ServerCatalog> {
    const config = entry.config
    const timeoutMs = this.timeoutFor(entry)
    const options = { timeout: timeoutMs }
    const catalog: ServerCatalog = { tools: [], resources: [], prompts: [], instructions: '' }
    const failures: string[] = []
    const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await run()
      } catch (error) {
        // `Method not found` means the server does not implement that capability, which is normal:
        // a fetch server has tools and nothing else. Only real failures are worth reporting.
        if (!isUnsupportedCapability(error)) failures.push(`${label}: ${messageOf(error)}`)
        return undefined
      }
    }

    const tools = await attempt('tools/list', () => connection.client.listTools(undefined, options))
    // A server that advertises no tools capability answers an empty list without an error, so reaching
    // here with nothing but a recorded failure means `tools/list` really failed. Handing that back as an
    // empty catalog is what used to poison the disk cache: `refreshCatalog()` persisted it, the next
    // session hash-matched it, and the server showed zero tools forever with no path back (ADR-0011).
    // Throwing leaves `entry.catalog` undefined, so the next read retries instead of trusting a failure.
    if (tools === undefined && failures.length > 0) {
      entry.lastError = failures.join('; ')
      throw new Error(`server "${name}" could not list its tools: ${entry.lastError}`)
    }
    // A listing happened on this connection, so the SDK's per-call output-schema validation is armed.
    if (tools !== undefined) connection.toolsListed = true
    for (const tool of tools?.tools ?? []) {
      if (!tool?.name) continue
      catalog.tools.push({
        name: tool.name,
        title: tool.title,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        hasOutputSchema: tool.outputSchema !== undefined,
        annotations: tool.annotations,
      })
    }

    if (config.exposeResources !== false) {
      const resources = await attempt('resources/list', () => connection.client.listResources(undefined, options))
      for (const resource of resources?.resources ?? []) {
        if (!resource?.uri) continue
        catalog.resources.push({ uri: resource.uri, name: resource.name ?? resource.uri, description: resource.description, mimeType: resource.mimeType })
      }
    }

    const prompts = await attempt('prompts/list', () => connection.client.listPrompts(undefined, options))
    for (const prompt of prompts?.prompts ?? []) {
      if (!prompt?.name) continue
      catalog.prompts.push({ name: prompt.name, description: prompt.description, arguments: prompt.arguments ?? [] })
    }

    try {
      const instructions = connection.client.getInstructions?.()
      if (typeof instructions === 'string') catalog.instructions = instructions
    } catch {
      // Instructions are decoration; a server without them is normal.
    }

    if (failures.length > 0) entry.lastError = failures.join('; ')
    return catalog
  }

  /** Start a server and warm its catalog. Used by eager lifecycle and by the first metadata sync. */
  async warm(name: string): Promise<ServerCatalog> {
    const catalog = await this.catalog(name, { refresh: true })
    return catalog
  }

  /** Call one tool. Lazily connects, and records the use for the idle timer. */
  async callTool(name: string, toolName: string, args: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
    const entry = this.servers.get(name)
    if (entry === undefined) throw new Error(`unknown MCP server "${name}"`)
    let connection = await this.ensure(name, signal)
    // The listing that arms output-schema validation is a catalog request; the call itself is an
    // execution, so the two budgets differ.
    const listTimeoutMs = this.timeoutFor(entry)
    await this.ensureOutputSchemaValidation(name, entry, connection, toolName, listTimeoutMs, signal)
    const timeoutMs = this.executionTimeoutFor(entry)
    // `@modelcontextprotocol/client` 2.x dropped the `resultSchema` argument the source still passed,
    // so the per-request options live in the second position; leaving them third would typecheck and
    // silently discard both the timeout and the cancellation signal.
    const run = (target: Connection) => callToolPausingForElicitation(
      target.client,
      { name: toolName, arguments: toolArguments(args) },
      { timeout: timeoutMs, signal },
    )
    let result: unknown
    try {
      result = await run(connection)
    } catch (error) {
      if (!isExpiredSession(error, connection.transport)) throw error
      // The server no longer knows this session. One reconnect and one retry is the whole recovery:
      // a second expiry means the endpoint itself is cycling, which belongs in `lastError`.
      connection = await this.reconnect(connection, entry)
      result = await run(connection)
    }
    connection.lastUsedAt = Date.now()
    return result
  }

  /**
   * Give the SDK the tool list it needs before it will validate a result.
   *
   * The SDK checks `structuredContent` against a tool's declared `outputSchema`, but only from the
   * list it cached during `tools/list`. A server whose catalog was restored from our disk cache is
   * never listed on the fresh connection, so the first call would go unchecked. Verified against
   * `@modelcontextprotocol/client@2.2.0`.
   *
   * Bounded on purpose: only tools that actually declare an `outputSchema` pay for the extra
   * listing, and only once per connection. A failed listing is not fatal — the call may still
   * succeed, and failing it here would turn an unreadable catalog into a broken server.
   *
   * Our catalog keeps only a presence flag (`hasOutputSchema`), never the schema itself: the SDK
   * validates from its own `tools/list` cache, so the full schema would just inflate the disk cache.
   */
  private async ensureOutputSchemaValidation(
    name: string,
    entry: PoolEntry,
    connection: Connection,
    toolName: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (connection.toolsListed) return
    const declared = entry.catalog?.tools.find((tool) => tool.name === toolName)
    if (declared?.hasOutputSchema !== true) return
    try {
      await connection.client.listTools(undefined, { timeout: timeoutMs, signal })
    } catch (error) {
      this.logger?.debug?.(`mcp-adapter: ${name} could not list tools before a call: ${messageOf(error)}`)
    }
    connection.toolsListed = true
  }

  async readResource(name: string, uri: string, { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
    const entry = this.servers.get(name)
    if (entry === undefined) throw new Error(`unknown MCP server "${name}"`)
    const timeoutMs = this.executionTimeoutFor(entry)
    let connection = await this.ensure(name)
    const run = (target: Connection) => target.client.readResource({ uri }, { timeout: timeoutMs, signal })
    try {
      return await run(connection)
    } catch (error) {
      if (!isExpiredSession(error, connection.transport)) throw error
      connection = await this.reconnect(connection, entry)
      return await run(connection)
    }
  }

  async getPrompt(name: string, promptName: string, args: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
    const entry = this.servers.get(name)
    if (entry === undefined) throw new Error(`unknown MCP server "${name}"`)
    const timeoutMs = this.executionTimeoutFor(entry)
    let connection = await this.ensure(name)
    const run = (target: Connection) => target.client.getPrompt({ name: promptName, arguments: promptArguments(args) }, { timeout: timeoutMs, signal })
    try {
      return await run(connection)
    } catch (error) {
      if (!isExpiredSession(error, connection.transport)) throw error
      connection = await this.reconnect(connection, entry)
      return await run(connection)
    }
  }

  /**
   * Lifecycle semantics, in one place so the sweep and the reconnect agree.
   *
   * - `lazy` (default): start on first use, stop after the idle timeout.
   * - `lazy-keep-alive`: start on first use, then behave like `keep-alive` — never stopped for
   *   idleness, and reconnected when it drops. This is what a stateful server needs, and the mode
   *   used to be indistinguishable from `lazy`.
   * - `keep-alive`: started with the session, never stopped for idleness, reconnected.
   * - `eager`: started with the session, not reconnected, and stopped only when the server entry
   *   sets its own `idleTimeout`.
   */
  private neverIdles(entry: PoolEntry): boolean {
    const lifecycle = entry.config.lifecycle
    if (lifecycle === 'keep-alive' || lifecycle === 'lazy-keep-alive') return true
    // `eager` is not exempt when the entry asked for a timeout explicitly.
    return lifecycle === 'eager' && entry.config.idleTimeout === undefined
  }

  private reconnects(entry: PoolEntry): boolean {
    const lifecycle = entry.config.lifecycle
    return lifecycle === 'keep-alive' || lifecycle === 'lazy-keep-alive'
  }

  /** Whether a server should be running before anything asked for it. */
  warmsAtStartup(entry: PoolEntry): boolean {
    return entry.config.lifecycle === 'eager' || entry.config.lifecycle === 'keep-alive'
  }

  /** Start every server whose lifecycle says it should already be up. */
  async warmEager(): Promise<void> {
    const eager = [...this.servers.values()].filter((entry) => this.warmsAtStartup(entry) && entry.connection === undefined)
    await Promise.all(eager.map(async (entry) => {
      try {
        await this.warm(entry.config.name)
        this.onStatus?.(entry.config.name)
      } catch (error) {
        entry.lastError = messageOf(error)
        this.logger?.warn?.(`mcp-adapter: ${entry.config.name} could not start: ${messageOf(error)}`)
      }
    }))
  }

  /** Stop every lazy server that has been idle past its timeout. Keeps untouched servers alone. */
  async sweepIdle(settings: AdapterSettings): Promise<void> {
    const now = Date.now()
    for (const [name, entry] of this.servers) {
      if (entry.connection === undefined) continue
      if (this.neverIdles(entry)) continue
      // A per-server 0 means "never stop this one"; only an absent value consults the default.
      const minutes = entry.config.idleTimeout === undefined ? settings.idleTimeout : entry.config.idleTimeout
      if (!Number.isFinite(minutes) || minutes <= 0) continue
      const timeoutMs = minutes * 60_000
      if (now - entry.connection.lastUsedAt < timeoutMs) continue
      await this.close(name)
      this.logger?.debug?.(`mcp-adapter: ${name} stopped after ${minutes} min idle`)
    }
  }

  /**
   * Reconnect a keep-alive server that dropped. Backoff doubles per consecutive failure, capped.
   * A recovered connection re-reads its catalog, because a restarted server may have new tools.
   */
  scheduleReconnect(name: string, entry: PoolEntry, retry: () => void = () => this.scheduleReconnect(name, entry)): void {
    if (entry.timer !== undefined) return
    const attempt = entry.reconnectAttempts
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
    entry.reconnectAttempts += 1
    entry.timer = setTimeout(async () => {
      entry.timer = undefined
      if (entry.connection !== undefined || this.servers.get(name) !== entry) return
      try {
        await this.warm(name)
        this.onStatus?.(name)
      } catch (error) {
        entry.lastError = messageOf(error)
        retry()
      }
    }, delay)
    entry.timer.unref?.()
  }
}
