// Self-check for the Web panel's data path: the snapshot, the projection fold, and the publisher.
//
// What this would catch: a snapshot that stops being plain JSON (the projection codec rejects it
// before it ever reaches a browser), a blocked server that silently disappears from the panel, a
// state the panel cannot name, and a publisher that grows the log on every open.

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { approveToolDefinition } from '../src/approve.ts'
import { BARE_STATUS_EVENT, mcpAdapterProjection, publishCurrent, publishStatus, recordWriter, STATUS_EVENT } from '../src/projection.ts'
import { approveProjectServer, describeStatus } from '../src/status.ts'
import type { McpSession } from '../src/session.ts'

/** The smallest thing shaped like an `McpSession` that the snapshot reads. */
function fakeSession({
  servers = [],
  blocked = [],
  errors = [],
  tools = [],
  projectRoot = '/repo',
}: {
  servers?: Array<{ name: string; state: string; lastError?: string; config?: Record<string, unknown> }>
  blocked?: Array<{ name: string; reason: string }>
  errors?: string[]
  tools?: Array<{ name: string; server: string }>
  projectRoot?: string
} = {}): McpSession {
  const entries = new Map(servers.map((server) => [server.name, server]))
  return {
    projectRoot,
    blocked,
    errors,
    catalog: { tools: new Map(tools.map((tool) => [tool.name, tool])) },
    pool: {
      names: () => servers.map((server) => server.name),
      get: (name: string) => entries.get(name),
    },
    approve(name: string) {
      if (!blocked.some((entry) => entry.name === name)) throw new Error(`no MCP server named "${name}"`)
    },
  } as unknown as McpSession
}

it('a session with no server still produces a renderable snapshot', () => {
  const status = describeStatus(fakeSession())
  expect(status.available).toBe(true)
  expect(status.servers).toEqual([])
  expect(status.counts).toEqual({ servers: 0, running: 0, tools: 0, blocked: 0 })
  // The projection codec is strict, so "renderable" means "this exact schema parses".
  expect(mcpAdapterProjection.stateSchema.safeParse(status).success).toBe(true)
})

it('an unarmed session is unavailable rather than empty', () => {
  const status = describeStatus(undefined, { error: 'send a message first' })
  expect(status.available).toBe(false)
  expect(status.error).toBe('send a message first')
  expect(mcpAdapterProjection.stateSchema.safeParse(status).success).toBe(true)
})

it('server states map onto the panel vocabulary, including a held-back server', () => {
  const session = fakeSession({
    servers: [
      { name: 'chrome', state: 'connected', lastError: undefined, config: { transport: 'stdio', lifecycle: 'lazy' } },
      { name: 'broken', state: 'failed', lastError: 'spawn ENOENT', config: { transport: 'http', lifecycle: 'eager' } },
      { name: 'cold', state: 'idle', lastError: undefined, config: {} },
      { name: 'cloned-repo', state: 'idle', lastError: undefined, config: {} },
    ],
    blocked: [{ name: 'cloned-repo', reason: '.mcp.json is not approved' }],
    tools: [
      { name: 'chrome_ping', server: 'chrome' },
      { name: 'chrome_shot', server: 'chrome' },
    ],
  })
  const status = describeStatus(session)
  const byName = Object.fromEntries(status.servers.map((server) => [server.name, server]))

  expect(byName.chrome.state).toBe('ready')
  expect(byName.chrome.toolNames).toEqual(['chrome_ping', 'chrome_shot'])
  expect(byName.broken.state).toBe('error')
  expect(byName.broken.lastError).toBe('spawn ENOENT')
  expect(byName.cold.state).toBe('stopped')
  // A blocked server never reached the pool, so it exists only through the blocked list.
  expect(byName['cloned-repo'].state).toBe('blocked')
  expect(byName['cloned-repo'].blockedReason).toBe('.mcp.json is not approved')
  // `failed` counts as a server the panel shows, but not as one that is running.
  expect(status.counts).toEqual({ servers: 4, running: 1, tools: 2, blocked: 1 })
  expect(mcpAdapterProjection.stateSchema.safeParse(status).success).toBe(true)
})

it('the fold keeps the newest marker and ignores every other event', () => {
  const older = describeStatus(undefined)
  const newer = describeStatus(fakeSession({ servers: [{ name: 'a', state: 'connected', config: {} }] }))

  // A non-marker event changes nothing and must not even change the reference.
  expect(mcpAdapterProjection.apply(older, event('turn/start', {}))).toBe(older)

  const afterMarker = mcpAdapterProjection.apply(older, event(STATUS_EVENT, newer))
  expect(afterMarker).toEqual(newer)

  // A malformed marker keeps the last good value instead of blanking the panel.
  expect(mcpAdapterProjection.apply(afterMarker, event(STATUS_EVENT, { nope: true }))).toBe(afterMarker)
})

it('publishing appends once per real change', () => {
  const appended: Array<{ type: string; data: unknown }> = []
  const session = {}
  const commit = (type: string, data: unknown): boolean => {
    appended.push({ type, data })
    return true
  }

  expect(publishStatus(session, describeStatus(fakeSession()), commit)).toBe(true)
  expect(publishStatus(session, describeStatus(fakeSession()), commit)).toBe(false)
  expect(publishStatus(session, describeStatus(fakeSession({ errors: ['bad json'] })), commit)).toBe(true)
  expect(appended.map((entry) => entry.type)).toEqual([STATUS_EVENT, STATUS_EVENT])
})

it('approval reports a refusal instead of throwing through the Remote surface', () => {
  const session = fakeSession({ blocked: [{ name: 'local', reason: 'not approved' }] })
  expect(approveProjectServer(session, 'local')).toEqual({ ok: true, error: '' })
  const refused = approveProjectServer(session, 'missing')
  expect(refused.ok).toBe(false)
  expect(refused.error).toMatch(/no MCP server named "missing"/)
})

it('the approval tool re-arms and republishes only after a successful approval', async () => {
  let rearmed = 0
  let republished = 0
  const blocked = [{ name: 'local', reason: 'not approved' }]
  const session = fakeSession({ blocked })
  const tool = approveToolDefinition(
    () => session,
    () => {
      rearmed += 1
      // A real re-arm mounts the server, so the blocked list is empty afterwards.
      blocked.length = 0
    },
    async () => {
      republished += 1
    },
  )

  const refused = await tool.execute({ server: 'missing' }, {} as never)
  expect(textOf(refused)).toMatch(/no MCP server named "missing"/)
  expect(rearmed).toBe(0)
  expect(republished).toBe(0)

  const accepted = await tool.execute({ server: 'local' }, {} as never)
  expect(textOf(accepted)).toMatch(/Approved "local"/)
  expect(rearmed).toBe(1)
  expect(republished).toBe(1)
})

// --- Guards for what the seven migrated cases leave uncovered -------------------------------

it('maps every pool state to the panel vocabulary, and block overrides a stopped row', () => {
  const session = fakeSession({
    servers: [
      { name: 'a-idle', state: 'idle' },
      { name: 'b-connecting', state: 'connecting' },
      { name: 'c-connected', state: 'connected' },
      { name: 'd-dropped', state: 'dropped' },
      { name: 'e-failed', state: 'failed' },
      // Mounted and idle, yet here in the blocked list: the trust reason still wins the row.
      { name: 'f-held', state: 'idle' },
      // A state outside the pool's five words falls back to `stopped` rather than vanishing.
      { name: 'g-unknown', state: 'paused' },
    ],
    blocked: [{ name: 'f-held', reason: 'not approved' }],
  })
  const states = Object.fromEntries(describeStatus(session).servers.map((server) => [server.name, server.state]))
  expect(states).toEqual({
    'a-idle': 'stopped',
    'b-connecting': 'starting',
    'c-connected': 'ready',
    'd-dropped': 'stopped',
    'e-failed': 'error',
    'f-held': 'blocked',
    'g-unknown': 'stopped',
  })
})

it('counts ready plus starting as running, and counts blocked rows by their reason', () => {
  const session = fakeSession({
    servers: [
      { name: 'ready', state: 'connected' },
      { name: 'starting', state: 'connecting' },
      { name: 'also-ready-but-held', state: 'connected' },
      { name: 'cold', state: 'idle' },
      { name: 'broken', state: 'failed' },
    ],
    blocked: [{ name: 'also-ready-but-held', reason: 'stale approval' }, { name: 'never-pooled', reason: 'not approved' }],
    tools: [
      { name: 'r1', server: 'ready' },
      { name: 'r2', server: 'ready' },
      { name: 's1', server: 'starting' },
    ],
  })
  const status = describeStatus(session)
  // `running` is a state count; `blocked` is a reason count, so a running row with a stale
  // approval is tallied in both. That is the source's arithmetic, pinned here deliberately.
  expect(status.counts).toEqual({ servers: 6, running: 3, tools: 3, blocked: 2 })
})

it('sorts server rows and tool names by code-unit order, and leaves config problems in place', () => {
  const session = fakeSession({
    servers: [
      { name: 'zeta', state: 'idle' },
      { name: 'Alpha', state: 'idle' },
      { name: 'alpha', state: 'idle' },
    ],
    tools: [
      { name: 'zeta_two', server: 'zeta' },
      { name: 'zeta_one', server: 'zeta' },
    ],
    errors: ['second problem', 'first problem'],
  })
  const status = describeStatus(session)
  // `.sort()` is code-unit order, so an uppercase name precedes every lowercase one.
  expect(status.servers.map((server) => server.name)).toEqual(['Alpha', 'alpha', 'zeta'])
  expect(status.servers.find((server) => server.name === 'zeta')?.toolNames).toEqual(['zeta_one', 'zeta_two'])
  // Problems are NOT sorted: they keep config discovery order, which is the order the operator
  // needs to read them in. Pinned so a later "tidy-up" sort is caught.
  expect(status.problems).toEqual(['second problem', 'first problem'])
})

it('keeps the published snapshot per session, so two sessions each publish the same value', () => {
  const appended: string[] = []
  const commit = (type: string): boolean => {
    appended.push(type)
    return true
  }
  const first = {}
  const second = {}
  const value = describeStatus(fakeSession())

  expect(publishStatus(first, value, commit)).toBe(true)
  expect(publishStatus(second, value, commit)).toBe(true)
  expect(publishStatus(first, value, commit)).toBe(false)
  expect(appended).toEqual([STATUS_EVENT, STATUS_EVENT])
})

it('publishCurrent flushes only when it actually wrote a marker', async () => {
  const appended: Array<{ type: string; data: unknown }> = []
  const flushed: unknown[] = []
  const session = {}
  const commit = (type: string, data: unknown): boolean => {
    appended.push({ type, data })
    return true
  }
  const runtime = fakeSession({ servers: [{ name: 'a', state: 'connected' }] })
  const flush = async (target: unknown): Promise<void> => {
    flushed.push(target)
  }

  expect(await publishCurrent(session, runtime, flush, commit)).toBe(true)
  expect(appended.map((entry) => entry.type)).toEqual([STATUS_EVENT])
  expect(flushed).toEqual([session])

  // The same runtime produces the same snapshot, so the second call writes nothing and flushes
  // nothing: an unchanged status must not cost an event or a durability checkpoint.
  expect(await publishCurrent(session, runtime, flush, commit)).toBe(false)
  expect(appended.map((entry) => entry.type)).toEqual([STATUS_EVENT])
  expect(flushed).toEqual([session])
})

it('publishCurrent still reports a write when the flush itself fails', async () => {
  const session = {}
  const commit = (): boolean => true
  const runtime = fakeSession()
  const wrote = await publishCurrent(session, runtime, async () => {
    throw new Error('the backend is gone')
  }, commit)
  expect(wrote).toBe(true)
})

it('approveProjectServer returns the success shape and turns every refusal into text', () => {
  const session = fakeSession({ blocked: [{ name: 'local', reason: 'not approved' }] })
  // Approving twice is legal: the second call re-writes the same record rather than refusing.
  expect(approveProjectServer(session, 'local')).toEqual({ ok: true, error: '' })
  expect(approveProjectServer(session, 'local')).toEqual({ ok: true, error: '' })
  const missing = approveProjectServer(session, 'missing')
  expect(missing).toEqual({ ok: false, error: 'no MCP server named "missing"' })
})

it('the approval tool refuses with usage when no server name was given', async () => {
  let rearmed = 0
  const session = fakeSession({ blocked: [{ name: 'local', reason: 'not approved' }] })
  const tool = approveToolDefinition(() => session, () => {
    rearmed += 1
  })
  expect(textOf(await tool.execute({}, {} as never))).toBe('usage: mcp_approve({ server: "<name>" })')
  expect(textOf(await tool.execute({ server: '   ' }, {} as never))).toBe('usage: mcp_approve({ server: "<name>" })')
  expect(rearmed).toBe(0)
})

it('the approval tool answers without a session when the adapter is not armed yet', async () => {
  const tool = approveToolDefinition(() => undefined)
  expect(textOf(await tool.execute({ server: 'local' }, {} as never))).toBe('MCP is not initialized for this session yet.')
})

it('the approval tool declares an object-root schema, as the provider requires', () => {
  const tool = approveToolDefinition(() => undefined)
  expect(tool.parameters.type).toBe('object')
  expect(tool.parameters).toHaveProperty('properties.server')
})

/**
 * One committed-event stand-in. The projection only reads `type` and `data`, so the branded seq and
 * the timestamp are the only fields a cast supplies; both matter to no assertion here.
 */
function event(type: string, data: unknown): SessionEvent {
  return { type, data, seq: 0, time: 0 } as never
}

/** The single text block a tool result carries, so a case can match on its body. */
function textOf(value: unknown): string {
  const result = value as { content: Array<{ type: string; text: string }> }
  return result.content[0].text
}

// The marker must SURVIVE A RELOAD. It is written as an ignorable plugin record, so the persistence
// reader accepts the log and `pluginRecordOf` reads the snapshot back. A plain `Session.append` of the
// same marker cannot be marked ignorable and is refused — which is the bug this replaced, and the
// reason the `plugin:` prefix is load-bearing rather than cosmetic.
it('the status marker survives a persistence round trip', async () => {
  const { Session } = await import('@deepseek-ai/dsh-session')
  const { validateStoredEvents } = await import('@deepseek-ai/dsh-session-persistence')
  const session = Session.create('mcp-adapter-roundtrip' as never)
  const value = describeStatus(fakeSession({ servers: [{ name: 'a', state: 'connected' }] }))

  const commit = await recordWriter(session)
  expect(commit(STATUS_EVENT, value)).toBe(true)

  const events = [...session.ownEvents()]
  expect(events).toHaveLength(1)
  // The record really is ignorable, which is what makes the reader accept it.
  expect(events[0].ignorable).toBe(true)
  expect(events[0].type).toBe('plugin:mcp-adapter/status')

  // This is the assertion that matters: a real reload accepts the log instead of refusing it.
  expect(() => validateStoredEvents({ id: 'mcp-adapter-roundtrip', formatVersion: 4 } as never, events)).not.toThrow()

  // And the fold still finds it, so the panel gets its data back after a restart.
  expect(mcpAdapterProjection.apply(mcpAdapterProjection.init({} as never, 0 as never), events[0])).toEqual(value)
})

it('a bare marker without the plugin prefix is still refused by the reader', async () => {
  // Why the `plugin:` prefix is load-bearing, asserted with a REAL Session both ways round. Written
  // as a plain `append`, the bare name is not in the SDK's known set and the reader refuses the log;
  // written through `appendPluginRecord` it fails the record grammar instead. So a later "simplify
  // the literal" that drops the prefix cannot pass silently.
  const { Session, appendPluginRecord, KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session')
  const { validateStoredEvents } = await import('@deepseek-ai/dsh-session-persistence')

  // The name alone buys nothing: it is not part of the reader's vocabulary.
  expect(KNOWN_SESSION_EVENT_TYPES.has(BARE_STATUS_EVENT)).toBe(false)
  // The prefixed name is what the plugin actually uses.
  expect(STATUS_EVENT).toBe('plugin:' + BARE_STATUS_EVENT)

  // Half one: the record writer rejects the bare name on its grammar. The message is asserted so this
  // cannot pass for an unrelated reason -- a wrong receiver type throws too.
  const grammar = Session.create('mcp-adapter-grammar' as never)
  expect(() => appendPluginRecord(grammar, BARE_STATUS_EVENT as never, {} as never))
    .toThrow(/must be "plugin:" followed by lowercase slash-separated segments/)
  // A rejected record leaves the log untouched.
  expect(grammar.ownEvents()).toHaveLength(0)

  // Half two: the old spelling written the old way is still refused on reload. The cast is the point
  // -- `BARE_STATUS_EVENT` is not a `SessionEventMap` key, which is exactly the old code's silent
  // assumption.
  const legacy = Session.create('mcp-adapter-bare' as never)
  const plainAppend = legacy.append.bind(legacy) as unknown as (type: string, data: unknown) => unknown
  plainAppend(BARE_STATUS_EVENT, describeStatus(fakeSession()))
  expect([...legacy.ownEvents()][0].ignorable).toBeUndefined()
  expect(() => validateStoredEvents({ id: 'mcp-adapter-bare', formatVersion: 4 } as never, [...legacy.ownEvents()]))
    .toThrow(/unknown to this harness and not marked ignorable/)
})
