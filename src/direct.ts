// Direct tools: promote selected MCP tools out of the proxy and into the model's own tool list.
//
// `directTools` is off by default, because that is the whole point of the proxy — a server with 40
// tools should not put 40 definitions in every request. When a project wants a few tools first
// class, this registers them; `directTools: "search"` registers them hidden and lets a search
// activate them, which is the middle path pi-mcp-adapter offers.

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CatalogTool, ServerConfig, ToolRunLike } from './types.ts'
import { projectResult } from './util.ts'

/** Which of one server's tools should be exposed directly. */
export interface DirectToolsSelection {
  /** Prefixed tool names to register. */
  names: string[]
  /** The subset that starts inactive until a search activates it. */
  hidden: Set<string>
}

/**
 * Which of one server's tools should be exposed directly.
 *
 * `config` is the normalized `ServerConfig`, whose `directTools` is already coerced by
 * `normalizeEntry` to `boolean | 'search' | string[]`. `settings` is widened to `unknown` because the
 * settings layer is merged from file values that `config.ts` copies without validating, so `null`
 * and other out-of-domain values really arrive there.
 * @param config - the normalized server entry, read for its own `directTools`.
 * @param entries - that server's built catalog entries (prefixed, with `originalName`).
 * @param settings - the adapter policy layer, consulted when the server does not decide.
 * @returns `{ names, hidden }` — names are prefixed tool names; hidden ones start inactive.
 */
export function resolveDirectTools(
  config: Pick<ServerConfig, 'directTools'>,
  entries: CatalogTool[],
  settings: { directTools?: unknown },
): DirectToolsSelection {
  // The ternary is the source's, verbatim. Its `undefined` arm is unreachable through this signature
  // (`normalizeEntry` always coerces the field), and kept so the port reads exactly as the source.
  const configured = config.directTools
  const setting = configured === false ? settings.directTools : configured === undefined ? settings.directTools : configured
  if (setting === false || setting === undefined || setting === null) return { names: [], hidden: new Set() }
  const names = entries.map((tool) => tool.name)
  if (setting === true) return { names, hidden: new Set() }
  if (setting === 'search') return { names, hidden: new Set(names) }
  if (Array.isArray(setting)) {
    // `Array.isArray` on `unknown` narrows to `any[]`, which would leave `wanted` untyped; binding
    // to `unknown[]` first keeps every consumer type-checked without a cast.
    const listed: unknown[] = setting
    const wanted = new Set(listed.map(String))
    const chosen = entries.filter((tool) => wanted.has(tool.originalName) || wanted.has(tool.name))
    return { names: chosen.map((tool) => tool.name), hidden: new Set() }
  }
  return { names: [], hidden: new Set() }
}

/**
 * A dsh tool definition for one MCP tool.
 *
 * The return type is the real `ToolDefinition` from `@deepseek-ai/dsh-tools`, and the object
 * satisfies it with no cast, so Task 9 hands it straight to `ctx.tools.register`.
 * @param tool - catalog entry with `server`, `originalName`, `inputSchema`.
 * @param callApproved - the session's gated call path, so a direct tool is not a way around approvals.
 * @param isActive - whether the tool may run (search-activated tools start inactive).
 * @param appendStructuredContent - the server's own `appendStructuredContent`; a getter because the
 *   server entry can be re-synced after a config edit while this definition stays registered.
 */
export function directToolDefinition(
  tool: CatalogTool,
  callApproved: (name: string, args: unknown, exec: ToolRunLike | undefined) => Promise<unknown>,
  isActive: () => boolean = () => true,
  appendStructuredContent: () => boolean = () => true,
): ToolDefinition {
  return {
    name: tool.name,
    // The source's trailing `${tool.description ? '' : ''}` contributes nothing and is kept verbatim.
    description: `${tool.description || `MCP tool from ${tool.server}`}${tool.description ? '' : ''}`,
    // The server's own schema is passed through: it validates arguments, not the adapter.
    parameters: sanitizeParameters(tool.inputSchema),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => projectResult(value, appendStructuredContent()),
    },
    async execute(args, exec) {
      if (!isActive()) throw new Error(`MCP tool "${tool.name}" is not active — call mcp({ search: "${tool.originalName}" }) to activate it`)
      // Same gate as the proxy: a direct tool is not a way around approvals.
      const result = await callApproved(tool.name, args ?? {}, exec)
      if (reportsError(result)) {
        const blocks = projectResult(result, appendStructuredContent())
        return { content: blocks, value: result, isError: true }
      }
      return result
    },
  }
}

/**
 * dsh only accepts a JSON Schema for `parameters`. MCP servers occasionally advertise a schema
 * dsh's subset rejects (`additionalProperties` as a schema, `$ref` chains); those fall back to an
 * open object so the tool stays callable instead of disappearing.
 */
export function sanitizeParameters(schema: unknown): Record<string, unknown> {
  if (!isObjectLike(schema) || schema.type !== 'object') return { type: 'object', properties: {}, additionalProperties: true }
  const out: Record<string, unknown> = { type: 'object', properties: {} }
  if (Array.isArray(schema.required)) {
    const required: unknown[] = schema.required
    out.required = required.filter((name) => typeof name === 'string')
  }
  const properties: Record<string, unknown> = {}
  for (const [name, property] of entriesOf(schema.properties)) properties[name] = sanitizeNode(property)
  out.properties = properties
  out.additionalProperties = schema.additionalProperties === false ? false : true
  return out
}

/**
 * One property schema, reduced to the subset dsh accepts.
 *
 * The source's guard has two halves, and both are kept: `typeof node === 'object'` with a null test
 * (`isObjectLike`), then an explicit `Array.isArray` rejection. An array-shaped property therefore
 * becomes `{}` before any keyword is read, whatever `type` it carries.
 */
function sanitizeNode(node: unknown): Record<string, unknown> {
  if (!isObjectLike(node) || Array.isArray(node)) return {}
  const out: Record<string, unknown> = {}
  if (typeof node.type === 'string' && ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(node.type)) out.type = node.type
  if (typeof node.description === 'string') out.description = node.description
  if (Array.isArray(node.enum)) {
    // `Array.isArray` on `unknown` narrows to `any[]`; binding to `unknown[]` keeps it honest.
    const enumValues: unknown[] = node.enum
    out.enum = enumValues
  }
  if (node.const !== undefined) out.const = node.const
  // Drop $ref/allOf/oneOf: dsh's subset does not carry them, and a partially honest schema beats
  // a rejected tool. The server still validates the real shape.
  if (node.type === 'object' && isObjectLike(node.properties)) {
    // Admits exactly what the source's `node.properties && typeof node.properties === 'object'`
    // admits: `typeof x === 'object'` is true only for objects and null, and the source's truthiness
    // test drops null — so both forms mean "a non-null object" and agree on every input. Spelled with
    // `isObjectLike` so the value narrows to a record; `Object.entries` on a bare `object` falls back
    // to its `{}` overload and yields `any` children, which would undo the typing one level down.
    const nodeProperties: Record<string, unknown> = node.properties
    const properties: Record<string, unknown> = {}
    for (const [name, child] of Object.entries(nodeProperties)) properties[name] = sanitizeNode(child)
    out.type = 'object'
    out.properties = properties
    if (Array.isArray(node.required)) {
      const required: unknown[] = node.required
      out.required = required.filter((name) => typeof name === 'string')
    }
    out.additionalProperties = node.additionalProperties === false ? false : true
  } else if (node.type === 'array' && node.items !== undefined) {
    out.type = 'array'
    out.items = sanitizeNode(node.items)
  }
  return out
}

/**
 * `result?.isError === true`, without reading a property off `null`.
 *
 * Every JSON-reachable value is covered: an object (arrays included) has its `isError` read, and a
 * primitive or null short-circuits to false exactly where the source's optional chain yields
 * undefined. Only a callable carrying `isError` would diverge, which no MCP result is.
 */
function reportsError(result: unknown): boolean {
  return isObjectLike(result) && result.isError === true
}

/** An object-shaped value, arrays included. */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The source's `Object.entries(value ?? {})` for an untyped `properties`.
 *
 * Kept literal on purpose: `Object.entries` enumerates a string's characters, so a server that
 * advertises `properties: "str"` gets the same character-indexed property map the source produced.
 * Neither schema can validate an argument, but a port that quietly returns a different schema is a
 * port that diverges for no gain. The `null`/`undefined` exclusion also narrows `unknown` to `{}`,
 * which is what makes the call typecheck without a cast.
 */
function entriesOf(value: unknown): Array<[string, unknown]> {
  if (value === null || value === undefined) return []
  const entries: Array<[string, unknown]> = Object.entries(value)
  return entries
}
