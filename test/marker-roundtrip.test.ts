// End-to-end proof for the defect-2 fix, run through vitest so it can load the package's own
// TypeScript modules exactly as the built plugin would.
//
// Before the fix the marker was written with a plain `Session.append`, which cannot mark an event
// ignorable; the persistence reader then refused any log containing it, so every conversation that
// used the plugin became unopenable after a restart. This proves the current path survives a reload.

import { Session, KNOWN_SESSION_EVENT_TYPES, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it } from 'vitest'

import { mcpAdapterProjection, publishCurrent, recordWriter, STATUS_EVENT } from '../src/projection.ts'
import { describeStatus } from '../src/status.ts'

/** The smallest runtime `describeStatus` accepts: no servers, no problems. */
const emptyRuntime = {
  pool: { names: () => [], get: () => undefined, status: () => [] },
  catalog: { tools: new Map() },
  blocked: [],
  errors: [],
  projectRoot: '/repo',
}

/**
 * A Session whose class is NOT the one this package's `@deepseek-ai/dsh-session` copy knows.
 *
 * This is the shape every real installation has: the plugin resolves its own copy of the SDK, while
 * the host's Session class belongs to the host's copy. `appendPluginRecord` reaches the log through
 * that class's PRIVATE field, so it throws `TypeError: Receiver must be an instance of class Session`
 * — a failure the old writer swallowed, leaving the panel permanently empty while every same-copy
 * test stayed green. Building the session from a second copy of the module reproduces it exactly.
 */
async function foreignSession(): Promise<Session> {
  const sdkPath = import.meta.resolve('@deepseek-ai/dsh-session')
  const foreign = await import(`${sdkPath}?foreign-copy`)
  return foreign.Session.create('e2e-foreign' as never)
}

describe('the status marker across a persistence round trip', () => {
  it('is written through the real publish path, accepted by the reader, and folded back', async () => {
    const session = Session.create('e2e-marker' as never)
    const commit = await recordWriter(session)

    const written = await publishCurrent(session, emptyRuntime as never, async () => {}, commit)
    expect(written).toBe(true)

    const events = [...session.ownEvents()]
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('plugin:mcp-adapter/status')
    expect(events[0].ignorable).toBe(true)

    // The assertion that matters: a real reload ACCEPTS the log instead of refusing it.
    expect(() => validateStoredEvents({ id: 'e2e-marker', formatVersion: 4 } as never, events)).not.toThrow()

    // The record is readable as a plugin record, and the panel's fold recovers the snapshot.
    expect(pluginRecordOf(events[0])?.type).toBe('plugin:mcp-adapter/status')
    const folded = mcpAdapterProjection.apply(mcpAdapterProjection.init({} as never, 0 as never), events[0])
    expect(folded).toEqual(describeStatus(emptyRuntime as never))
  })

  it('keeps the bare name out of the reader vocabulary, which is why the prefix is required', () => {
    // If the SDK ever learns this name, the prefix stops being load-bearing and this fails loudly.
    expect(KNOWN_SESSION_EVENT_TYPES.has('mcp-adapter/status')).toBe(false)
    expect(STATUS_EVENT).toBe('plugin:mcp-adapter/status')
  })

  it('writes the record even when the host runs a different copy of the Session SDK', async () => {
    const session = await foreignSession()

    // The premise: the SDK's own writer cannot write into a Session from another copy.
    const { appendPluginRecord } = await import('@deepseek-ai/dsh-session')
    expect(() => appendPluginRecord(session, STATUS_EVENT, {} as never)).toThrow()

    const commit = await recordWriter(session)
    const written = await publishCurrent(session, emptyRuntime as never, async () => {}, commit)
    expect(written).toBe(true)

    const events = [...session.ownEvents()]
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe(STATUS_EVENT)
    expect(events[0].ignorable).toBe(true)

    // The record still survives a reload, and the panel's fold still recovers the snapshot.
    expect(() => validateStoredEvents({ id: 'e2e-foreign', formatVersion: 4 } as never, events)).not.toThrow()
    expect(pluginRecordOf(events[0])?.type).toBe(STATUS_EVENT)
    const folded = mcpAdapterProjection.apply(mcpAdapterProjection.init({} as never, 0 as never), events[0])
    expect(folded).toEqual(describeStatus(emptyRuntime as never))
  })
})
