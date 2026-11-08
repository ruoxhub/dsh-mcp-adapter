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
  /**
   * The working directory the entry asked for, exactly as its config file wrote it.
   *
   * Absent unless the file declared one, and never filled in from the session directory here: this
   * field is part of *what runs*, so it enters `definitionHash`, and defaulting it would make one
   * user-global server hash differently in every workspace — its approval and its cached catalog
   * would then belong to whichever folder happened to load it, and two workspaces would evict each
   * other's entry. A relative value stays relative for the same reason: it means "inside whatever
   * directory the session is in", which only the pool knows at connect time. `ServerPool` resolves
   * it against its own `cwd` when it spawns the server.
   */
  cwd?: string
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
  roots?: boolean
  requestHeadersCommand?: HttpRequestHeadersCommand
  description?: string
  toolPrefix?: string
  httpTransport?: string
  protocolVersion?: unknown
  debug: boolean
  /** Only the "disabled" early return sets this; no other entry carries it. */
  disabled?: true
}

export interface HttpRequestHeadersCommand {
  command: string
  args?: string[]
  env?: Record<string, string>
  timeoutMs?: number
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
  /** Whether the server declared an output schema. The schema itself is never retained: the SDK
   * validates results from its own `tools/list` cache, so keeping a copy only inflates the persisted
   * catalog by megabytes. */
  hasOutputSchema: boolean
  annotations?: ToolAnnotations
  keywords: string[]
  /** Lowercased names, description, keywords and the parameter summary, computed once by
   * `buildCatalog`. Optional so hand-built catalogs still work; `searchTools` derives them on the
   * fly when absent. */
  search?: CatalogToolSearchFields
}

/** Fields `searchTools` needs in lowercase, precomputed at catalog build time. */
export interface CatalogToolSearchFields {
  name: string
  originalName: string
  server: string
  description: string
  normalizedName: string
  keywords: string[]
  parameters: string | null
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
 * the MCP tool and defaults the description; `inputSchema` stays `unknown` because it is the
 * server's own JSON Schema, passed through untouched. `outputSchema` is reduced to a presence flag:
 * the SDK validates results from its own `tools/list` cache and never reads our copy.
 */
export interface ServerTool {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  hasOutputSchema?: boolean
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
  headers?: Record<string, string>
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  protocolVersion?: string
  description?: string
  status?: 'ready' | 'starting' | 'error' | 'blocked' | 'idle'
  /**
   * The entry exactly as it sits in the config file, unknown fields included.
   *
   * `McpServerDetail` is a normalized view: it drops anything it does not model (`type`,
   * `caFile`, `httpTransport`, future keys). Copying a server out of the panel has to be lossless,
   * so the panel reads this instead of rebuilding an approximation.
   */
  raw?: Record<string, unknown>
}

/** Connection probe result for stdio or HTTP MCP endpoints. */
export interface ProbeResult {
  ok: boolean
  latencyMs?: number
  error?: string
  /** Tools the server answered tools/list with. Present only after a successful handshake. */
  toolCount?: number
}

/** External AI coding tool sources supported for MCP configuration scanning. */
export type McpSourceKind =
  | 'claude-desktop'
  | 'claude-code'
  | 'cursor-global'
  | 'cursor-project'
  | 'codex'
  | 'vscode'
  | 'opencode'
  | 'chatgpt-desktop'
  | 'agents-servers'

/** One candidate MCP server found in an external tool's config. */
export interface ExternalMcpCandidate {
  source: McpSourceKind
  sourcePath: string
  id: string
  rawKey: string
  label?: string
  description?: string
  transport: 'stdio' | 'http' | 'socket'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
  warnings?: string[]
}

/** Report of scan status for a single external source config file/directory. */
export interface ExternalMcpSourceReport {
  kind: McpSourceKind
  path: string
  exists: boolean
  error?: string
  count: number
}

/** Result of scanning all external tool locations. */
export interface ExternalMcpScanResult {
  candidates: ExternalMcpCandidate[]
  sources: ExternalMcpSourceReport[]
}

/** High-level categories for curated MCP catalog. */
export type McpCatalogCategory =
  | 'devtools'
  | 'web'
  | 'docs'
  | 'data'
  | 'productivity'

/** A rich curated MCP catalog entry for the Market view. */
export interface McpCatalogEntry {
  id: string
  name: string
  description: string
  author?: string
  homepage?: string
  categories: McpCatalogCategory[]
  verified?: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
  requiredEnv?: Array<{
    name: string
    description?: string
    defaultValue?: string
  }> | string[]
  notes?: string
}


