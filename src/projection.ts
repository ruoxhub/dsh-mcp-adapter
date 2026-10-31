// How the Web panel sees MCP state: one Session projection, `mcpAdapter`.
//
// Why a projection rather than a Remote namespace: the browser mounts Remote contributions only from
// the list shipped inside `@deepseek-ai/dsh-api-remotes`, and this package is not on that list — but
// a Host-registered projection reaches every open conversation through the `sessions` store the
// panel already injects, with no bundle edge to add.
//
// A projection state advances only by folding committed Session events, and "a server stopped" is not
// a Session event. So the publisher appends one small marker event carrying the snapshot. That has
// an effect worth naming: the seq is the marker's real log position, which makes the watermark
// monotonic, so a replayed or stale frame can never overwrite a newer value on the client.
//
// The marker is log-only by construction: it is not a SurfaceEventType, it carries no message, and it
// says nothing the adapter would not already tell the model through the `mcp` tool or the system
// prompt context. Nothing about it enters the model's history.
//
// It is written as a PLUGIN RECORD (`appendPluginRecord`), not a plain `append`. A plain append cannot
// mark an event `ignorable`, and the persistence reader refuses to reload a log holding an event type
// it does not know — so a plain marker made every conversation that used this plugin unopenable after
// a restart. `appendPluginRecord` commits the record with `ignorable: true` under the SDK's `plugin:`
// grammar, which the reader accepts and `pluginRecordOf` reads back. That is why the type below carries
// the prefix: the grammar requires it, and dropping it silently reintroduces the session-corrupting
// bug (test/panel.test.ts pins that a bare `mcp-adapter/status` is still refused).

import type { ProjectionDefinition, SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { describeStatus } from './status.ts'
import type { McpSession } from './session.ts'

/** Projection key the panel reads, and the marker event type that advances it. */
export const PROJECTION_KEY = 'mcpAdapter'
/**
 * The marker's record name. The `plugin:` prefix is the SDK's grammar for an ignorable plugin record,
 * not decoration: a bare `mcp-adapter/status` cannot be marked ignorable and is refused on reload.
 */
export const STATUS_EVENT = 'plugin:mcp-adapter/status'
/** The same marker spelled without the record prefix, kept only so a test can prove it is refused. */
export const BARE_STATUS_EVENT = 'mcp-adapter/status'

/** The marker payload: the panel snapshot, and nothing else. */
const statusDataSchema = z.object({
  available: z.boolean(),
  projectRoot: z.string(),
  error: z.string(),
  servers: z.array(z.object({
    name: z.string(),
    state: z.enum(['stopped', 'starting', 'ready', 'error', 'blocked']),
    transport: z.string(),
    lifecycle: z.string(),
    tools: z.number(),
    toolNames: z.array(z.string()),
    lastError: z.string(),
    blockedReason: z.string(),
  })),
  problems: z.array(z.string()),
  counts: z.object({
    servers: z.number(),
    running: z.number(),
    tools: z.number(),
    blocked: z.number(),
  }),
})

/** The panel's whole status snapshot, derived from the wire schema rather than hand-written. */
export type StatusSnapshot = z.infer<typeof statusDataSchema>

/**
 * The two merge-extensible tables the SDK ships empty, so the panel can name this key.
 *
 * `ProjectionDefinition<K>` requires `K extends keyof SessionProjectionStateMap`, and
 * `useProjection` in the client half reads `SessionProjectionMap`, so without these declarations
 * `'mcpAdapter'` is not a legal key anywhere. Module augmentation is program-wide: this file names
 * the key once and every other file in the package sees it.
 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The panel's whole status snapshot. */
    mcpAdapter: StatusSnapshot
  }
  interface SessionProjectionStateMap {
    mcpAdapter: StatusSnapshot
  }
}

/**
 * Type-only declarations of the marker, so the record write and the fold are both typed.
 *
 * This does NOT teach the SDK the event at runtime: `KNOWN_SESSION_EVENT_TYPES` is a runtime Set, and
 * the reader's acceptance comes from the record being `ignorable`, not from these declarations. What
 * they buy is a typed `appendPluginRecord` and a typed fold. `PluginRecordMap` must be augmented
 * because `appendPluginRecord`'s `type` parameter is constrained to its keys.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'plugin:mcp-adapter/status': StatusSnapshot
  }
  interface PluginRecordMap {
    'plugin:mcp-adapter/status': StatusSnapshot
  }
}

/** A Session no marker has touched yet: the panel shows its "no status yet" notice. */
const EMPTY = describeStatus(undefined)

/**
 * A client-visible unit, spelled as the registry's own `register` parameter.
 *
 * `ProjectionDefinition` declares `wire` optional (a host-only key leaves it out), while `register`
 * accepts only the overload that requires it. Naming the intersection once keeps the unit assignable
 * to `ctx.sessionProjections.register(...)` without a cast at that call site.
 */
export type ClientVisibleDefinition<K extends keyof SessionProjectionStateMap> =
  Omit<ProjectionDefinition<K>, 'wire'> & { wire: NonNullable<ProjectionDefinition<K>['wire']> }

/**
 * The unit the projection registry drives: keep the latest marker payload, ignore every other event
 * by returning the same reference (the registry reads that as "not mine" and costs one compare).
 */
export const mcpAdapterProjection: ClientVisibleDefinition<'mcpAdapter'> = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: statusDataSchema,
  init: () => EMPTY,
  apply: (state, event) => {
    if (event.type !== STATUS_EVENT) return state
    const parsed = statusDataSchema.safeParse(event.data)
    // A malformed marker keeps the previous value rather than blanking the panel.
    return parsed.success ? parsed.data : state
  },
  wire: {
    viewSchema: statusDataSchema,
    view: (state) => state,
  },
}

/** The record name this module writes, as the writer sees it. */
export type StatusRecordName = typeof STATUS_EVENT

/** One Agent's last published snapshot, keyed by Session, so unchanged values cost no event. */
const published = new WeakMap<object, StatusSnapshot>()

/**
 * The public slice of a Session this module writes through.
 *
 * `appendPluginRecord` is the SDK's own writer, but it reaches the log through the Session class's
 * PRIVATE field `#appendRecord`, so it only works when the caller's `Session` class and the caller's
 * `@deepseek-ai/dsh-session` module are the SAME copy. A plugin installed outside the host's own
 * dependency tree resolves its own copy, and the call then throws
 * `TypeError: Receiver must be an instance of class Session` — which is why the panel stayed empty in
 * a real browser while every test passed (the tests import one copy and use it for both sides).
 *
 * `publicationEntry` and `commit` are the public half of that same path: `commit` accepts a frozen
 * candidate event and enters it into the log, so the same record can be written without naming the
 * private field. Both are declared `private` in the SDK's types, so this interface states the shape
 * structurally and the writer casts once.
 */
interface WritableSession {
  readonly log: readonly unknown[]
  publicationEntry: () => unknown
  commit: (event: unknown, entry: unknown) => void
}

/** The record envelope the SDK writes for a plugin record: `ignorable` is what makes it survive a reload. */
interface PluginRecordEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable: true
}

/**
 * Write one ignorable plugin record through the Session's public commit path.
 *
 * Mirrors the SDK's `#appendRecord`: snapshot the payload as plain JSON, freeze the envelope, and
 * commit it at the current log length. The snapshot is this module's own JSON check, so a payload that
 * the SDK would refuse is refused here too instead of corrupting the log.
 * @param session - the Session to write into.
 * @param type - the record name.
 * @param data - the payload.
 * @returns whether the record was committed.
 */
function commitRecordThroughSession(session: WritableSession, type: string, data: unknown): boolean {
  const json = JSON.stringify(data)
  if (json === undefined) return false
  const entry = session.publicationEntry()
  const event: PluginRecordEvent = Object.freeze({
    type,
    seq: session.log.length,
    time: Date.now(),
    data: JSON.parse(json) as unknown,
    ignorable: true,
  })
  session.commit(event, entry)
  return true
}

/**
 * Build the record writer for one real Session.
 *
 * The SDK's `appendPluginRecord` is tried first, because it is the supported writer when this package
 * and the host share one `@deepseek-ai/dsh-session` copy. When they do not, it throws on the private
 * field, and the public commit path above writes the identical record instead — so the panel gets its
 * data in every installation, linked or published.
 *
 * The import stays lazy and the failure stays soft: a composition without the Session service loses
 * the panel's data (the documented "no status yet" state) but still gets a working adapter, and no
 * conversation is ever broken over panel state.
 * @param session - the Agent's real Session.
 * @returns a writer reporting whether the record was committed.
 */
export async function recordWriter(
  session: import('@deepseek-ai/dsh-session').Session,
): Promise<(type: StatusRecordName, data: StatusSnapshot) => boolean> {
  const writable = session as unknown as WritableSession
  try {
    const { appendPluginRecord } = await import('@deepseek-ai/dsh-session')
    return (type, data) => {
      try {
        appendPluginRecord(session, type, data)
        return true
      } catch {
        // A different copy of the SDK: the private field behind `appendPluginRecord` belongs to
        // another Session class. Fall back to the public commit path, which does not care.
        try {
          return commitRecordThroughSession(writable, type, data)
        } catch {
          return false
        }
      }
    }
  } catch {
    return (type, data) => {
      try {
        return commitRecordThroughSession(writable, type, data)
      } catch {
        return false
      }
    }
  }
}

/**
 * Publish one Agent's current status.
 *
 * Only a real change is written: opening the panel, re-opening it, or idling must not grow the log.
 * @param session - the Agent's Session, used as the dedupe key.
 * @param value - a snapshot from `describeStatus`.
 * @param commit - the writer from {@link recordWriter}, or a test double.
 * @returns whether a marker was written.
 */
export function publishStatus(
  session: object,
  value: StatusSnapshot,
  commit: (type: StatusRecordName, data: StatusSnapshot) => boolean,
): boolean {
  const previous = published.get(session)
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(value)) return false
  // Mark as published only after the write succeeded: a failed commit must not poison the dedupe, or
  // every later real change would be suppressed too.
  if (!commit(STATUS_EVENT, value)) return false
  published.set(session, value)
  return true
}

/**
 * Publish a fresh snapshot for a live Agent, then flush it so a browser attached to another Host
 * generation can replay the marker from the persisted log.
 *
 * Generic over the Session type so `ctx.sessions.flush` (typed against the real `Session`) can be
 * passed straight through: the flush callback and the session must be the same concrete type.
 * @param session - the Agent's Session.
 * @param runtime - that Agent's `McpSession`.
 * @param flush - `ctx.sessions.flush`.
 * @param commit - the writer from {@link recordWriter}.
 * @returns whether a marker was written.
 */
export async function publishCurrent<S extends object>(
  session: S,
  runtime: McpSession,
  flush: (session: S) => Promise<unknown>,
  commit: (type: StatusRecordName, data: StatusSnapshot) => boolean,
): Promise<boolean> {
  const written = publishStatus(session, describeStatus(runtime), commit)
  if (written) await flush(session).catch(() => {})
  return written
}
