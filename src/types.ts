// Cross-module interfaces. Pure declarations: this file imports nothing, so every module can
// depend on it without creating a cycle.

/**
 * One normalized server definition, exactly as `normalizeEntry` returns it.
 *
 * The shape is deliberately flat instead of a discriminated union on `transport`: the source
 * builds one object literal and later modules read fields across variants (`config.transport`,
 * `config.url`, `config.socket`), so per-variant required fields would force casts everywhere.
 */
export interface ServerConfig {
  name: string
  transport: 'stdio' | 'http' | 'socket'
  /** Present for stdio and for a `command` given alongside `url`/`socket`. */
  command?: string
  args: string[]
  env: Record<string, string>
  inheritEnv: boolean
  cwd: string
  url?: string
  socket?: string
  headers: Record<string, string>
  caFile?: string
  auth?: 'oauth' | 'bearer' | false
  /**
   * `false` is a real value: `normalizeEntry` copies it through to switch OAuth off. Everything
   * object-shaped (arrays included) passes the source's `typeof === 'object'` test verbatim, so the
   * declared type stays `object` instead of claiming every pass-through is a string-keyed record.
   */
  oauth?: object | false
  /** Filled from either `bearerToken` or `bearerTokenEnv`; only this normalized field carries it. */
  bearerToken?: string
  /**
   * A raw-config spelling `normalizeEntry` accepts: it resolves the named environment variable into
   * `bearerToken` and does not copy this field onto the returned object, so a normalized config
   * normally has it undefined.
   */
  bearerTokenEnv?: string
  lifecycle: 'lazy' | 'keep-alive' | 'lazy-keep-alive' | 'eager'
  idleTimeout?: number
  requestTimeoutMs?: number
  directTools: boolean | 'search' | string[]
  includeTools?: string[]
  excludeTools?: string[]
  /**
   * Per-server search keywords. The source accepts anything `typeof === 'object'` (arrays
   * included) and `keywordsFor` re-checks the shape, so this stays object-shaped, not a map.
   */
  searchKeywords?: object
  /**
   * Intended values are `true`, `'destructive'`, or a list of tool names, but the source copies any
   * non-`undefined` value straight from the file, so a hand-written config can put anything here.
   * `needsApproval` re-checks the shape at use time; the type states the pass-through honestly.
   */
  approveTools?: unknown
  /** Intended values are `true` or a list; the source passes any non-`false` value straight through. */
  autoApprove?: unknown
  exposeResources: boolean
  appendStructuredContent: boolean
  description?: string
  toolPrefix?: string
  httpTransport?: string
  protocolVersion?: unknown
  debug: boolean
  /** Only the "disabled" early return sets this; no other entry carries it. */
  disabled?: true
}

/** The only block shape this adapter emits: images and resources become text descriptions. */
export interface ContentBlock {
  type: 'text'
  text: string
}

/** The hints the adapter reads off an MCP tool; anything else on the server's object is ignored. */
export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** One tool as the model sees it: prefixed name, plus the server's own metadata. */
export interface CatalogTool {
  name: string
  server: string
  originalName: string
  description: string
  inputSchema: unknown
  outputSchema: unknown
  annotations?: ToolAnnotations
  keywords: string[]
}

/** One MCP resource, keyed by its prefixed name. */
export interface CatalogResource {
  name: string
  server: string
  uri: string
  description: string
  mimeType?: string
}

/** One MCP prompt, keyed by `server:name`. */
export interface CatalogPrompt {
  server: string
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

/**
 * One tool exactly as a server reports it, before prefixing. `fetchCatalog` copies these fields off
 * the MCP tool and defaults the description; the schemas stay `unknown` because they are the
 * server's own JSON Schema, passed through untouched.
 */
export interface ServerTool {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  annotations?: ToolAnnotations
}

/** One resource exactly as a server reports it, before prefixing. */
export interface ServerResource {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/** One prompt exactly as a server reports it; `buildCatalog` re-keys it by `server:name`. */
export interface ServerPrompt {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

/**
 * One server's raw catalog: what `fetchCatalog` builds, what `buildCatalog` consumes, and what the
 * cache persists. Filtering and name prefixing happen after this point, so the entries still carry
 * the server's own names.
 */
export interface ServerCatalog {
  tools: ServerTool[]
  resources: ServerResource[]
  prompts: ServerPrompt[]
  instructions: string
}

/** The whole catalog: server name and tool metadata, after filters and name prefixing. */
export interface Catalog {
  tools: Map<string, CatalogTool>
  resources: Map<string, CatalogResource>
  prompts: Map<string, CatalogPrompt>
}

/**
 * The slice of a dsh tool execution this adapter reads: the call id for the approval audit and the
 * signal for cancellation. Declared structurally so the modules that forward it need no cordis or
 * dsh-tools dependency; the real `ToolRunContext` satisfies it.
 */
export interface ToolRunLike {
  callId?: string
  signal?: AbortSignal
}

/** One search hit; `parameters` is the compact summary, not the JSON Schema. */
export interface SearchItem {
  name: string
  server: string
  description: string
  parameters?: string | null
  annotations?: ToolAnnotations
}

/** One page of ranked search results. `error` is set only for an invalid `regex` query. */
export interface SearchPage {
  items: SearchItem[]
  total: number
  hasMore: boolean
  nextOffset: number | null
  error?: string
}

/** Config scope: user-global or workspace-local. */
export type Scope = 'user' | 'workspace'

/** Standardized server details for sidebar panel and management service. */
export interface McpServerDetail {
  name: string
  scope: Scope
  category: string
  transport: 'stdio' | 'http' | 'socket'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  protocolVersion?: string
  description?: string
  status?: 'ready' | 'starting' | 'error' | 'blocked' | 'idle'
}

/** Connection probe result for stdio or HTTP MCP endpoints. */
export interface ProbeResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

