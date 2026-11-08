import { describe, expect, it } from 'vitest'
import { PROXY_DESCRIPTION, PROXY_PARAMETERS, PROXY_TOOL_NAME, createProxyExecutor } from '../src/proxy.ts'
import { resolveDirectTools, sanitizeParameters } from '../src/direct.ts'

describe('proxy surface', () => {
  it('keeps the tool name and every documented parameter', () => {
    expect(PROXY_TOOL_NAME).toBe('mcp')
    for (const key of ['tool', 'args', 'server', 'search', 'describe', 'connect', 'resources', 'read', 'prompt']) {
      expect(PROXY_PARAMETERS.properties).toHaveProperty(key)
    }
    expect(PROXY_DESCRIPTION).toContain('search')
  })

  it('answers an unarmed session instead of throwing', async () => {
    const run = createProxyExecutor(() => undefined)
    const result = await run({}, {} as never)
    expect(result.content[0].text).toBe('MCP is not initialized for this session yet.')
  })

  it('promotes every tool under directTools: true and hides them under "search"', () => {
    const entries = [{ name: 'demo_ping', originalName: 'ping' }] as never[]
    expect(resolveDirectTools({} as never, entries, { directTools: true } as never).names).toEqual(['demo_ping'])
    expect(resolveDirectTools({} as never, entries, { directTools: 'search' } as never).hidden.has('demo_ping')).toBe(true)
  })

  it('drops $ref and keeps a callable object schema', () => {
    const sanitized = sanitizeParameters({ type: 'object', properties: { a: { $ref: '#/x' } }, required: ['a'] })
    expect(sanitized).toEqual({ type: 'object', properties: { a: {} }, required: ['a'], additionalProperties: true })
  })
})

// ---------------------------------------------------------------------------------------------------
// Additions. Every expectation below was read off the pre-port lib/proxy.mjs and lib/direct.mjs
// before it was written, so these pin the source's behaviour rather than the port's convenience.
// ---------------------------------------------------------------------------------------------------

import { buildCatalog } from '../src/catalog.ts'
import { directToolDefinition } from '../src/direct.ts'
import type { ProxySession } from '../src/proxy.ts'
import type { PoolStatus } from '../src/servers.ts'
import type { Catalog, CatalogTool, ServerCatalog, ServerConfig, ToolRunLike } from '../src/types.ts'

const DEMO_INSTRUCTIONS = 'Use ping for a health check.'

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'demo',
    transport: 'stdio',
    args: [],
    env: {},
    inheritEnv: true,
    cwd: '',
    headers: {},
    lifecycle: 'lazy',
    directTools: false,
    exposeResources: true,
    appendStructuredContent: true,
    debug: false,
    ...overrides,
  }
}

function rawCatalog(overrides: Partial<ServerCatalog> = {}): ServerCatalog {
  return {
    tools: [
      { name: 'ping', description: 'Return the literal string pong.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'take_screenshot', description: 'Take a screenshot of the page.', inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } } } },
    ],
    resources: [{ uri: 'demo://readme', name: 'readme', description: 'Demo resource' }],
    prompts: [{ name: 'greet', description: 'Greet someone', arguments: [] }],
    instructions: DEMO_INSTRUCTIONS,
    ...overrides,
  }
}

/** The model-facing catalog `buildCatalog` derives from one server's raw catalog. */
function catalogOf(raw: ServerCatalog = rawCatalog()): Catalog {
  return buildCatalog(new Map([['demo', { config: serverConfig(), catalog: raw }]]), {})
}

interface FakeCalls {
  toolName: string
  args: unknown
  exec: ToolRunLike | undefined
}

interface FakeSession extends ProxySession {
  calls: FakeCalls[]
  refreshes: number
  warmCalls: string[]
  reads: string[]
  prompts: Array<{ server: string; name: string }>
  /** Every query the proxy asked to activate, in order. */
  activations: string[]
}

/**
 * A hand-built session standing in for Task 9's `McpSession`. It implements only the members
 * `proxy.ts` reads, which is what the structural `ProxySession` declares.
 */
function fakeSession(options: {
  raw?: ServerCatalog
  statuses?: PoolStatus[]
  blocked?: Array<{ name: string; reason: string }>
  errors?: string[]
  callResult?: (toolName: string, args: unknown) => unknown
  home?: string
  maxOutputChars?: number
  spillStore?: ProxySession['spillStore']
  sessionId?: string
  /** ADR-0010: when the host reports no direct tools, the second catalog scan is skipped. */
  hasDirectTools?: () => boolean
} = {}): FakeSession {
  const raw = options.raw ?? rawCatalog()
  const statuses = options.statuses ?? [{ name: 'demo', state: 'idle', hasCatalog: true, lifecycle: 'lazy' }]
  const session: FakeSession = {
    catalog: catalogOf(raw),
    blocked: options.blocked,
    errors: options.errors,
    calls: [],
    refreshes: 0,
    warmCalls: [],
    reads: [],
    prompts: [],
    activations: [],
    home: options.home,
    maxOutputChars: options.maxOutputChars,
    spillStore: options.spillStore,
    sessionId: options.sessionId,
    pool: {
      get: (name) => (name === 'demo' ? { config: serverConfig() } : undefined),
      names: () => ['demo'],
      catalog: async () => raw,
      warm: async (name) => {
        session.warmCalls.push(name)
        return raw
      },
      status: () => statuses,
      readResource: async (_name, uri) => {
        session.reads.push(uri)
        return { contents: [{ text: `body of ${uri}` }] }
      },
      getPrompt: async (server, name) => {
        session.prompts.push({ server, name })
        return { messages: [{ role: 'user', content: { type: 'text', text: 'greet the user' } }] }
      },
    },
    async refreshCatalog() {
      session.refreshes += 1
      return session.catalog
    },
    async callApproved(toolName, args, exec) {
      session.calls.push({ toolName, args, exec })
      return options.callResult?.(toolName, args) ?? { content: [{ type: 'text', text: 'pong' }] }
    },
    activateMatches(query) {
      session.activations.push(query)
      return []
    },
    hasDirectTools: options.hasDirectTools,
  }
  return session
}

function firstText(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text
}

describe('PROXY_PARAMETERS', () => {
  it('is an object-root JSON Schema the provider will accept', () => {
    // The exact shape that broke every request: a bare property map reaches the provider with no
    // root type, which refuses it with "got 'type: null'". `register` never normalizes this.
    expect(PROXY_PARAMETERS.type).toBe('object')
    expect(PROXY_PARAMETERS.additionalProperties).toBe(false)
    expect(PROXY_PARAMETERS.properties).toBeTypeOf('object')
  })

  it('declares the proxy parameters with their types including extract', () => {
    const expected: Record<string, string> = {
      tool: 'string',
      args: 'object',
      extract: 'array',
      server: 'string',
      search: 'string',
      regex: 'boolean',
      includeSchemas: 'boolean',
      limit: 'integer',
      offset: 'integer',
      describe: 'string',
      instructions: 'string',
      connect: 'string',
      resources: 'string',
      read: 'string',
      prompt: 'string',
    }
    expect(Object.keys(PROXY_PARAMETERS.properties)).toEqual(Object.keys(expected))
    for (const [key, type] of Object.entries(expected)) {
      expect(PROXY_PARAMETERS.properties[key].type).toBe(type)
      expect(PROXY_PARAMETERS.properties[key].description.length).toBeGreaterThan(0)
    }
  })

  it('opens additionalProperties for args only', () => {
    const open = Object.entries(PROXY_PARAMETERS.properties).filter(([, parameter]) => parameter.additionalProperties !== undefined)
    expect(open.map(([key]) => key)).toEqual(['args'])
    expect(PROXY_PARAMETERS.properties.args.additionalProperties).toBe(true)
  })
})

describe('PROXY_DESCRIPTION', () => {
  it('names every mode it documents', () => {
    expect(typeof PROXY_DESCRIPTION).toBe('string')
    expect(PROXY_DESCRIPTION.length).toBeGreaterThan(0)
    for (const word of ['search', 'describe', 'tool', 'resources', 'read', 'prompt']) {
      expect(PROXY_DESCRIPTION).toContain(word)
    }
  })
})

describe('createProxyExecutor mode dispatch', () => {
  it('lets describe win over search', async () => {
    const session = fakeSession()
    const result = await createProxyExecutor(() => session)({ describe: 'demo_ping', search: 'screenshot' }, {})
    expect(firstText(result)).toContain('demo_ping [demo]')
    expect(firstText(result)).not.toContain('MCP tools matching')
    expect(session.calls).toEqual([])
  })

  it('lets search win over tool', async () => {
    const session = fakeSession()
    const result = await createProxyExecutor(() => session)({ search: 'ping', tool: 'demo_ping' }, {})
    expect(firstText(result)).toContain('MCP tools matching "ping"')
    expect(session.calls).toEqual([])
  })

  it('asks the session to activate what a search matched, whatever the paging', async () => {
    const session = fakeSession()
    const run = createProxyExecutor(() => session)
    await run({ search: 'screenshot', offset: 24 }, {})
    await run({ server: 'demo', search: 'ping' }, {})
    expect(session.activations).toEqual(['screenshot', 'ping'])
    // Only the search branch activates: a status read must not unhide anything.
    await run({}, {})
    expect(session.activations).toEqual(['screenshot', 'ping'])
  })

  it('skips the activation rescan when the session has no direct tools (ADR-0010)', async () => {
    const session = fakeSession({ hasDirectTools: () => false })
    await createProxyExecutor(() => session)({ search: 'screenshot' }, {})
    expect(session.activations).toEqual([])
    // The search result itself is unchanged: the shortcut only removes a no-op second scan.
    // An omitted hasDirectTools (or one returning true) keeps the activation gesture.
    const activating = fakeSession({ hasDirectTools: () => true })
    await createProxyExecutor(() => activating)({ search: 'screenshot' }, {})
    expect(activating.activations).toEqual(['screenshot'])
    const legacy = fakeSession()
    await createProxyExecutor(() => legacy)({ search: 'screenshot' }, {})
    expect(legacy.activations).toEqual(['screenshot'])
  })

  it('includes a parameter summary unless includeSchemas is exactly false', async () => {
    const session = fakeSession()
    const run = createProxyExecutor(() => session)
    const line = async (extra: Record<string, unknown>): Promise<string> => firstText(await run({ search: 'screenshot', ...extra }, {})).split('\n')[2]
    expect(await line({})).toBe('demo_take_screenshot(fullPage?) [demo] — Take a screenshot of the page.')
    expect(await line({ includeSchemas: false })).toBe('demo_take_screenshot [demo] — Take a screenshot of the page.')
    // The source tests `!== false`, so only the boolean turns it off.
    expect(await line({ includeSchemas: 0 })).toBe('demo_take_screenshot(fullPage?) [demo] — Take a screenshot of the page.')
  })

  it('returns a helpful description instead of throwing when a tool cannot be resolved', async () => {
    const session = fakeSession()
    const result = await createProxyExecutor(() => session)({ tool: 'missing_tool' }, {})
    expect(firstText(result)).toBe('No MCP tool named "missing_tool".')
    expect(session.calls).toEqual([])
  })

  it('calls a resolvable tool through callApproved with the bound exec context', async () => {
    const session = fakeSession()
    const exec = { callId: 'call-1' }
    const result = await createProxyExecutor(() => session)({ tool: 'demo_ping', args: { loud: true } }, exec)
    expect(session.calls).toEqual([{ toolName: 'demo_ping', args: { loud: true }, exec }])
    expect(firstText(result)).toBe('pong')
    expect(result.value).toEqual({ content: [{ type: 'text', text: 'pong' }] })
  })

  it('resolves a tool by its original name too', async () => {
    const session = fakeSession()
    await createProxyExecutor(() => session)({ tool: 'ping' }, {})
    expect(session.calls.map((call) => call.toolName)).toEqual(['demo_ping'])
  })

  it('projects extracted fields when extract option is passed to mcp call', async () => {
    const session = fakeSession({
      callResult: () => ({
        content: [{ type: 'text', text: JSON.stringify({ user: 'bob', email: 'bob@example.com', unneeded: 123 }) }],
      }),
    })
    const result = await createProxyExecutor(() => session)({ tool: 'demo_ping', extract: ['user'] }, {})
    const parsed = JSON.parse(firstText(result))
    expect(parsed).toEqual({ user: 'bob' })
  })

  it('spills long tool output to a file and returns preview notice', async () => {
    const session = fakeSession({
      home: 'C:/fake-home-dir',
      maxOutputChars: 50,
      callResult: () => ({
        content: [{ type: 'text', text: 'Z'.repeat(100) }],
      }),
    })
    const result = await createProxyExecutor(() => session)({ tool: 'demo_ping' }, {})
    const text = firstText(result)
    expect(text).toContain('[Notice: Tool output exceeded 50 characters (100 chars)')
    expect(text).toContain('Preview (first')
  })

  // Delegation to the host spill store: the host owns the path, the name and the expiry, so this
  // adapter must not also write its own file when a store is present.
  describe('spill delegation to ctx.spillStore', () => {
    it('uses the host store and reports its locator and hint', async () => {
      const saved: unknown[] = []
      const session = fakeSession({
        home: 'C:/fake-home-dir',
        maxOutputChars: 10,
        sessionId: 'session-1',
        spillStore: {
          async saveText(request) {
            saved.push(request)
            return { locator: '/host/spill/abc.txt', bytes: 100, retrievalHint: 'read it with read()' }
          },
        },
        callResult: () => ({ content: [{ type: 'text', text: 'Z'.repeat(100) }] }),
      })

      const result = await createProxyExecutor(() => session)({ tool: 'demo_ping' }, {})
      const text = firstText(result)

      expect(text).toContain('/host/spill/abc.txt')
      expect(text).toContain('read it with read()')
      // The host's store is what recorded the artifact, keyed by the owning session.
      expect(saved).toEqual([expect.objectContaining({
        owner: { sessionId: 'session-1' },
        source: expect.objectContaining({ kind: 'tool', toolName: 'ping' }),
        suggestedName: 'ping.txt',
        content: 'Z'.repeat(100),
      })])
    })

    it('falls back to the local file when the host store rejects', async () => {
      const session = fakeSession({
        home: 'C:/fake-home-dir',
        maxOutputChars: 10,
        sessionId: 'session-1',
        spillStore: {
          async saveText() {
            throw new Error('no space left')
          },
        },
        callResult: () => ({ content: [{ type: 'text', text: 'Z'.repeat(100) }] }),
      })

      // A storage failure must not turn a successful MCP call into an error: the local path takes over.
      const result = await createProxyExecutor(() => session)({ tool: 'demo_ping' }, {})
      expect(firstText(result)).toContain('[Notice: Tool output exceeded 10 characters (100 chars)')
    })

    it('stays on the local file when no store is mounted', async () => {
      const session = fakeSession({
        home: 'C:/fake-home-dir',
        maxOutputChars: 10,
        callResult: () => ({ content: [{ type: 'text', text: 'Z'.repeat(100) }] }),
      })
      const result = await createProxyExecutor(() => session)({ tool: 'demo_ping' }, {})
      expect(firstText(result)).toContain('Preview (first')
    })
  })

  it('does not call the tool when the server hint is a non-string JSON value', async () => {
    // Verified against the pre-port lib/proxy.mjs first: the hint reaches `callTool` raw, and only
    // `undefined` means "no hint", so `null`/`0`/`false`/`[]`/`{}` match no server and the call never
    // happens. Normalizing the hint to `undefined` here would turn a destructive tool from "not
    // called" into "called" from a JSON-reachable argument shape.
    for (const hint of [null, 0, false, [], {}]) {
      const session = fakeSession()
      const result = await createProxyExecutor(() => session)({ tool: 'ping', server: hint }, {})
      expect(session.calls).toEqual([])
      expect(firstText(result).startsWith('demo_ping [demo]\nReturn the literal string pong.')).toBe(true)
    }
  })

  it('still resolves the tool by original name under a matching string server hint', async () => {
    const session = fakeSession()
    await createProxyExecutor(() => session)({ tool: 'ping', server: 'demo' }, {})
    expect(session.calls.map((call) => call.toolName)).toEqual(['demo_ping'])
  })

  it('does not call the tool when a string server hint names another server', async () => {
    const session = fakeSession()
    const result = await createProxyExecutor(() => session)({ tool: 'ping', server: 'other' }, {})
    expect(session.calls).toEqual([])
    expect(firstText(result).startsWith('demo_ping [demo]\nReturn the literal string pong.')).toBe(true)
  })

  it('turns a server-reported error into an Error-prefixed result', async () => {
    const session = fakeSession({ callResult: () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }) })
    const result = await createProxyExecutor(() => session)({ tool: 'demo_ping' }, {})
    expect(firstText(result)).toBe('Error: boom')
  })

  it('turns a thrown MCP call into an Error-prefixed result instead of rejecting', async () => {
    const session = fakeSession({
      callResult: () => {
        throw new Error('transport died')
      },
    })
    const result = await createProxyExecutor(() => session)({ tool: 'take_screenshot' }, {})
    expect(firstText(result)).toBe('Error: MCP call failed: transport died')
  })

  it('answers instructions, and reports an unknown server by name', async () => {
    const session = fakeSession()
    const run = createProxyExecutor(() => session)
    expect(firstText(await run({ instructions: 'demo' }, {}))).toBe(DEMO_INSTRUCTIONS)
    expect(firstText(await run({ instructions: 'nope' }, {}))).toBe('No MCP server named "nope".')
  })

  it('connects a server, refreshes the catalog, and reports its counts', async () => {
    const session = fakeSession()
    const run = createProxyExecutor(() => session)
    expect(firstText(await run({ connect: 'demo' }, {}))).toBe('Connected "demo": 2 tool(s), 1 resource(s), 1 prompt(s).')
    expect(session.warmCalls).toEqual(['demo'])
    expect(session.refreshes).toBe(1)
    expect(firstText(await run({ connect: 'nope' }, {}))).toBe('No MCP server named "nope".')
  })

  it('lists one server when only a server name is given', async () => {
    const session = fakeSession()
    const text = firstText(await createProxyExecutor(() => session)({ server: 'demo' }, {}))
    expect(text).toContain('Server "demo" — 2 tool(s), 1 resource(s), 1 prompt(s).')
    expect(text).toContain(`Instructions:\n${DEMO_INSTRUCTIONS}`)
    // The server's own catalog names, not the prefixed model-facing ones.
    expect(text).toContain('- ping() — Return the literal string pong.')
    expect(text).toContain('- take_screenshot(fullPage?) — Take a screenshot of the page.')
  })

  it('lists a server\'s resources, and says so when there are none', async () => {
    const text = firstText(await createProxyExecutor(() => fakeSession())({ resources: 'demo' }, {}))
    expect(text).toContain('Resources from "demo":')
    expect(text).toContain('- demo://readme (readme) — Demo resource')
    expect(text).toContain('Read one with mcp({ server: "demo", read: "<uri>" }).')

    const empty = fakeSession({ raw: rawCatalog({ resources: [] }) })
    expect(firstText(await createProxyExecutor(() => empty)({ resources: 'demo' }, {}))).toBe('Server "demo" exposes no resources.')
  })

  it('reads a resource through its owning server, and hints when the URI is unknown', async () => {
    const session = fakeSession()
    const run = createProxyExecutor(() => session)
    expect(firstText(await run({ read: 'demo://readme' }, {}))).toBe('body of demo://readme')
    expect(session.reads).toEqual(['demo://readme'])
    expect(firstText(await run({ read: 'demo://missing' }, {}))).toBe('No known resource with URI "demo://missing". Use mcp({ resources: "<server>" }) first.')
  })

  it('describes a binary resource by size instead of inlining it', async () => {
    const session = fakeSession()
    const binary: ProxySession = {
      catalog: session.catalog,
      pool: { ...session.pool, readResource: async () => ({ contents: [{ blob: 'AAAA', mimeType: 'image/png' }] }) },
      refreshCatalog: async () => session.catalog,
      callApproved: async () => ({}),
      activateMatches: () => [],
    }
    expect(firstText(await createProxyExecutor(() => binary)({ read: 'demo://readme' }, {}))).toBe('[binary image/png — 3 bytes omitted]')
  })

  it('requires a server name for prompt, and renders the prompt when given one', async () => {
    const session = fakeSession()
    const run = createProxyExecutor(() => session)
    expect(firstText(await run({ prompt: 'greet' }, {}))).toBe('mcp({ prompt }) needs a server name: mcp({ server: "<name>", prompt: "<name>", args: {...} })')
    expect(firstText(await run({ server: 'demo', prompt: 'greet' }, {}))).toBe('[user] greet the user')
    expect(session.prompts).toEqual([{ server: 'demo', name: 'greet' }])
    expect(firstText(await run({ server: 'demo', prompt: 'missing' }, {}))).toBe('Server "demo" has no prompt named "missing".')
  })

  it('lists servers, blocked servers, and config problems when called with no arguments', async () => {
    const session = fakeSession({ blocked: [{ name: 'held', reason: 'project server needs approval' }], errors: ['broken: bad json'] })
    const text = firstText(await createProxyExecutor(() => session)({}, {}))
    expect(text).toContain('MCP servers:')
    expect(text).toContain('- demo: idle, 2 tool(s)')
    expect(text).toContain('- held: blocked — project server needs approval')
    expect(text).toContain('- problem: broken: bad json')
    expect(text).toContain('mcp({ search: "..." }) to find a tool')
  })

  it('reports the empty project honestly', async () => {
    const session = fakeSession({ statuses: [] })
    expect(firstText(await createProxyExecutor(() => session)({}, {}))).toBe('No MCP servers are configured for this project.')
  })

  it('bounds every text result it returns', async () => {
    // `text()` routes every mode through `boundedText`, so an enormous description cannot flood
    // the model's context. The marker is `boundedText`'s own, and it names the cap it hit.
    const session = fakeSession()
    const long = rawCatalog({ instructions: 'y'.repeat(200_000) })
    const huge: ProxySession = {
      catalog: session.catalog,
      pool: { ...session.pool, catalog: async () => long },
      refreshCatalog: async () => session.catalog,
      callApproved: async () => ({}),
      activateMatches: () => [],
    }
    const out = firstText(await createProxyExecutor(() => huge)({ instructions: 'demo' }, {}))
    expect(out.length).toBe(65_572)
    expect(out.endsWith('… [output truncated at 65536 bytes]')).toBe(true)
  })

  it('binds execContext before the session is used', async () => {
    const session = fakeSession()
    const exec = { callId: 'call-order' }
    let seenDuringRefresh: ToolRunLike | undefined
    const observed: ProxySession = {
      catalog: session.catalog,
      pool: session.pool,
      refreshCatalog: async () => {
        seenDuringRefresh = observed.execContext
        return session.catalog
      },
      callApproved: async () => ({}),
      activateMatches: () => [],
    }
    await createProxyExecutor(() => observed)({}, exec)
    // The assignment happens before the first session call, so the catalog refresh already sees it.
    expect(seenDuringRefresh).toBe(exec)
    expect(observed.execContext).toBe(exec)
  })
})

describe('resolveDirectTools matrix', () => {
  const entries: CatalogTool[] = [...catalogOf().tools.values()]

  /**
   * Call the resolver with a loosely typed config layer; the settings layer stays `unknown`.
   *
   * `config.directTools` is narrowed by `normalizeEntry` in production, so the cast here is the one
   * place a raw file value is simulated: the resolver must still behave like the source for it.
   */
  function resolved(configured: unknown, setting: unknown = false): { names: string[]; hidden: Set<string> } {
    return resolveDirectTools({ directTools: configured as ServerConfig['directTools'] }, entries, { directTools: setting })
  }

  it('registers nothing when both layers are off', () => {
    for (const off of [false, undefined, null]) {
      expect(resolved(off, false)).toEqual({ names: [], hidden: new Set() })
      expect(resolved(false, off)).toEqual({ names: [], hidden: new Set() })
    }
  })

  it('promotes every tool under true, with nothing hidden', () => {
    for (const result of [resolved(true), resolved(undefined, true), resolveDirectTools(serverConfig({ directTools: true }), entries, { directTools: false })]) {
      expect(result.names).toEqual(['demo_ping', 'demo_take_screenshot'])
      expect(result.hidden.size).toBe(0)
    }
  })

  it('promotes every tool and hides every tool under "search"', () => {
    for (const result of [resolved('search'), resolved(undefined, 'search')]) {
      expect(result.names).toEqual(['demo_ping', 'demo_take_screenshot'])
      expect([...result.hidden]).toEqual(['demo_ping', 'demo_take_screenshot'])
    }
  })

  it('selects by original name or prefixed name under an array', () => {
    expect(resolved(['ping']).names).toEqual(['demo_ping'])
    expect(resolved(['demo_take_screenshot']).names).toEqual(['demo_take_screenshot'])
    expect(resolved(['ping', 'take_screenshot']).names).toEqual(['demo_ping', 'demo_take_screenshot'])
    expect(resolved(['absent'])).toEqual({ names: [], hidden: new Set() })
    expect(resolved(undefined, ['ping']).names).toEqual(['demo_ping'])
  })

  it('lets a server level directTools override the settings layer', () => {
    // A server's own value wins over the settings layer, whatever it is.
    expect(resolveDirectTools(serverConfig({ directTools: true }), entries, { directTools: false }).names).toEqual(['demo_ping', 'demo_take_screenshot'])
    expect([...resolveDirectTools(serverConfig({ directTools: 'search' }), entries, { directTools: true }).hidden]).toEqual(['demo_ping', 'demo_take_screenshot'])
    expect(resolveDirectTools(serverConfig({ directTools: ['ping'] }), entries, { directTools: true }).names).toEqual(['demo_ping'])
    // `false` is not an override: it falls through to the settings layer, as the source's ternary does.
    expect(resolveDirectTools(serverConfig({ directTools: false }), entries, { directTools: true }).names).toEqual(['demo_ping', 'demo_take_screenshot'])
  })

  it('registers nothing when the settings layer is null', () => {
    // `null` reaches the guard for real through a hand-written settings file; it is off, not a
    // crash and not "everything".
    expect(resolved(undefined, null)).toEqual({ names: [], hidden: new Set() })
  })

  it('ignores a value outside every documented spelling', () => {
    expect(resolved('sometimes')).toEqual({ names: [], hidden: new Set() })
    expect(resolved(42)).toEqual({ names: [], hidden: new Set() })
  })
})

describe('sanitizeParameters', () => {
  const open = { type: 'object', properties: {}, additionalProperties: true }

  it('falls back to an open object for a schema that is not an object schema', () => {
    for (const schema of [undefined, null, 'text', 42, [], { type: 'string' }, { type: 'array' }, { properties: {} }]) {
      expect(sanitizeParameters(schema)).toEqual(open)
    }
  })

  it('keeps only string entries in required', () => {
    expect(sanitizeParameters({ type: 'object', properties: {}, required: ['a', 7, null, 'b'] })).toEqual({
      type: 'object',
      properties: {},
      required: ['a', 'b'],
      additionalProperties: true,
    })
    // Absent stays absent; a non-array `required` is dropped.
    expect(sanitizeParameters({ type: 'object', properties: {} })).toEqual(open)
    expect(sanitizeParameters({ type: 'object', properties: {}, required: 'a' })).toEqual(open)
  })

  it('preserves additionalProperties: false and defaults it to open', () => {
    expect(sanitizeParameters({ type: 'object', properties: {}, additionalProperties: false })).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    })
    expect(sanitizeParameters({ type: 'object', properties: {}, additionalProperties: true })).toEqual(open)
  })

  it('recurses into nested objects, array items, and scalar annotations', () => {
    const sanitized = sanitizeParameters({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { inner: { type: 'string', description: 'inner text' } },
          required: ['inner'],
          additionalProperties: false,
        },
        list: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: true } },
        scalars: { type: 'string', description: 'a scalar', enum: ['a', 'b'], const: 'a' },
      },
      required: ['nested'],
    })
    expect(sanitized).toEqual({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { inner: { type: 'string', description: 'inner text' } }, required: ['inner'], additionalProperties: false },
        list: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: true } },
        scalars: { type: 'string', description: 'a scalar', enum: ['a', 'b'], const: 'a' },
      },
      required: ['nested'],
      additionalProperties: true,
    })
  })

  it('drops $ref, allOf, and oneOf at the root and at every nested level', () => {
    const sanitized = sanitizeParameters({
      type: 'object',
      allOf: [{ required: ['a'] }],
      oneOf: [{ type: 'object' }],
      properties: {
        root: { $ref: '#/definitions/thing' },
        viaAllOf: { allOf: [{ type: 'string' }, { minLength: 1 }] },
        viaOneOf: { type: 'string', oneOf: [{ enum: ['a'] }, { enum: ['b'] }] },
        nested: { type: 'object', properties: { deep: { $ref: '#/x' } }, allOf: [{ type: 'object' }] },
        nestedArray: { type: 'array', items: { oneOf: [{ type: 'string' }] } },
      },
    })
    expect(sanitized).toEqual({
      type: 'object',
      properties: {
        root: {},
        viaAllOf: {},
        viaOneOf: { type: 'string' },
        nested: { type: 'object', properties: { deep: {} }, additionalProperties: true },
        nestedArray: { type: 'array', items: {} },
      },
      additionalProperties: true,
    })
  })

  it('empties an array-shaped property even when it carries a type', () => {
    // `sanitizeNode` rejects arrays outright, before any keyword is read.
    const arrayShaped = Object.assign([], { type: 'string' })
    expect(sanitizeParameters({ type: 'object', properties: { x: arrayShaped } })).toEqual({
      type: 'object',
      properties: { x: {} },
      additionalProperties: true,
    })
  })

  it('requires the root type to be exactly "object"', () => {
    // A schema typed anything else falls back to the open object; it is not repaired to an object.
    expect(sanitizeParameters({ type: 'string', properties: { a: { type: 'string' } } })).toEqual(open)
    expect(sanitizeParameters({ type: 'null' })).toEqual(open)
  })

  it('enumerates a non-object properties value the way the source did', () => {
    // `Object.entries("str")` yields character indices; the source produced these empty schemas, so
    // the port does too rather than silently reshaping the schema it advertises.
    expect(sanitizeParameters({ type: 'object', properties: 'str' })).toEqual({
      type: 'object',
      properties: { 0: {}, 1: {}, 2: {} },
      additionalProperties: true,
    })
  })

  it('recurses into an object-typed node whose properties are array-shaped', () => {
    // Nested `properties` is enumerated by `Object.entries` directly (not through the root's
    // null-guard), so an array there yields its index-named members and `additionalProperties: false`
    // is still read off the outer node.
    expect(sanitizeParameters({ type: 'object', properties: { a: { type: 'object', properties: ['x'], additionalProperties: false } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'object', properties: { 0: {} }, additionalProperties: false } },
      additionalProperties: true,
    })
  })

  it('keeps an object or array node without properties or items minimal', () => {
    // `type` survives on its own; neither branch adds `properties` or `items` it did not see.
    expect(sanitizeParameters({ type: 'object', properties: { o: { type: 'object' }, a: { type: 'array' } } })).toEqual({
      type: 'object',
      properties: { o: { type: 'object' }, a: { type: 'array' } },
      additionalProperties: true,
    })
  })

  it('keeps a property with no usable keywords empty rather than inventing a type', () => {
    expect(sanitizeParameters({ type: 'object', properties: { anything: {} } })).toEqual({
      type: 'object',
      properties: { anything: {} },
      additionalProperties: true,
    })
  })
})

describe('directToolDefinition', () => {
  const tool = catalogOf().tools.get('demo_ping') as CatalogTool

  it('publishes the catalog name, description, and sanitized parameters', () => {
    const definition = directToolDefinition(tool, async () => ({ content: [] }))
    expect(definition.name).toBe('demo_ping')
    expect(definition.description).toBe('Return the literal string pong.')
    // The server's own schema is passed through, `additionalProperties: false` included.
    expect(definition.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    expect(definition.output.schema).toEqual({ type: 'object', additionalProperties: true })
  })

  it('falls back to the server name when the tool has no description', () => {
    const bare: CatalogTool = { ...tool, description: '' }
    expect(directToolDefinition(bare, async () => ({ content: [] })).description).toBe('MCP tool from demo')
  })

  it('refuses to run an inactive tool and names the search that activates it', async () => {
    const definition = directToolDefinition(tool, async () => ({ content: [] }), () => false)
    await expect(definition.execute({}, {} as never)).rejects.toThrow('MCP tool "demo_ping" is not active — call mcp({ search: "ping" }) to activate it')
  })

  it('routes an active call through the same approval gate and defaults args to {}', async () => {
    const seen: Array<{ name: string; args: unknown; exec: ToolRunLike | undefined }> = []
    const definition = directToolDefinition(tool, async (name, args, exec) => {
      seen.push({ name, args, exec })
      return { content: [{ type: 'text', text: 'pong' }] }
    })
    const result = await definition.execute(undefined, { callId: 'direct-1' } as never)
    expect(seen).toEqual([{ name: 'demo_ping', args: {}, exec: { callId: 'direct-1' } }])
    expect(result).toEqual({ content: [{ type: 'text', text: 'pong' }] })
  })

  it('marks a server-reported error as isError with the projected blocks', async () => {
    const definition = directToolDefinition(tool, async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }))
    expect(await definition.execute({}, {} as never)).toEqual({
      content: [{ type: 'text', text: 'boom' }],
      value: { isError: true, content: [{ type: 'text', text: 'boom' }] },
      isError: true,
    })
  })

  it('renders the canonical value back into text blocks', () => {
    const definition = directToolDefinition(tool, async () => ({ content: [] }))
    expect(definition.output.render({}, { content: [{ type: 'text', text: 'rendered' }] })).toEqual([{ type: 'text', text: 'rendered' }])
  })
})
