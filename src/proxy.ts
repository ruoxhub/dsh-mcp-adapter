// The `mcp` proxy tool: one tool in context instead of hundreds.
//
// Modes, matching pi-mcp-adapter's surface:
//   mcp({})                          status: servers, connection state, tool counts
//   mcp({ server })                  one server's tools and instructions
//   mcp({ search })                  ranked search over the cached catalog
//   mcp({ describe })                full schema of one tool
//   mcp({ instructions: server })    the server's usage guidance
//   mcp({ connect: server })         start a server and refresh its catalog
//   mcp({ tool, args })              call a tool (connects lazily)
//
// The tool never holds state: it reads the Agent's session, so a web search and a direct call see
// the same catalog.

import { describeTool, formatSearchPage, searchTools, summarizeParameters } from './catalog.ts'
import { flattenPromptResult } from './prompts.ts'
import type { PoolEntry, PoolStatus } from './servers.ts'
import type { Catalog, CatalogTool, ContentBlock, ServerCatalog, ToolRunLike } from './types.ts'
import { boundedText, extractFields, projectResult, spillOutput } from './util.ts'

export const PROXY_TOOL_NAME = 'mcp'

/** One argument mode: a single property schema, described because each mode is a different call. */
interface ProxyParameter {
  type: 'string' | 'boolean' | 'integer' | 'object' | 'array'
  description: string
  items?: { type: string }
  additionalProperties?: boolean
}

/**
 * The `mcp` tool's argument schema, as `ToolDefinition.parameters` receives it.
 *
 * The root is an object schema, never a bare property map: `ctx.tools.register` forwards
 * `parameters` to the model provider untouched, and the provider refuses a root without
 * `type: "object"` with `schema must be a JSON Schema of 'type: "object"', got 'type: null'` —
 * which fails every request in the session, not just this tool. Every property stays optional
 * because each mode is a different call.
 */
export const PROXY_PARAMETERS: { type: 'object'; properties: Record<string, ProxyParameter>; additionalProperties: false } = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string', description: "Tool name to call, exactly as mcp({ search }) lists it (e.g. 'chrome_devtools_take_screenshot')" },
    args: {
      type: 'object',
      additionalProperties: true,
      description: 'Arguments for the tool, as a JSON object. Omit when the tool takes none.',
    },
    extract: {
      type: 'array',
      items: { type: 'string' },
      description: 'Field names or dot-paths to extract from the result (e.g. ["items", "total"]). Leaves out unrequested fields to save context.',
    },
    server: { type: 'string', description: 'Server name: filters a search, disambiguates a call or describe, or lists one server' },
    search: { type: 'string', description: 'Search MCP tools by name and description' },
    regex: { type: 'boolean', description: 'Treat `search` as a regular expression' },
    includeSchemas: { type: 'boolean', description: 'Include a parameter summary in search results (default true)' },
    limit: { type: 'integer', description: 'Maximum search results (default 12)' },
    offset: { type: 'integer', description: 'Search result offset for paging (default 0)' },
    describe: { type: 'string', description: 'Tool name whose full parameters and description to return' },
    instructions: { type: 'string', description: 'Server name whose MCP instructions to return' },
    connect: { type: 'string', description: 'Server name to start and refresh' },
    resources: { type: 'string', description: 'Server name whose MCP resources to list' },
    read: { type: 'string', description: 'Resource URI to read; requires `server`' },
    prompt: { type: 'string', description: 'Prompt template name to render; requires `server`' },
  },
}

export const PROXY_DESCRIPTION = [
  'Use MCP servers; this is how MCP tools are reached.',
  'No argument lists every server with its state and tool count.',
  'search:"screenshot" finds tools by name or description, describe:"<name>" returns one tool\'s full parameters,',
  'and tool:"<name>" with args:{...} calls it — the server starts then if it was stopped.',
  'extract:["field"] projects specific fields from the tool result to save context tokens.',
  "resources:\"<server>\" lists a server's documents, read:\"<uri>\" with server reads one, and prompt:\"<name>\" renders a prompt template.",
  'One search and one call is cheaper than loading every tool definition up front.',
].join(' ')

/** What a proxy tool result carries: the model-facing blocks, plus the canonical MCP value. */
export interface ProxyResult {
  content: ContentBlock[]
  value?: unknown
}

/**
 * The slice of the Agent's session this tool reads.
 *
 * Declared structurally instead of importing `McpSession`, which `session.ts` creates in a later
 * task and which imports this module back. Task 9's class satisfies this shape as written; if the
 * two ever drift, `session.ts` fails to compile at the `createProxyExecutor` call, not silently.
 *
 * `pool` is the seven methods the modes touch, spelled with `ServerPool`'s own return types so the
 * pool is checked against the real implementation.
 */
export interface ProxySession {
  /** The model-facing catalog, read for tool lookup, resources, and status counts. */
  catalog: Catalog
  /** Servers this project mounted, plus the history the pool keeps for each. */
  pool: {
    get: (name: string) => Pick<PoolEntry, 'config'> | undefined
    names: () => string[]
    catalog: (name: string) => Promise<ServerCatalog>
    warm: (name: string) => Promise<ServerCatalog>
    status: () => PoolStatus[]
    readResource: (name: string, uri: string) => Promise<unknown>
    getPrompt: (name: string, promptName: string, args: unknown) => Promise<unknown>
  }
  /** Servers held back by the project-trust gate, as the status listing reports them. */
  blocked?: Array<{ name: string; reason: string }>
  /** Config problems worth telling the model about. */
  errors?: string[]
  /** Warm every catalog that is still cold, then return the current one. */
  refreshCatalog: () => Promise<Catalog>
  /** The one gated call path: approval applied, then dispatch. */
  callApproved: (toolName: string, args: unknown, exec: ToolRunLike | undefined) => Promise<unknown>
  /**
   * Make the direct tools a search matched callable; returns the ones it activated.
   *
   * `directTools: 'search'` registers its tools inactive, and this is the only thing that ever turns
   * them on — without the call the mode is unusable: the tool refuses with "call mcp({ search })" and
   * the search itself activates nothing, so the same refusal repeats forever.
   */
  activateMatches: (query: string) => string[]
  /**
   * Whether any direct tools are registered. `activateMatches` rescans the whole catalog, so a
   * default session (`directTools: false`) skips it entirely. Omitted reads as `true` so a host
   * that does not know keeps the activation behaviour.
   */
  hasDirectTools?: () => boolean
  /** Adapter state directory where spill files are stored. */
  home?: string
  /** Maximum character length of tool output before spilling to disk. */
  maxOutputChars?: number
  /**
   * Host spill backend (`ctx.spillStore`), when the composition has one.
   *
   * Present means the host owns where a spill lands, what it is called, and when it expires; absent
   * means this adapter falls back to its own file under `home`. Read as an optional capability so a
   * composition without `dsh-spill-local` still spills instead of failing.
   */
  spillStore?: SpillStoreLike
  /**
   * Whether one server's `structuredContent` is shown alongside its `content`.
   *
   * Optional so a test can omit it; undefined reads as `true`, the MCP default.
   */
  appendStructuredContent?: (server: string) => boolean
  /** The owning session id, which a host-side spill record is grouped by. */
  sessionId?: string
}

/**
 * The slice of `ctx.spillStore` this module uses.
 *
 * Declared structurally so this pure-logic module needs no DSH import; the real service satisfies it.
 * `saveText` rejects on a real storage failure, which the caller must degrade rather than propagate.
 */
export interface SpillStoreLike {
  saveText: (request: {
    owner: { sessionId: string }
    source: { kind: 'tool'; toolName: string; callId?: string; label: string }
    suggestedName: string
    content: string
  }) => Promise<{ locator: string; bytes: number; retrievalHint: string }>
}

/**
 * Build the execute body for the proxy tool.
 * @param getSession - returns the Agent's session (server pool + catalog) or undefined.
 */
export function createProxyExecutor(
  getSession: () => ProxySession | undefined,
): (args: Record<string, unknown>, exec: ToolRunLike | undefined) => Promise<ProxyResult> {
  return async (args = {}, exec) => {
    const session = getSession()
    if (session === undefined) return { content: [{ type: 'text', text: 'MCP is not initialized for this session yet.' }] }

    if (typeof args.describe === 'string' && args.describe.length > 0) {
      await session.refreshCatalog()
      return text(describeTool(session.catalog, args.describe))
    }

    if (typeof args.search === 'string') {
      await session.refreshCatalog()
      const page = searchTools(session.catalog, args.search, {
        limit: integerAtLeast(args.limit, 1) ?? 12,
        offset: integerAtLeast(args.offset, 0) ?? 0,
        regex: args.regex === true,
        includeSchemas: args.includeSchemas !== false,
        server: typeof args.server === 'string' ? args.server : undefined,
      })
      // A search is also the activation gesture: `directTools: 'search'` hides its tools until one
      // matches, and this is the only call that ever unhides them. It runs regardless of paging, so
      // a match on page two still becomes callable. When no direct tools are registered the second
      // full-catalog scan in activateMatches is a pure no-op, so skip it.
      if (session.hasDirectTools?.() !== false) session.activateMatches(args.search)
      return text(formatSearchPage(page, args.search))
    }

    if (typeof args.instructions === 'string') {
      const entry = session.pool.get(args.instructions)
      if (entry === undefined) return text(`No MCP server named "${args.instructions}".`)
      const catalog = await session.pool.catalog(args.instructions)
      return text(catalog.instructions || `Server "${args.instructions}" provides no instructions.`)
    }

    if (typeof args.connect === 'string') {
      const entry = session.pool.get(args.connect)
      if (entry === undefined) return text(`No MCP server named "${args.connect}".`)
      const catalog = await session.pool.warm(args.connect)
      await session.refreshCatalog()
      return text(`Connected "${args.connect}": ${catalog.tools.length} tool(s), ${catalog.resources.length} resource(s), ${catalog.prompts.length} prompt(s).`)
    }

    if (typeof args.server === 'string' && args.tool === undefined && args.read === undefined && args.prompt === undefined) {
      await session.refreshCatalog()
      return text(await describeServer(session, args.server))
    }

    if (typeof args.resources === 'string') {
      const catalog = await session.pool.catalog(args.resources)
      if (catalog.resources.length === 0) return text(`Server "${args.resources}" exposes no resources.`)
      const lines = [`Resources from "${args.resources}":`]
      for (const resource of catalog.resources) {
        lines.push(`- ${resource.uri}${resource.name && resource.name !== resource.uri ? ` (${resource.name})` : ''}${resource.mimeType ? ` [${resource.mimeType}]` : ''} — ${resource.description ?? ''}`.trimEnd())
      }
      lines.push('', `Read one with mcp({ server: "${args.resources}", read: "<uri>" }).`)
      return text(lines.join('\n'))
    }

    if (typeof args.read === 'string') {
      const server = typeof args.server === 'string' ? args.server : undefined
      if (server === undefined) {
        const owners = [...session.catalog.resources.values()].filter((resource) => resource.uri === args.read)
        if (owners.length === 0) return text(`No known resource with URI "${args.read}". Use mcp({ resources: "<server>" }) first.`)
        return readResource(session, owners[0].server, args.read)
      }
      return readResource(session, server, args.read)
    }

    if (typeof args.prompt === 'string') {
      const server = typeof args.server === 'string' ? args.server : undefined
      if (server === undefined) return text('mcp({ prompt }) needs a server name: mcp({ server: "<name>", prompt: "<name>", args: {...} })')
      const catalog = await session.pool.catalog(server)
      const definition = catalog.prompts.find((prompt) => prompt.name === args.prompt)
      if (definition === undefined) return text(`Server "${server}" has no prompt named "${args.prompt}".`)
      const result = await session.pool.getPrompt(server, args.prompt, normalizeArgs(args.args))
      return text(flattenPromptResult(result))
    }

    if (typeof args.tool === 'string' && args.tool.length > 0) {
      const extract = Array.isArray(args.extract)
        ? args.extract.filter((item): item is string => typeof item === 'string')
        : typeof args.extract === 'string' && args.extract.trim().length > 0
          ? [args.extract.trim()]
          : undefined
      return callTool(session, args.tool, normalizeArgs(args.args), args.server, exec, extract)
    }

    await session.refreshCatalog()
    return text(statusText(session))
  }
}

/**
 * The source's `Number.isInteger(value) && value > 0` guard, which cannot typecheck directly on an
 * `unknown` argument map. `Number.isInteger` accepts only real numbers, so the `typeof` test here
 * admits and rejects exactly the values the source's comparison did.
 */
function integerAtLeast(value: unknown, minimum: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) return undefined
  return value
}

/** `args` may arrive as an object or as a JSON string; the string form is for providers that need it. */
function normalizeArgs(raw: unknown): unknown {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) return {}
    try {
      return JSON.parse(raw)
    } catch (error) {
      throw new Error(`args is not valid JSON: ${messageOf(error)}`)
    }
  }
  return raw
}

/**
 * Spill oversized text blocks, preferring the host's spill store over this adapter's own file.
 *
 * Why the host wins: `dsh-spill-local` already owns where artifacts land, how they are named, and
 * when they expire, and the same session may have other plugins spilling through it. Writing our own
 * `<home>/spill/*.txt` alongside that is a second retention policy nobody reconciles.
 *
 * Every failure degrades rather than throws: a storage problem must not turn a successful MCP call
 * into an error. A rejecting `saveText` falls back to the local file, and a failing local write falls
 * back to a bounded inline text — which is what the pre-existing path did anyway.
 * @param session - the Agent's session, read for the spill store, home directory and cap.
 * @param blocks - the projected result blocks, mutated in place.
 * @param label - the tool name recorded on the spill, for the model's own reference.
 */
async function spillOversized(session: ProxySession, blocks: ContentBlock[], label: string): Promise<void> {
  const home = session.home ?? process.cwd()
  const maxOutputChars = session.maxOutputChars ?? 40_000
  const store = session.spillStore
  const sessionId = session.sessionId
  for (const block of blocks) {
    if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length <= maxOutputChars) continue
    const content = block.text
    if (store !== undefined && sessionId !== undefined) {
      try {
        const ref = await store.saveText({
          owner: { sessionId },
          source: { kind: 'tool', toolName: label, label: 'result' },
          suggestedName: `${label.replace(/[^A-Za-z0-9_-]+/g, '_')}.txt`,
          content,
        })
        block.text = [
          `[Notice: tool output exceeded ${maxOutputChars} characters (${content.length} chars); the full text was saved.]`,
          ref.retrievalHint,
          '',
          content.slice(0, 2_000),
          '',
          `... [rest of output omitted, see ${ref.locator}]`,
        ].join('\n')
        continue
      } catch {
        // Fall through to the local file: the host store is unavailable for this call, not fatal.
      }
    }
    block.text = spillOutput(content, { home, maxOutputChars }).text
  }
}

async function callTool(session: ProxySession, name: string, args: unknown, serverHint: unknown, exec: ToolRunLike | undefined, extract?: string[]): Promise<ProxyResult> {
  await session.refreshCatalog()
  // The hint is forwarded raw, as the source does: only `undefined` means "no hint", so a
  // JSON-reachable `null`/`0`/`false`/`[]`/`{}` matches no server and the tool is not called.
  const tool: CatalogTool | undefined = session.catalog.tools.get(name)
    ?? [...session.catalog.tools.values()].find((candidate) => candidate.originalName === name && (serverHint === undefined || candidate.server === serverHint))
  if (tool === undefined) {
    return text(describeTool(session.catalog, name))
  }
  const showStructured = session.appendStructuredContent?.(tool.server) !== false
  try {
    // `callApproved` applies the approval gate, so a proxy call and a direct call cannot diverge.
    // The execution context arrives as an argument rather than through a field on the session: two
    // overlapping calls would otherwise bind whichever callId and cancellation signal were assigned
    // last, so one call's approval could be audited under another's id (ADR-0011).
    const rawResult = await session.callApproved(tool.name, args, exec)
    if (reportsError(rawResult)) return errorResult(projectResult(rawResult, showStructured))

    const result = extract && extract.length > 0 ? extractFields(rawResult, extract) : rawResult
    const blocks = projectResult(result, showStructured)
    await spillOversized(session, blocks, tool.originalName)

    return { content: blocks, value: result }
  } catch (error) {
    return errorResult([{ type: 'text', text: `MCP call failed: ${messageOf(error)}` }])
  }
}

async function describeServer(session: ProxySession, name: string): Promise<string> {
  const entry = session.pool.get(name)
  if (entry === undefined) return `No MCP server named "${name}". Known servers: ${session.pool.names().join(', ') || '(none)'}`
  const catalog = await session.pool.catalog(name)
  const config = entry.config
  const lines = [`Server "${name}" — ${catalog.tools.length} tool(s), ${catalog.resources.length} resource(s), ${catalog.prompts.length} prompt(s).`]
  if (config.description) lines.push(config.description)
  if (catalog.instructions) lines.push('', 'Instructions:', boundedText(catalog.instructions, 4 * 1024))
  if (catalog.tools.length > 0) {
    lines.push('', 'Tools:')
    for (const tool of catalog.tools) {
      const params = summarizeParameters(tool.inputSchema)
      lines.push(`- ${tool.name}${params ? `(${params})` : '()'} — ${tool.description || '(no description)'}`)
    }
  }
  return lines.join('\n')
}

/** Read one resource and render it as text; binary payloads stay described, never inlined. */
async function readResource(session: ProxySession, server: string, uri: string): Promise<ProxyResult> {
  try {
    const response = await session.pool.readResource(server, uri)
    // The source's `Array.isArray(result?.contents) ? result.contents : []`; the annotation keeps
    // `Array.isArray`'s `any[]` narrowing from escaping this line.
    const contents: unknown[] = isObjectLike(response) && Array.isArray(response.contents) ? response.contents : []
    const blocks: ContentBlock[] = []
    for (const item of contents) {
      const block = isObjectLike(item) ? item : undefined
      if (typeof block?.text === 'string') blocks.push({ type: 'text', text: block.text })
      else if (typeof block?.blob === 'string') blocks.push({ type: 'text', text: `[binary ${block.mimeType ?? 'resource'} — ${Math.round((block.blob.length * 3) / 4)} bytes omitted]` })
      else blocks.push({ type: 'text', text: JSON.stringify(item) })
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '(the resource was empty)' })
    await spillOversized(session, blocks, 'resource')

    return { content: blocks }
  } catch (error) {
    return errorResult([{ type: 'text', text: `reading ${uri} failed: ${messageOf(error)}` }])
  }
}

function statusText(session: ProxySession): string {
  const statuses = session.pool.status()
  if (statuses.length === 0) return 'No MCP servers are configured for this project.'
  const lines = ['MCP servers:']
  for (const status of statuses) {
    const tools = session.catalog.tools.size > 0
      ? [...session.catalog.tools.values()].filter((tool) => tool.server === status.name).length
      : 0
    lines.push(`- ${status.name}: ${status.state}, ${tools} tool(s)${status.lastError ? ` — ${status.lastError}` : ''}`)
  }
  for (const blocked of session.blocked ?? []) lines.push(`- ${blocked.name}: blocked — ${blocked.reason}`)
  for (const problem of session.errors ?? []) lines.push(`- problem: ${problem}`)
  lines.push('', 'mcp({ search: "..." }) to find a tool, mcp({ tool: "...", args: {} }) to call one.')
  return lines.join('\n')
}

function text(body: string): ProxyResult {
  return { content: [{ type: 'text', text: boundedText(body) }] }
}

function errorResult(blocks: ContentBlock[]): ProxyResult {
  return { content: blocks.map((block) => (block.type === 'text' ? { ...block, text: `Error: ${block.text}` } : block)) }
}

/**
 * `result?.isError === true` for a value that may be anything.
 *
 * Every JSON-reachable MCP result is covered: an object (arrays included) has `isError` read, and a
 * primitive or null yields false exactly where the source's optional chain yields undefined.
 */
function reportsError(result: unknown): boolean {
  return isObjectLike(result) && result.isError === true
}

/** An object-shaped value, arrays included. */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `String(error?.message ?? error)`, without reading a property off a primitive. */
function messageOf(error: unknown): string {
  if (isObjectLike(error) && error.message !== undefined && error.message !== null) return String(error.message)
  return String(error)
}
