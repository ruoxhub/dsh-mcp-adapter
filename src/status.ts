// The Web panel's whole data contract: one plain-JSON snapshot per Agent.
//
// This is a pure function of the session runtime so the panel can be tested without a browser, and
// so nothing in the snapshot needs a live object to render. It never starts a server: status is read
// from the pool, tools from the catalog, and anything that would require connecting is a separate
// explicit action.

import type { McpSession } from './session.ts'
import type { PoolState } from './servers.ts'
import type { Catalog } from './types.ts'
import type { StatusSnapshot } from './projection.ts'

/** The panel's word for one server row. */
export type PanelServerState = 'stopped' | 'starting' | 'ready' | 'error' | 'blocked'

/** Server states the panel renders, keyed by what `ServerPool.status()` reports. */
const SERVER_STATES: Record<PoolState, PanelServerState> = {
  idle: 'stopped',
  connecting: 'starting',
  connected: 'ready',
  dropped: 'stopped',
  failed: 'error',
}

/** Keep the snapshot plain JSON text; the Remote codec rejects anything else. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Group the catalog by owning server. Search-activated direct tools are the catalog's own view;
 * the panel does not re-derive the include/exclude rules.
 * @param catalog - built catalog.
 * @returns map of server name to its tool names.
 */
function toolsByServer(catalog: Catalog): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const tool of catalog.tools.values()) {
    const list = grouped.get(tool.server) ?? []
    list.push(tool.name)
    grouped.set(tool.server, list)
  }
  return grouped
}

/** Why a server may be held back, keyed by name — the panel attaches it to the row it belongs to. */
function blockedByServer(blocked: McpSession['blocked']): Map<string, string> {
  const byName = new Map<string, string>()
  for (const entry of blocked) byName.set(entry.name, text(entry.reason))
  return byName
}

/**
 * Build the panel snapshot for one session.
 * @param session - the Agent's `McpSession`, or `undefined` before the first message arms it.
 * @param options.error - why the session is unavailable, when it is.
 * @returns a plain-JSON snapshot the panel renders directly.
 */
export function describeStatus(session: McpSession | undefined, { error }: { error?: string } = {}): StatusSnapshot {
  if (session === undefined) {
    return {
      available: false,
      projectRoot: '',
      error: typeof error === 'string' ? error : '',
      servers: [],
      problems: [],
      counts: { servers: 0, running: 0, tools: 0, blocked: 0 },
    }
  }
  const byServer = toolsByServer(session.catalog)
  // Both maps are keyed by name, so a definition that is both mounted and held back renders once,
  // in the mounted list, with the trust reason attached to that same row.
  const blockedReasons = blockedByServer(session.blocked)
  const names = new Set([...session.pool.names(), ...blockedReasons.keys()])
  const servers = [...names].sort().map((name) => {
    const entry = session.pool.get(name)
    const tools = byServer.get(name) ?? []
    const blockedReason = blockedReasons.get(name) ?? ''
    const state: PanelServerState = entry === undefined
      ? 'blocked'
      : SERVER_STATES[entry.state] ?? 'stopped'
    return {
      name,
      // `blocked` is the panel's word for "this definition never got as far as starting".
      state: state === 'stopped' && blockedReason.length > 0 ? 'blocked' : state,
      transport: text(entry?.config?.transport),
      lifecycle: text(entry?.config?.lifecycle),
      tools: tools.length,
      toolNames: [...tools].sort(),
      lastError: text(entry?.lastError),
      blockedReason,
    }
  })
  const problems = session.errors.map(text)
  return {
    available: true,
    projectRoot: text(session.projectRoot),
    error: '',
    servers,
    problems,
    counts: {
      servers: servers.length,
      running: servers.filter((server) => server.state === 'ready' || server.state === 'starting').length,
      tools: servers.reduce((total, server) => total + server.tools, 0),
      blocked: servers.filter((server) => server.blockedReason.length > 0).length,
    },
  }
}

/** A refusal is a typed result, not a throw: the panel shows the reason, the carrier stays healthy. */
export type ApprovalResult = { ok: true; error: '' } | { ok: false; error: string }

/**
 * Approve a project server the panel asked for.
 *
 * A refusal is a typed result, not a throw: the panel shows the reason next to the row it was
 * asked from, and the Remote carrier should not turn a user mistake into a transport fault.
 * @param session - the Agent's `McpSession`.
 * @param server - project server name from the panel row.
 * @returns `{ ok: true }` once the record is written, or `{ ok: false, error }`.
 */
export function approveProjectServer(session: Pick<McpSession, 'approve'>, server: string): ApprovalResult {
  try {
    session.approve(server)
    return { ok: true, error: '' }
  } catch (error) {
    return { ok: false, error: String(isObjectLike(error) && error.message !== undefined && error.message !== null ? error.message : error) }
  }
}

/** An object-shaped value, arrays included. */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
