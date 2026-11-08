// The tool-approval gate.
//
// dsh exposes one approval seam (`ctx.approval.request`), which prompts the user inside an open
// turn and fails closed when no answerer is composed.
//
// Two config shapes feed this gate:
//   approveTools  "ask before these"   — true | "destructive" | ["tool_a"]
//   autoApprove   "never ask for these" — true | ["tool_a"], the Cursor/Claude-Code spelling
//
// They are opposite defaults, so they are not merged: a server that lists `autoApprove` opts into
// allowlist mode (its unlisted tools ask), while `approveTools` stays a denylist. Asking on every
// call is how you train a user to accept without reading, so nothing here asks by default.

import { matchesPattern } from './catalog.ts'
import type { AdapterSettings } from './config.ts'
import type { CatalogTool, ServerConfig } from './types.ts'

/**
 * The slice of a cordis context this module ducks: `ctx.get('approval')` when the context is a
 * real service container, or a plain `approval` field when a test hands one in. Declared
 * structurally so this pure-logic module needs no runtime dependency to be exercised.
 *
 * `get` mirrors cordis: the second argument turns the required lookup into an optional one, which
 * returns `undefined` instead of throwing when the service is absent.
 */
interface Context {
  get?: (name: string, required?: boolean) => unknown
  approval?: unknown
}

/** The one method `approval.request` offers; the outcome is whatever string the answerer chose. */
interface ApprovalService {
  request: (request: ApprovalRequest) => Promise<unknown>
}

/** One approval question. `callId` is omitted entirely when the caller has none. */
interface ApprovalRequest {
  agent: unknown
  toolName: string
  callId?: string
  reason: string
  signal?: AbortSignal
}

/**
 * A value carrying a callable `request`, which is the whole of what this module needs.
 *
 * The source wrote `approval === undefined || typeof approval.request !== 'function'`, which reads a
 * property off `null` and throws a TypeError. A `null` from `ctx.get('approval')` is a missing
 * service in every composition that can happen, so it takes the documented refusal below instead.
 */
function isApprovalService(value: unknown): value is ApprovalService {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  return 'request' in value && typeof value.request === 'function'
}

/** Tool names from an `autoApprove` value, normalized; `null` means "the whole server". */
function autoApprovedNames(value: unknown): string[] | null {
  if (value === true) return null
  if (!Array.isArray(value)) return null
  // Other clients' files sometimes carry an empty string or `*`; both mean "everything".
  const names: string[] = value.map(String).map((name) => name.trim()).filter((name) => name.length > 0)
  if (names.includes('*')) return null
  return names
}

/** Whether this tool needs a decision before it runs. */
export function needsApproval(config: ServerConfig | undefined, tool: CatalogTool, settings: AdapterSettings): boolean {
  const autoApprove = config?.autoApprove
  if (autoApprove !== undefined && autoApprove !== false) {
    const names = autoApprovedNames(autoApprove)
    // Allowlist mode: a listed tool runs, everything else on that server asks.
    if (names === null) return false
    const candidates = [tool.originalName, tool.name]
    const listed = names.some((pattern) => candidates.some((cand) => matchesPattern(cand, pattern)))
    return !listed
  }

  const configured = config?.approveTools === undefined ? settings?.approveTools : config.approveTools
  if (configured === true) return true
  if (Array.isArray(configured)) {
    // `Array.isArray` narrows an `unknown` to an array of the loose element type, which would make
    // the `includes` calls below untyped. Binding to `unknown[]` first keeps them typechecked;
    // evaluation order is the source's, short-circuiting on `'*'`.
    const names: unknown[] = configured
    if (names.includes('*')) return true
    const stringNames = names.map(String)
    const candidates = [tool.originalName, tool.name]
    return stringNames.some((pattern) => candidates.some((cand) => matchesPattern(cand, pattern)))
  }
  if (configured === 'destructive') return tool.annotations?.destructiveHint === true
  return false
}

/** The sentence the user sees; it has to explain *why* they are being interrupted. */
export function approvalReason(config: ServerConfig | undefined, tool: CatalogTool, settings: AdapterSettings): string {
  if (config?.autoApprove !== undefined && config.autoApprove !== false) {
    return 'this server lists its pre-approved tools with autoApprove, and this one is not on the list'
  }
  if (tool.annotations?.destructiveHint === true) return 'this MCP tool is marked destructive by its server'
  const configured = config?.approveTools === undefined ? settings?.approveTools : config.approveTools
  if (configured === true) return 'this server asks before every tool call'
  return 'this MCP tool is listed in approveTools'
}

/**
 * Ask for one call. A denial or an unavailable answerer refuses; the call never proceeds on a
 * failure to decide.
 * @returns nothing when the call may run.
 * @throws the reason the call is refused.
 */
export async function requireApproval(
  agent: unknown,
  // The source reads `ctx?.get` and `ctx?.approval`, so an absent context is a real call shape: it
  // has no approval service and must refuse rather than let the tool through.
  ctx: Context | undefined,
  tool: CatalogTool,
  exec: { callId?: string; signal?: AbortSignal } | undefined,
  config: ServerConfig | undefined,
  settings: AdapterSettings,
): Promise<void> {
  // `ctx.get(name)` is required by default and throws when the service is absent; the optional
  // read keeps the refusal below readable instead of leaking the proxy's own error.
  const approval = typeof ctx?.get === 'function' ? ctx.get('approval', false) : ctx?.approval
  if (!isApprovalService(approval)) {
    // No approval seam in this composition: the configured policy cannot be honoured, so refuse
    // rather than silently running a tool the user asked to be asked about.
    throw new Error(`MCP tool "${tool.name}" requires approval, but no approval service is available in this composition`)
  }
  const outcome = await approval.request({
    agent,
    toolName: `mcp:${tool.server}/${tool.originalName}`,
    ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
    reason: approvalReason(config, tool, settings),
    signal: exec?.signal,
  })
  if (outcome !== 'allowed-once') throw new Error(`MCP tool "${tool.name}" was not approved (${outcome})`)
}
