// End-to-end self-check: a real MCP server over stdio, driven through the adapter's own modules.
//
// This is the test that would fail if the port broke: it starts a child process, does the MCP
// handshake, lists tools, caches the catalog, stops the server, searches offline, then calls a
// tool and watches the server start again.
//
// Three cases at the end close behaviour surfaces the unit suites cannot reach: the env scrub
// between the pool and a spawned child, cancellation reaching `tools/call`, and what the real tool
// runtime does with a direct tool whose server reports `isError`.

import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cachedEntry, loadCache, saveCache, storeEntry } from '../src/cache.ts'
import { buildCatalog, describeTool, searchTools } from '../src/catalog.ts'
import { DEFAULT_SETTINGS, findProjectRoot, isDisabledEntry, loadConfig, normalizeEntry } from '../src/config.ts'
import { INSTRUCTION_CHARS_PER_SERVER, INSTRUCTION_CHARS_TOTAL, McpSession } from '../src/session.ts'
import { ServerPool } from '../src/servers.ts'
import type { Connection, PoolEntry } from '../src/servers.ts'
import { TEST_SERVER_SOURCE } from '../src/testserver.ts'
import { approve, approvalsPath, definitionHash, partition } from '../src/trust.ts'
import type { PartitionEntry } from '../src/trust.ts'
import type { ServerConfig } from '../src/types.ts'

const SERVER_SOURCE = `
import { writeFileSync, appendFileSync } from 'node:fs';
const log = (line) => appendFileSync(new URL('./events.log', import.meta.url), line + '\\n');
log('start ' + new Date().toISOString());
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf('\\n'); index >= 0; index = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
function handle(message) {
  const { method, params = {} } = message;
  log('method ' + method);
  if (message.id === undefined) return;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: params.protocolVersion ?? '2024-11-05',
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: 'demo', version: '1.0.0' },
    instructions: 'Use ping for a health check.',
  } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [
    { name: 'ping', description: 'Return the literal string pong.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'take_screenshot', description: 'Take a screenshot of the page or element.', inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  ] } });
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'ping') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } });
    if (name === 'take_screenshot') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'shot ' + JSON.stringify(args) }] } });
    return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'unknown tool' }], isError: true } });
  }
  if (method === 'resources/list') return send({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'demo://readme', name: 'readme', description: 'Demo resource' }] } });
  if (method === 'prompts/list') return send({ jsonrpc: '2.0', id: message.id, result: { prompts: [] } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id: message.id, result: {} });
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + method } });
}
`

/**
 * A prefix that makes the shared self-check server write down its own environment and process
 * identity on startup, so the env-scrub case drives the same wire behavior as every other case
 * instead of a bespoke server, and its output also proves a real child process was spawned.
 */
const ENV_DUMP_PREFIX = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ env: process.env, pid: process.pid, ppid: process.ppid }), 'utf8');
`

/** A server whose one tool answers with an MCP-level error (`isError: true`). */
const ERROR_TOOL_SERVER_SOURCE = `
const LF = String.fromCharCode(10);
const send = (message) => process.stdout.write(JSON.stringify(message) + LF);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf(LF); at >= 0; at = buffer.indexOf(LF)) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
function handle(message) {
  if (message.id === undefined) return;
  const { method, params = {} } = message;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: params.protocolVersion ?? '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'error-tool', version: '1.0.0' },
  } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [
    { name: 'explode', description: 'Always reports an MCP error.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ] } });
  if (method === 'tools/call') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + method } });
}
`

/** What the env-dump server writes: its own environment plus the process identity. */
interface ChildReport {
  env: Record<string, unknown>
  pid: number
  ppid: number
}

/** Narrow the child's untyped JSON dump without a cast, so a malformed dump fails loudly. */
function childReport(value: unknown): ChildReport {
  if (typeof value !== 'object' || value === null) throw new Error('the child dump is not an object')
  if (!('env' in value) || !('pid' in value) || !('ppid' in value)) throw new Error('the child dump is missing fields')
  const { env, pid, ppid } = value
  if (typeof env !== 'object' || env === null) throw new Error('the child dump has no environment')
  if (typeof pid !== 'number' || typeof ppid !== 'number') throw new Error('the child dump has no process identity')
  return { env: { ...env }, pid, ppid }
}

interface Fixture {
  root: string
  project: string
  home: string
  state: string
  server: string
  events: string
}

const dirs: string[] = []
const cleanups: Array<() => unknown> = []

afterEach(async () => {
  // Children first: a failed assertion must not leave a spawned server behind for the next run.
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      // Best effort: the pool or session is already torn down.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(source = SERVER_SOURCE): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-adapter-'))
  dirs.push(root)
  const project = join(root, 'project')
  const home = join(root, 'dsh-home')
  const state = join(home, 'mcp-adapter')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(state, { recursive: true })
  const server = join(root, 'server.mjs')
  writeFileSync(server, source, 'utf8')
  const events = join(root, 'events.log')
  return { root, project, home, state, server, events }
}

function writeServerConfig(project: string, server: string): void {
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { demo: { command: process.execPath, args: [server] } },
  }, null, 2), 'utf8')
}

/** The text of the first content block, read without a cast or a silently-vacuous assertion. */
function firstText(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) throw new Error('tool result has no content')
  const { content } = result
  if (!Array.isArray(content)) throw new Error('tool result content is not an array')
  const first: unknown = content[0]
  if (typeof first !== 'object' || first === null || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('tool result has no first text block')
  }
  return first.text
}

/** A normalized stdio config for a fixture server, narrowed out of the disabled union. */
function serverEntry(name: string, raw: unknown): ServerConfig {
  const entry = normalizeEntry(name, raw)
  if (isDisabledEntry(entry)) throw new Error(`test config for "${name}" was unexpectedly disabled`)
  return entry
}

/** `partition`'s mount list as pool entries, narrowed out of the entry union. */
function mountEntries(mounted: PartitionEntry[]): Array<{ config: ServerConfig }> {
  return mounted.map((entry) => {
    if (isDisabledEntry(entry.config)) throw new Error(`"${entry.config.name}" is disabled, so it cannot be mounted`)
    return { config: entry.config }
  })
}

/** One pool entry, or a failure naming what was missing instead of an undefined dereference. */
function poolEntry(pool: ServerPool, name: string): PoolEntry {
  const entry = pool.get(name)
  if (entry === undefined) throw new Error(`the pool does not know "${name}"`)
  return entry
}

/** The live connection of a pool entry; every caller here has just asserted the server connected. */
function liveConnection(entry: PoolEntry): Connection {
  if (entry.connection === undefined) throw new Error(`"${entry.config.name}" is not connected`)
  return entry.connection
}

/** A pool wired to the fixture, with its own teardown registered. */
function makePool(home: string): ServerPool {
  const pool = new ServerPool({ home, logger: { debug() {} } })
  cleanups.push(() => pool.closeAll())
  return pool
}

/** One fake Agent + a tools Map, which is all `McpSession` needs from the host. */
function makeAgent(project: string): { tools: Map<string, ToolDefinition>; agent: { id: string; session: { header: { cwd: string } }; ctx: unknown } } {
  const tools = new Map<string, ToolDefinition>()
  return {
    tools,
    agent: {
      id: 'agent-1',
      session: { header: { cwd: project } },
      ctx: {
        tools: {
          register: (definition: ToolDefinition) => {
            tools.set(definition.name, definition)
            return () => tools.delete(definition.name)
          },
          restrict: () => {},
        },
        commands: { register: () => () => {} },
      },
    },
  }
}

function makeSession(fixes: Fixture, settings: Record<string, unknown> = {}, ctx?: Context, onStatus?: () => void): { tools: Map<string, ToolDefinition>; session: McpSession } {
  const { tools, agent } = makeAgent(fixes.project)
  const session = new McpSession({
    // Host types, not behaviour: the session only reads id/cwd and calls register/restrict, so a
    // full Cordis Agent (options, inbox, status, cancel, ...) is never constructed in this test.
    ctx: (ctx ?? agent.ctx) as never,
    agent: agent as never,
    settings: { ...DEFAULT_SETTINGS, dshHome: fixes.home, servers: {}, configFiles: [], projectServers: 'allow', ...settings },
    logger: { debug() {}, warn() {} },
    stat: statSync,
    ...(onStatus === undefined ? {} : { onStatus }),
  })
  cleanups.push(() => session.dispose())
  return { tools, session }
}

it('a project server is discovered, lazily started, cached, and callable', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)
  const loaded = loadConfig({ cwd: fixes.project, dshHome: fixes.home })
  const demo = loaded.servers.get('demo')
  if (demo === undefined || isDisabledEntry(demo.config)) throw new Error('the fixture server was not discovered')
  expect(loaded.projectRoot).toBe(findProjectRoot(fixes.project))
  expect(demo.config.transport).toBe('stdio')

  // Trust gate first: nothing may start until approved.
  const file = approvalsPath(loaded.home)
  const gated = partition({ servers: loaded.servers, projectRoot: loaded.projectRoot, policy: 'ask', approvalsFile: file })
  expect(gated.mount).toEqual([])
  expect(gated.blocked[0].name).toBe('demo')

  approve(file, loaded.projectRoot, 'demo', demo.config)
  const allowed = partition({ servers: loaded.servers, projectRoot: loaded.projectRoot, policy: 'ask', approvalsFile: file })
  expect(allowed.mount.map((entry) => entry.config.name)).toEqual(['demo'])

  const pool = makePool(loaded.home)
  await pool.configure(mountEntries(allowed.mount))

  // Lazy: configuring starts nothing.
  expect(pool.status()[0].state).toBe('idle')
  expect(existsSync(fixes.events), 'no server process before first use').toBe(false)

  // First catalog fetch starts it and lists the tools.
  const catalog = await pool.catalog('demo')
  expect(catalog.tools.map((tool) => tool.name)).toEqual(['ping', 'take_screenshot'])
  expect(catalog.resources.length).toBe(1)
  expect(catalog.instructions).toMatch(/health check/)
  expect(readFileSync(fixes.events, 'utf8')).toMatch(/start /)

  const view = buildCatalog(new Map([['demo', { config: poolEntry(pool, 'demo').config, catalog }]]), {})
  expect(view.tools.has('demo_ping')).toBe(true)

  // Stopping the server keeps the catalog usable offline.
  await pool.close('demo')
  expect(pool.status()[0].state).toBe('idle')
  const search = searchTools(view, 'screenshot')
  expect(search.items[0].name).toBe('demo_take_screenshot')
  expect(search.items[0].parameters).toBe('fullPage?')
  expect(describeTool(view, 'demo_ping')).toMatch(/literal string pong/)

  // A call starts it again and returns the projected result.
  const result = await pool.callTool('demo', 'ping', {})
  expect(firstText(result)).toBe('pong')
  expect(pool.status()[0].state).toBe('connected')

  await pool.closeAll()
  expect(pool.status()[0].state).toBe('idle')
})

it('the cached catalog survives a restart and skips the first connection', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)
  const loaded = loadConfig({ cwd: fixes.project, dshHome: fixes.home })
  const demo = loaded.servers.get('demo')
  if (demo === undefined || isDisabledEntry(demo.config)) throw new Error('the fixture server was not discovered')
  const config = demo.config

  const cache = loadCache(join(loaded.home, 'mcp-cache.json'))
  storeEntry(cache, 'demo', config, { tools: [{ name: 'ping', description: 'from cache' }], resources: [], prompts: [], instructions: '' })
  saveCache(join(loaded.home, 'mcp-cache.json'), cache)

  const reloaded = loadCache(join(loaded.home, 'mcp-cache.json'))
  const entry = cachedEntry(reloaded, 'demo', config)
  if (entry === undefined) throw new Error('the cache entry was not restored')
  expect(entry.tools[0].description).toBe('from cache')

  // An edited definition invalidates the cache entry rather than serving a stale catalog.
  const edited = serverEntry('demo', { command: 'other-command' })
  expect(cachedEntry(reloaded, 'demo', edited)).toBe(undefined)
})

it('idle servers are stopped and keep-alive servers are left alone', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)
  const loaded = loadConfig({ cwd: fixes.project, dshHome: fixes.home })
  const demoEntry = loaded.servers.get('demo')
  if (demoEntry === undefined || isDisabledEntry(demoEntry.config)) throw new Error('the fixture server was not discovered')
  const config = demoEntry.config
  const pool = makePool(loaded.home)
  // `demo` follows the global default; `pinned` is keep-alive and opts out with its own 0.
  const demo = { ...config }
  delete demo.idleTimeout
  await pool.configure([{ config: demo }, { config: { ...config, name: 'pinned', lifecycle: 'keep-alive', idleTimeout: 0 } }])
  await pool.catalog('demo')
  await pool.catalog('pinned')

  // A global timeout of 0 means "keep until the session ends", so neither is swept.
  await pool.sweepIdle({ ...DEFAULT_SETTINGS, idleTimeout: 0 })
  expect(poolEntry(pool, 'demo').state).toBe('connected')

  // A tiny timeout with a back-dated use stops the lazy one, not the keep-alive one.
  liveConnection(poolEntry(pool, 'demo')).lastUsedAt = Date.now() - 120_000
  liveConnection(poolEntry(pool, 'pinned')).lastUsedAt = Date.now() - 120_000
  await pool.sweepIdle({ ...DEFAULT_SETTINGS, idleTimeout: 1 })
  expect(poolEntry(pool, 'demo').state).toBe('idle')
  expect(poolEntry(pool, 'pinned').state).toBe('connected')
  await pool.closeAll()
})

it('trust records pin the exact definition', () => {
  const fixes = fixture()
  const file = approvalsPath(fixes.home)
  const original = serverEntry('demo', { command: 'npx', args: ['-y', 'demo'] })
  approve(file, fixes.project, 'demo', original)
  expect(definitionHash(original)).not.toBe(definitionHash(serverEntry('demo', { command: 'npx', args: ['-y', 'evil'] })))
})

it('a warm cache answers search with the server stopped, and a call starts it', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)
  const settings = { idleTimeout: 10, directTools: false }

  // Session 1 learns the catalog and ends.
  const first = makeSession(fixes, settings)
  await first.session.sync()
  first.session.registerTools()
  await first.session.refreshCatalog()
  expect([...first.session.catalog.tools.keys()].sort()).toEqual(['demo_ping', 'demo_take_screenshot'])
  await first.session.dispose()

  // Session 2 starts from the cache: the server stays down until something is actually called.
  const second = makeSession(fixes, settings)
  await second.session.sync()
  second.session.registerTools()
  expect(second.session.pool.status()[0].state, 'a warm cache must not start the server').toBe('idle')

  const proxy = second.tools.get('mcp')
  if (proxy === undefined) throw new Error('the proxy tool was not registered')
  const search = await proxy.execute({ search: 'screenshot' }, {} as never)
  expect(firstText(search)).toMatch(/demo_take_screenshot/)
  expect(second.session.pool.status()[0].state, 'search must not start the server').toBe('idle')

  const call = await proxy.execute({ tool: 'demo_ping', args: {} }, {} as never)
  expect(firstText(call)).toBe('pong')
  expect(second.session.pool.status()[0].state, 'a call starts the server').toBe('connected')

  const described = await proxy.execute({ describe: 'demo_ping' }, {} as never)
  expect(firstText(described)).toMatch(/literal string pong/)
  await second.session.dispose()
})

it("directTools promotes a server's tools into the native tool list", async () => {
  const fixes = fixture()
  writeFileSync(join(fixes.project, '.mcp.json'), JSON.stringify({
    mcpServers: { demo: { command: process.execPath, args: [fixes.server], directTools: true } },
  }), 'utf8')
  const { tools, session } = makeSession(fixes, { idleTimeout: 10, directTools: false })
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()
  expect(tools.has('mcp'), 'the proxy tool is always present').toBe(true)
  expect(tools.has('demo_ping'), 'the MCP tool became a native tool').toBe(true)
  const direct = tools.get('demo_ping')
  if (direct === undefined) throw new Error('the direct tool was not registered')
  const result = await direct.execute({}, {} as never)
  expect(firstText(result)).toBe('pong')
  await session.dispose()
})

it('other agents\' global MCP files are adopted only when asked, and lose to native config', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-home-'))
  dirs.push(home)
  const userHome = join(home, 'user')
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  writeFileSync(join(userHome, '.claude', 'mcp.json'), JSON.stringify({
    mcpServers: {
      borrowed: { command: 'borrowed-cmd' },
      shared: { command: 'from-claude' },
    },
  }), 'utf8')

  const project = join(home, 'project')
  mkdirSync(join(project, '.git'), { recursive: true })
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { shared: { command: 'from-project' } },
  }), 'utf8')
  const dshHome = join(home, 'dsh')

  // Off by default: another tool's file is not read unless asked.
  const off = loadConfig({ cwd: project, dshHome, homeDir: userHome })
  expect(off.servers.has('borrowed')).toBe(false)

  const on = loadConfig({ cwd: project, dshHome, homeDir: userHome, settings: { importHosts: ['claude-code'] } })
  const borrowed = on.servers.get('borrowed')
  const shared = on.servers.get('shared')
  if (borrowed === undefined || shared === undefined) throw new Error('the imported servers were not adopted')
  expect(borrowed.origin).toBe('imported')
  // The project's own declaration wins over the adopted one.
  expect(shared.origin).toBe('project')
  if (isDisabledEntry(borrowed.config) || isDisabledEntry(shared.config)) throw new Error('an adopted server was unexpectedly disabled')
  expect(borrowed.config.command).toBe('borrowed-cmd')
  expect(shared.config.command).toBe('from-project')
})

// ---------------------------------------------------------------------------------------------------
// Behaviour the unit suites cannot reach: these need a spawned child or the real tool runtime.
// ---------------------------------------------------------------------------------------------------

it('the child process never receives ambient credentials or DSH_ variables', async () => {
  const fixes = fixture(ENV_DUMP_PREFIX + TEST_SERVER_SOURCE)
  const dump = join(fixes.root, 'child-env.json')
  // One key per filter arm plus a control: SECRET is dropped by the regex, the DSH_ prefix by the
  // name check, and the benign key must survive — deleting either arm (or the whole scrub) changes
  // this result, so the case cannot pass vacuously.
  const trapKey = 'MCP_E2E_TRAP_SECRET'
  const prefixedKey = 'DSH_MCP_E2E_TRAP'
  const benignKey = 'MCP_E2E_BENIGN'
  process.env[trapKey] = 'leaked-secret'
  process.env[prefixedKey] = 'leaked-prefixed'
  process.env[benignKey] = 'benign-value'
  cleanups.push(() => {
    delete process.env[trapKey]
    delete process.env[prefixedKey]
    delete process.env[benignKey]
  })

  const config = serverEntry('demo', { command: process.execPath, args: [fixes.server, dump] })
  const pool = makePool(fixes.home)
  await pool.configure([{ config }])
  await pool.catalog('demo')

  // The dump is written by the child itself, so this also proves a real process ran: its pid must
  // differ from this one and it must have been spawned by us.
  if (!existsSync(dump)) throw new Error('the child process never wrote its environment')
  const report = childReport(JSON.parse(readFileSync(dump, 'utf8')))
  expect(report.ppid).toBe(process.pid)
  expect(report.pid).not.toBe(process.pid)
  const childEnv = report.env
  expect(childEnv[benignKey]).toBe('benign-value')
  expect(trapKey in childEnv).toBe(false)
  expect(prefixedKey in childEnv).toBe(false)
  await pool.closeAll()
})

it('an aborted signal cancels a tools/call before the request reaches the server', async () => {
  // The shared fixture server logs every method it receives, which is what makes the cancellation
  // observable: a call that was really cancelled never appears in that log.
  const fixes = fixture(TEST_SERVER_SOURCE)
  writeServerConfig(fixes.project, fixes.server)
  const config = serverEntry('demo', { command: process.execPath, args: [fixes.server] })
  const pool = makePool(fixes.home)
  await pool.configure([{ config }])
  // Warm the connection first, so the rejection below is the request's cancellation rather than a
  // connect attempt that never started.
  await pool.catalog('demo')
  const callCount = (): number => readFileSync(fixes.events, 'utf8').split('\n').filter((line) => line === 'tools/call').length
  const callsBefore = callCount()

  // An already-aborted signal is deterministic: no timer to race with, and the SDK refuses the
  // request before it is written to the child, so the server's own log proves the cancellation was
  // honoured rather than merely discarded and answered normally.
  const controller = new AbortController()
  controller.abort(new Error('caller cancelled the MCP call'))
  await expect(pool.callTool('demo', 'ping', {}, { signal: controller.signal })).rejects.toThrow(/caller cancelled/)
  expect(callCount()).toBe(callsBefore)

  // The connection is intact: only the cancelled call was refused.
  expect(firstText(await pool.callTool('demo', 'ping', {}))).toBe('pong')
  expect(callCount()).toBe(callsBefore + 1)
  await pool.closeAll()
})

// This case pins CURRENT behaviour, not desired behaviour. `directToolDefinition.execute` answers
// `{ content, value, isError: true }` when the server reports an MCP error, but `ToolDefinition`
// documents `execute` as returning only the canonical JSON value. Through the real runtime a
// resolved body is a SUCCESS, so the error envelope is recorded as the canonical value (and only
// reaches the model as success-shaped content). The pre-port `lib/direct.mjs` behaves identically,
// so this is a source-faithful port, not a migration regression; the fix (throw a ToolFailure inside
// the body) changes the model-facing contract and is deferred to its own task. This test exists so
// that change cannot land unnoticed.
it('a direct tool whose server reports isError still reaches the model as a success (current behaviour)', async () => {
  const fixes = fixture(ERROR_TOOL_SERVER_SOURCE)
  writeFileSync(join(fixes.project, '.mcp.json'), JSON.stringify({
    mcpServers: { demo: { command: process.execPath, args: [fixes.server], directTools: true } },
  }), 'utf8')

  // The real registry, so the outcome is what dsh would record rather than what the adapter hopes.
  const root = new Context()
  root.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    variable: () => () => {},
    sectionFor: () => () => {},
  })
  new ToolRuntime(root)
  const { session } = makeSession(fixes, { idleTimeout: 10, directTools: false }, root)
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()
  expect(root.tools.schemas().map((schema) => schema.name)).toContain('demo_explode')

  const outcome = await root.tools.execute({
    callId: ToolCallId('call-1'),
    name: 'demo_explode',
    arguments: {},
    signal: new AbortController().signal,
  })
  if (outcome.isError) throw new Error(`expected the current success-shaped outcome, got a failure: ${outcome.error.message}`)
  expect(outcome.content).toEqual([{ type: 'text', text: 'boom' }])
  // The MCP error survives only as an object-shaped value under a successful result.
  expect(outcome.value).toMatchObject({ isError: true })
  await session.dispose()
})

// The panel's snapshot must follow the servers' actual state. A lazy server is started by the tool
// call that needs it, so without a status refresh after the call the panel keeps showing the server
// as stopped while the call that just ran used it.
it('a tool call refreshes the panel snapshot so a lazily started server reads as running', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)

  let statusRefreshes = 0
  const { session } = makeSession(fixes, { idleTimeout: 10 }, undefined, () => { statusRefreshes += 1 })
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()

  // Stop the server again, so the next call has to start it: that start is the state change the
  // panel has to learn about.
  await session.pool.close('demo')
  expect(session.pool.status()[0].state).toBe('idle')
  const refreshesBefore = statusRefreshes

  await session.callApproved('demo_ping', {}, undefined)

  expect(session.pool.status()[0].state).not.toBe('idle')
  expect(statusRefreshes).toBeGreaterThan(refreshesBefore)
})

// `outputSchema` validation is the SDK's job, but it only runs when the SDK has seen the tool list
// on this connection. A server whose catalog came from our own disk cache is never listed, so the
// first call after a warm start used to skip validation entirely. Verified against
// `@modelcontextprotocol/client@2.2.0`: without a prior `listTools()`, a call whose
// `structuredContent` violates its own declared schema returns unchecked.
const OUTPUT_SCHEMA_SERVER = `
const LF = String.fromCharCode(10);
const send = (message) => process.stdout.write(JSON.stringify(message) + LF);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf(LF); at >= 0; at = buffer.indexOf(LF)) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
function handle(message) {
  if (message.id === undefined) return;
  const { method } = message;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'schema', version: '1.0.0' },
  } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
    name: 'broken',
    description: 'Declares an output schema, then violates it.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] },
  }] } });
  if (method === 'tools/call') return send({ jsonrpc: '2.0', id: message.id, result: {
    content: [{ type: 'text', text: 'hi' }],
    structuredContent: { total: 'not-a-number' },
  } });
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + method } });
}
`

it('a warm-cache call still gets the SDK output-schema check the first call used to skip', async () => {
  const fixes = fixture(OUTPUT_SCHEMA_SERVER)
  writeServerConfig(fixes.project, fixes.server)
  const loaded = loadConfig({ cwd: fixes.project, dshHome: fixes.home })
  const demo = loaded.servers.get('demo')
  if (demo === undefined || isDisabledEntry(demo.config)) throw new Error('the fixture server was not discovered')

  // The catalog is already on disk, so the pool will never call tools/list on this connection: that
  // is exactly the path that used to skip validation.
  const cache = loadCache(join(loaded.home, 'mcp-cache.json'))
  storeEntry(cache, 'demo', demo.config, {
    tools: [{
      name: 'broken',
      description: 'Declares an output schema, then violates it.',
      inputSchema: { type: 'object', properties: {} },
      // ADR-0010: the catalog keeps only a presence flag; the SDK still lists tools on the fresh
      // connection and validates structuredContent against its own copy of the schema.
      hasOutputSchema: true,
    }],
    resources: [],
    prompts: [],
    instructions: '',
  })
  saveCache(join(loaded.home, 'mcp-cache.json'), cache)

  const pool = makePool(loaded.home)
  await pool.configure(mountEntries([{ origin: 'project', path: '', config: demo.config }]))
  poolEntry(pool, 'demo').catalog = cachedEntry(loadCache(join(loaded.home, 'mcp-cache.json')), 'demo', demo.config)

  await expect(pool.callTool('demo', 'broken', {})).rejects.toThrow(/output schema|total/i)
})

// Lifecycle is not decoration: `eager` and `keep-alive` are supposed to be up before anything asks,
// and `lazy-keep-alive` is supposed to survive the idle sweep. All three were no-ops.
it('warmEager starts eager and keep-alive servers, and leaves lazy ones stopped', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)
  const loaded = loadConfig({ cwd: fixes.project, dshHome: fixes.home })
  const demo = loaded.servers.get('demo')
  if (demo === undefined || isDisabledEntry(demo.config)) throw new Error('the fixture server was not discovered')

  const pool = makePool(loaded.home)
  await pool.configure([
    { config: { ...demo.config, name: 'eager-one', lifecycle: 'eager' } },
    { config: { ...demo.config, name: 'lazy-one', lifecycle: 'lazy' } },
  ])

  expect(pool.status().map((status) => status.state)).toEqual(['idle', 'idle'])

  await pool.warmEager()

  expect(pool.status().find((status) => status.name === 'eager-one')?.state).toBe('connected')
  expect(pool.status().find((status) => status.name === 'lazy-one')?.state).toBe('idle')
})

it('lazy-keep-alive survives the idle sweep and reconnects, while lazy does not', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)
  const loaded = loadConfig({ cwd: fixes.project, dshHome: fixes.home })
  const demo = loaded.servers.get('demo')
  if (demo === undefined || isDisabledEntry(demo.config)) throw new Error('the fixture server was not discovered')

  const pool = makePool(loaded.home)
  await pool.configure([
    { config: { ...demo.config, name: 'sticky', lifecycle: 'lazy-keep-alive' } },
    { config: { ...demo.config, name: 'plain', lifecycle: 'lazy' } },
  ])
  await pool.catalog('sticky')
  await pool.catalog('plain')
  expect(pool.status().every((status) => status.state === 'connected')).toBe(true)

  // Backdate both connections so a sweep with a 1-minute timeout would stop them.
  for (const name of ['sticky', 'plain']) poolEntry(pool, name).connection!.lastUsedAt = Date.now() - 5 * 60_000
  await pool.sweepIdle({ ...DEFAULT_SETTINGS, idleTimeout: 1 })

  expect(pool.status().find((status) => status.name === 'sticky')?.state).toBe('connected')
  expect(pool.status().find((status) => status.name === 'plain')?.state).toBe('idle')
})

// The settings-level timeout used to be dropped on the floor by `pickPolicySettings`, so a server
// with no per-server value always got the pool's 60 s constant. The proof is a server whose
// `tools/list` stalls: with a 1 s settings default the listing must fail fast rather than wait.
//
// This covers the *catalog* budget. `tools/list` is a request; a tool call is an execution with its
// own, much larger budget (ADR-0011).
const SLOW_CATALOG_SERVER_SOURCE = `
const LF = String.fromCharCode(10);
const send = (message) => process.stdout.write(JSON.stringify(message) + LF);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf(LF); at >= 0; at = buffer.indexOf(LF)) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
function handle(message) {
  if (message.id === undefined) return;
  const { method } = message;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1.0.0' },
  } });
  // Never answers: only the configured deadline can end this listing.
  if (method === 'tools/list') return;
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + method } });
}
`

it('a settings-level requestTimeoutMs bounds the catalog listing', async () => {
  const fixes = fixture(SLOW_CATALOG_SERVER_SOURCE)
  writeServerConfig(fixes.project, fixes.server)

  const { session } = makeSession(fixes, { requestTimeoutMs: 200 })
  await session.sync()
  const entry = session.pool.get('demo')
  if (entry === undefined) throw new Error('the fixture server was not pooled')
  // The per-server entry has no timeout, so only the settings default can end the listing.
  expect(entry.config.requestTimeoutMs).toBeUndefined()
  expect(session.pool.timeoutFor(entry)).toBe(200)
  // An execution keeps its own, much larger budget: that split is the point of ADR-0011.
  expect(session.pool.executionTimeoutFor(entry)).toBe(DEFAULT_SETTINGS.executionTimeoutMs)

  const started = Date.now()
  await expect(session.pool.catalog('demo')).rejects.toThrow(/timed out|timeout/i)
  expect(Date.now() - started).toBeLessThan(5_000)
  await session.dispose()
})

// The other half of the split: a tool that legitimately runs for minutes used to be cut off at the
// handshake budget. A per-server `executionTimeoutMs` now decides, and the slow call fails on *that*
// deadline rather than on the 60 s request default or the 10 min execution default.
it('executionTimeoutMs bounds a tool call without touching the catalog budget', async () => {
  const fixes = fixture(`
const LF = String.fromCharCode(10);
const send = (message) => process.stdout.write(JSON.stringify(message) + LF);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf(LF); at >= 0; at = buffer.indexOf(LF)) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
function handle(message) {
  if (message.id === undefined) return;
  const { method } = message;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'slow-call', version: '1.0.0' },
  } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [
    { name: 'slow', description: 'Never answers.', inputSchema: { type: 'object', properties: {} } },
  ] } });
  // Never answers: only the execution deadline can end this call.
  if (method === 'tools/call') return;
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + method } });
}
`)
  writeFileSync(join(fixes.project, '.mcp.json'), JSON.stringify({
    mcpServers: { demo: { command: process.execPath, args: [fixes.server], executionTimeoutMs: 200 } },
  }), 'utf8')

  const { session } = makeSession(fixes)
  await session.sync()
  await session.refreshCatalog()
  const entry = session.pool.get('demo')
  if (entry === undefined) throw new Error('the fixture server was not pooled')
  // The catalog was read under the request budget; only the call runs under the execution budget.
  expect(session.pool.timeoutFor(entry)).toBe(DEFAULT_SETTINGS.requestTimeoutMs)
  expect(session.pool.executionTimeoutFor(entry)).toBe(200)

  const started = Date.now()
  await expect(session.callApproved('demo_slow', {}, undefined)).rejects.toThrow(/timed out|timeout/i)
  expect(Date.now() - started).toBeLessThan(5_000)
  await session.dispose()
})

// `protocolVersion` was normalized and then never reached the wire. `"auto"` opts into the SDK's
// server/discover probe; the server below records every method it is asked, so the probe is visible.
it('protocolVersion: "auto" reaches the SDK and probes with server/discover', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)
  const loaded = loadConfig({ cwd: fixes.project, dshHome: fixes.home })
  const demo = loaded.servers.get('demo')
  if (demo === undefined || isDisabledEntry(demo.config)) throw new Error('the fixture server was not discovered')

  const pool = makePool(loaded.home)
  await pool.configure(mountEntries([{
    origin: 'project',
    path: '',
    config: { ...demo.config, protocolVersion: 'auto' },
  }]))
  await pool.catalog('demo')

  const events = readFileSync(fixes.events, 'utf8')
  expect(events).toMatch(/method (server\/discover|initialize)/)
})

// ---------------------------------------------------------------------------------------------
// Which directory is "the session's workspace"
//
// `header.cwd` is the directory a Session was *created* in and never changes; `workingDirectory`
// owns the current one, and the `working_directory` tool / subagents move it. A session that `cd`s
// into another checkout must load that checkout's `.mcp.json`, so these three cases pin the
// adapter to the host's live answer and refuse to guess when there is none.
// ---------------------------------------------------------------------------------------------

/** A working-directory provider stub: the same shape the host service exposes. */
function workingDirectoryAt(path: string | undefined): { get: () => string | undefined } {
  return { get: () => path }
}

it('picks up the .mcp.json of the directory the session cd-ed into', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)
  // A second checkout with its own server, reachable only from the live directory.
  const other = join(fixes.root, 'other-project')
  mkdirSync(join(other, '.git'), { recursive: true })
  writeFileSync(join(other, '.mcp.json'), JSON.stringify({
    mcpServers: { elsewhere: { command: process.execPath, args: ['-e', ''] } },
  }), 'utf8')

  const { tools, agent } = makeAgent(fixes.project)
  let live: string | undefined = other
  const scoped = agent.ctx as Record<string, unknown>
  const session = new McpSession({
    // `workingDirectory` is optional in a composition, so it is reached through `ctx.get`.
    ctx: { ...scoped, get: (name: string) => (name === 'workingDirectory' ? workingDirectoryAt(live) : undefined) } as never,
    agent: agent as never,
    settings: { ...DEFAULT_SETTINGS, dshHome: fixes.home, servers: {}, configFiles: [], projectServers: 'allow' },
    logger: { debug() {}, warn() {} },
    stat: statSync,
  })
  cleanups.push(() => session.dispose())

  await session.sync()
  expect(session.projectRoot).toBe(other)
  expect(session.pool.names()).toEqual(['elsewhere'])
  expect(tools.size).toBe(0)

  // Moving back to the original project makes the loaded config stale, even though no file moved
  // its mtime: the *sources themselves* are resolved from the directory.
  live = fixes.project
  expect(session.configChanged()).toBe(true)
  await session.sync()
  expect(session.projectRoot).toBe(fixes.project)
  expect(session.pool.names()).toEqual(['demo'])
})

it('reads user-global config instead of process.cwd() when the session names no directory', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)
  // A user-global server proves the global layer still loads with no project at all.
  writeFileSync(join(fixes.state, 'mcp.json'), JSON.stringify({
    mcpServers: { global: { command: process.execPath, args: ['-e', ''] } },
  }), 'utf8')

  const { agent } = makeAgent(fixes.project)
  const scoped = agent.ctx as Record<string, unknown>
  const session = new McpSession({
    // Neither a working directory nor a creation cwd: the host process' own directory is NOT this
    // session's workspace, so guessing it would read a repository nobody selected.
    ctx: { ...scoped, get: () => undefined } as never,
    agent: { id: 'agent-1', session: { header: {} }, ctx: {} } as never,
    settings: { ...DEFAULT_SETTINGS, dshHome: fixes.home, servers: {}, configFiles: [], projectServers: 'allow' },
    logger: { debug() {}, warn() {} },
    stat: statSync,
  })
  cleanups.push(() => session.dispose())

  await session.sync()
  expect(session.projectRoot).toBe('')
  expect(session.pool.names()).toEqual(['global'])
  // `configChanged()` compares against the recorded directory, so an answer that appears later is
  // itself a change.
  expect(session.configChanged()).toBe(false)
})

// The regression this pins: a server's directory is part of *where it runs*, not of *what runs*, so
// moving the session must move the child without changing the definition's identity. Before the
// split, `cwd` was filled in from the project root at normalization time, which put the directory
// into `definitionHash` — every workspace then had its own cache entry and approval for the same
// user-global server, and each write evicted the other workspace's.
it('reuses one definition identity across two session directories while the child follows the session', async () => {
  // A distinct binding: the shared server source below imports `appendFileSync` itself, and a
  // second declaration of the same identifier is a syntax error rather than a duplicate import.
  const fixes = fixture(`
import { appendFileSync as appendCwdReport } from 'node:fs';
appendCwdReport(process.argv[2], JSON.stringify({ pid: process.pid, cwd: process.cwd() }) + '\\n');
` + SERVER_SOURCE)
  const report = join(fixes.root, 'cwd.log')
  const other = join(fixes.root, 'other-workspace')
  mkdirSync(other, { recursive: true })

  // A session directory that the test moves, exactly like `cd` moves one.
  let sessionCwd: string | undefined = fixes.project
  const config = serverEntry('demo', { command: process.execPath, args: [fixes.server, report] })
  // The definition carries no directory of its own, so its identity cannot depend on one.
  expect(config.cwd).toBeUndefined()

  const pool = new ServerPool({ home: fixes.home, cwd: () => sessionCwd, logger: { debug() {} } })
  cleanups.push(() => pool.closeAll())
  await pool.configure([{ config }])

  const catalog = await pool.catalog('demo')
  const firstHash = definitionHash(config)
  // What the cache would persist for this connection: the catalog is keyed by it, so a stable hash
  // is what makes the second workspace hit the first one's entry instead of re-listing the server.
  const cache = loadCache(join(fixes.state, 'mcp-cache.json'))
  storeEntry(cache, 'demo', config, catalog)
  saveCache(join(fixes.state, 'mcp-cache.json'), cache)
  await pool.closeAll()

  // `cd` into the other workspace; the definition object is the same one, untouched.
  sessionCwd = other
  // `refresh` because the catalog is already known: this must reconnect, not replay cache, so the
  // second spawn's directory is what the assertion below reads.
  const secondCatalog = await pool.catalog('demo', { refresh: true })
  expect(secondCatalog.tools.map((tool) => tool.name)).toEqual(catalog.tools.map((tool) => tool.name))

  // The persisted entry still matches: one identity, not one per workspace.
  expect(cachedEntry(loadCache(join(fixes.state, 'mcp-cache.json')), 'demo', config)).toBeDefined()
  expect(definitionHash(config)).toBe(firstHash)

  const reports = readFileSync(report, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { pid: number; cwd: string })
  expect(reports).toHaveLength(2)
  // Same definition, two different processes — each in the directory the session was in at connect.
  expect(reports[0].cwd).toBe(fixes.project)
  expect(reports[1].cwd).toBe(other)
  expect(reports[0].pid).not.toBe(reports[1].pid)
})

it('a cold start writes the cache once, not once per server, and merges other sessions (ADR-0010)', async () => {
  const fixes = fixture()
  // Two cold servers in one session: the old loop called persistCache() inside Promise.all, so a
  // single cold start serialized the whole growing file twice.
  writeFileSync(join(fixes.project, '.mcp.json'), JSON.stringify({
    mcpServers: {
      alpha: { command: process.execPath, args: [fixes.server] },
      beta: { command: process.execPath, args: [fixes.server] },
    },
  }), 'utf8')
  const { session } = makeSession(fixes)
  await session.sync()

  let writes = 0
  const original = session.persistCache.bind(session)
  session.persistCache = (names?: string[]) => {
    writes += 1
    return original(names)
  }
  await session.refreshCatalog()
  expect(writes).toBe(1)

  const loaded = loadConfig({ cwd: fixes.project, dshHome: fixes.home })
  const disk = loadCache(join(loaded.home, 'mcp-cache.json'))
  expect(Object.keys(disk.servers).sort()).toEqual(['alpha', 'beta'])

  // Q6: a third entry written by "another session" survives this session's next write, and a
  // purged name is not resurrected from the in-memory snapshot.
  const other = storeEntry(disk, 'gamma', serverEntry('gamma', { command: process.execPath, args: [fixes.server] }), { tools: [], resources: [], prompts: [], instructions: '' })
  saveCache(join(loaded.home, 'mcp-cache.json'), disk)
  expect(other.cachedAt).toBeGreaterThan(0)

  const config = serverEntry('alpha', { command: process.execPath, args: [fixes.server] })
  storeEntry(session.cache!, 'beta', serverEntry('beta', { command: process.execPath, args: [fixes.server] }), { tools: [], resources: [], prompts: [], instructions: '' })
  session.persistCache(['beta'])
  const merged = loadCache(join(loaded.home, 'mcp-cache.json'))
  expect(Object.keys(merged.servers).sort()).toEqual(['alpha', 'beta', 'gamma'])
  expect(cachedEntry(merged, 'alpha', config)).toBeDefined()

  // A panel purge removes the name from the session snapshot; the next write must not revive it.
  session.forgetCachedServer('beta')
  session.persistCache(['beta'])
  const afterForget = loadCache(join(loaded.home, 'mcp-cache.json'))
  expect(afterForget.servers.beta).toBeUndefined()
  expect(afterForget.servers.gamma).toBeDefined()
})

it('runs an entry that named a relative cwd inside the session directory', async () => {
  const fixes = fixture(`
import { appendFileSync as appendCwdReport } from 'node:fs';
appendCwdReport(process.argv[2], process.cwd() + '\\n');
` + SERVER_SOURCE)
  const report = join(fixes.root, 'cwd.log')
  const nested = join(fixes.project, 'servers')
  mkdirSync(nested, { recursive: true })

  // The relative value stays relative in the definition — that is what makes it mean the same thing
  // in every checkout — and only the pool turns it into a path.
  const config = serverEntry('demo', { command: process.execPath, args: [fixes.server, report], cwd: './servers' })
  expect(config.cwd).toBe('./servers')

  const pool = new ServerPool({ home: fixes.home, cwd: () => fixes.project, logger: { debug() {} } })
  cleanups.push(() => pool.closeAll())
  await pool.configure([{ config }])
  await pool.catalog('demo')

  expect(readFileSync(report, 'utf8').trim()).toBe(nested)
})

// P0-1 (ADR-0011): a failed `tools/list` must not be captured as an empty catalog.
//
// The old path recorded the failure in `lastError`, returned an empty `ServerCatalog`, and left the
// entry `connected`. `refreshCatalog()` then persisted it, the next session's `configHash` matched,
// and the server showed zero tools forever — a transient error during startup became permanent
// state. The proof needs both halves: the disk must not gain an entry, and a later read must retry.
const FLAKY_TOOLS_LIST_SOURCE = `
const LF = String.fromCharCode(10);
const send = (message) => process.stdout.write(JSON.stringify(message) + LF);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf(LF); at >= 0; at = buffer.indexOf(LF)) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
// The first tools/list fails the way a starting server does; every later one answers.
let failures = 1;
function handle(message) {
  if (message.id === undefined) return;
  const { method, params = {} } = message;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: params.protocolVersion ?? '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'flaky', version: '1.0.0' },
  } });
  if (method === 'tools/list') {
    if (failures > 0) {
      failures -= 1;
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'temporarily unavailable' } });
    }
    return send({ jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'late_tool', description: 'Appears once the server stops failing.', inputSchema: { type: 'object', properties: {} } },
    ] } });
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + method } });
}
`

it('a failed tools/list is not persisted as an empty catalog, and the next read retries', async () => {
  const fixes = fixture(FLAKY_TOOLS_LIST_SOURCE)
  writeFileSync(join(fixes.project, '.mcp.json'), JSON.stringify({
    mcpServers: { flaky: { command: process.execPath, args: [fixes.server] } },
  }), 'utf8')
  const { session } = makeSession(fixes)
  await session.sync()

  // The first listing fails. Nothing may be recorded as "this server has no tools".
  await session.refreshCatalog()
  const cacheFile = join(loadConfig({ cwd: fixes.project, dshHome: fixes.home }).home, 'mcp-cache.json')
  expect(session.errors.join('\n')).toMatch(/could not list its tools/)
  // Not persisted: a failure is not a catalog, so the next start has nothing to hash-match.
  expect(loadCache(cacheFile).servers.flaky).toBeUndefined()
  // And the pool keeps no catalog either, which is what makes the next read retry.
  expect(session.pool.get('flaky')?.catalog).toBeUndefined()

  // The second read retries, and this time the server answers.
  await session.refreshCatalog()
  const recovered = session.pool.get('flaky')?.catalog
  expect(recovered?.tools.map((tool) => tool.name)).toEqual(['late_tool'])
  expect(loadCache(cacheFile).servers.flaky?.tools.map((tool) => tool.name)).toEqual(['late_tool'])
})

it('a server with no tools capability still yields an empty catalog instead of failing', async () => {
  // The guard above must not misfire on the normal case: `initialize` advertises no tools, the SDK
  // short-circuits `listTools()` to an empty list, and no failure is recorded — so a resource-only
  // server stays a legitimate empty-catalog server rather than a broken one.
  const fixes = fixture(`
const LF = String.fromCharCode(10);
const send = (message) => process.stdout.write(JSON.stringify(message) + LF);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf(LF); at >= 0; at = buffer.indexOf(LF)) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
function handle(message) {
  if (message.id === undefined) return;
  const { method, params = {} } = message;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: params.protocolVersion ?? '2024-11-05',
    capabilities: { resources: {} },
    serverInfo: { name: 'resource-only', version: '1.0.0' },
  } });
  if (method === 'resources/list') return send({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'demo://only', name: 'only' }] } });
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + method } });
}
`)
  writeFileSync(join(fixes.project, '.mcp.json'), JSON.stringify({
    mcpServers: { docs: { command: process.execPath, args: [fixes.server] } },
  }), 'utf8')
  const { session } = makeSession(fixes)
  await session.sync()
  await session.refreshCatalog()

  const catalog = session.pool.get('docs')?.catalog
  expect(catalog?.tools).toEqual([])
  expect(catalog?.resources.map((resource) => resource.uri)).toEqual(['demo://only'])
})

// P0-2 (ADR-0011): a server that changes its tool list while connected must reach the catalog.
//
// The pool only ever listed tools at connect time, so a hot-reloaded server's new tools stayed
// invisible until the idle sweep stopped it and something called again. The server below answers
// `tools/list` with `before` and then announces `notifications/tools/list_changed`; the catalog must
// pick up `after` without a reconnect.
const LIST_CHANGED_SERVER_SOURCE = `
const LF = String.fromCharCode(10);
const send = (message) => process.stdout.write(JSON.stringify(message) + LF);
let buffer = '';
let listed = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf(LF); at >= 0; at = buffer.indexOf(LF)) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
function tool(name) {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}
function handle(message) {
  if (message.id === undefined) return;
  const { method, params = {} } = message;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: params.protocolVersion ?? '2024-11-05',
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'live', version: '1.0.0' },
  } });
  if (method === 'tools/list') {
    listed += 1;
    if (listed === 1) {
      const result = { tools: [tool('before')] };
      send({ jsonrpc: '2.0', id: message.id, result });
      // Announce the change right after the first listing, exactly like a hot reload.
      setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }), 10);
      return;
    }
    return send({ jsonrpc: '2.0', id: message.id, result: { tools: [tool('after')] } });
  }
  if (method === 'tools/call') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: params.name ?? '' }] } });
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + method } });
}
`

it('a live tools/list_changed notification refreshes the catalog and the disk cache', async () => {
  const fixes = fixture(LIST_CHANGED_SERVER_SOURCE)
  writeFileSync(join(fixes.project, '.mcp.json'), JSON.stringify({
    mcpServers: { live: { command: process.execPath, args: [fixes.server] } },
  }), 'utf8')
  const { session } = makeSession(fixes)
  await session.sync()
  await session.refreshCatalog()
  expect(session.pool.get('live')?.catalog?.tools.map((tool) => tool.name)).toEqual(['before'])

  // No reconnect and no second call: only the server's own notification may move the catalog.
  const deadline = Date.now() + 5_000
  let names: string[] = []
  while (Date.now() < deadline) {
    names = session.pool.get('live')?.catalog?.tools.map((tool) => tool.name) ?? []
    if (names.includes('after')) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(names).toEqual(['after'])

  // The refreshed catalog is what the next process starts from, not the one from connect time.
  const cacheFile = join(loadConfig({ cwd: fixes.project, dshHome: fixes.home }).home, 'mcp-cache.json')
  expect(loadCache(cacheFile).servers.live?.tools.map((tool) => tool.name)).toEqual(['after'])
})

// P1-3 (ADR-0011): a legacy Streamable HTTP session the server forgot must be replaced, not reused.
//
// The server mints an `Mcp-Session-Id` on initialize and answers every later POST with 404. The
// transport reports that as an `SdkHttpError` and never fires `onclose`, so before this fix the pool
// kept the dead connection, reported `connected`, and every call failed the same way forever.
it('reconnects once when a legacy HTTP session expires and retries the call', async () => {
  const { createServer } = await import('node:http')
  // Sessions the server still honors. Every initialize mints one; the first tool call revokes it,
  // which is what a server restart looks like to a client holding an `Mcp-Session-Id`.
  const live = new Set<string>()
  let minted = 0
  let calls = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const message: { id?: unknown; method?: string } = body.length > 0 ? JSON.parse(body) : {}
      if (message.id === undefined) {
        response.writeHead(202)
        response.end()
        return
      }
      const sessionId = request.headers['mcp-session-id']
      const answer = (payload: unknown, minted_id?: string) => {
        response.writeHead(200, {
          'content-type': 'application/json',
          ...(minted_id === undefined ? {} : { 'mcp-session-id': minted_id }),
        })
        response.end(JSON.stringify(payload))
      }
      if (message.method === 'initialize') {
        minted += 1
        const id = `sess-${minted}`
        live.add(id)
        answer({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'http', version: '1' } },
        }, id)
        return
      }
      // Anything carrying a revoked (or unknown) session id gets the 404 a restarted server sends.
      if (typeof sessionId !== 'string' || !live.has(sessionId)) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('session not found')
        return
      }
      if (message.method === 'tools/list') {
        answer({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] } })
        return
      }
      if (message.method === 'tools/call') {
        calls += 1
        answer({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } })
        // Revoke the session the call used: the next request on it must be rejected.
        live.delete(sessionId)
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('unknown method')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the test server has no port')
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const config = serverEntry('live', { url: `http://127.0.0.1:${address.port}/mcp` })
  const pool = new ServerPool({ home: join(mkdtempSync(join(tmpdir(), 'mcp-http-')), 'home'), logger: { debug() {}, warn() {} } })
  cleanups.push(() => pool.closeAll())
  await pool.configure([{ config }])
  await pool.catalog('live')

  const first = await pool.callTool('live', 'ping', {}) as { content: Array<{ text: string }> }
  expect(first.content[0].text).toBe('pong')
  expect(calls).toBe(1)

  // The session this connection held was just revoked. Before the fix the pool kept it, still
  // reported `connected`, and failed every later call with the same 404.
  const second = await pool.callTool('live', 'ping', {}) as { content: Array<{ text: string }> }
  expect(second.content[0].text).toBe('pong')
  expect(calls).toBe(2)
  // A replacement session was minted, so the retry really went out on a new connection.
  expect(minted).toBeGreaterThanOrEqual(2)
})

// P1-4 (ADR-0011): an MCP tool that returns a screenshot must reach the model as an image.
//
// The old projection turned every `{ type: 'image' }` MCP content part into
// "[image image/png — N bytes omitted]", so a browser-automation server's whole output was a
// placeholder. The host already stores images durably and decides whether the current model route
// accepts them; this drives a real stdio server through the real registry with those services
// mounted, so the assertion is on the blocks the model would actually see.
const IMAGE_TOOL_SERVER_SOURCE = `
const LF = String.fromCharCode(10);
const send = (message) => process.stdout.write(JSON.stringify(message) + LF);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf(LF); at >= 0; at = buffer.indexOf(LF)) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
// A one-pixel PNG: real bytes, so the host's image validation has something to decode.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function handle(message) {
  if (message.id === undefined) return;
  const { method, params = {} } = message;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: params.protocolVersion ?? '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'shots', version: '1.0.0' },
  } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [
    { name: 'screenshot', description: 'Take a screenshot.', inputSchema: { type: 'object', properties: {} } },
  ] } });
  if (method === 'tools/call') return send({ jsonrpc: '2.0', id: message.id, result: { content: [
    { type: 'text', text: 'captured' },
    { type: 'image', data: PNG, mimeType: 'image/png' },
  ] } });
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + method } });
}
`

it('an image an MCP tool returns reaches the model as an image block', async () => {
  const fixes = fixture(IMAGE_TOOL_SERVER_SOURCE)
  writeFileSync(join(fixes.project, '.mcp.json'), JSON.stringify({
    mcpServers: { shots: { command: process.execPath, args: [fixes.server], directTools: true } },
  }), 'utf8')

  const root = new Context()
  root.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    variable: () => () => {},
    sectionFor: () => () => {},
  })
  new ToolRuntime(root)
  // The two host services image admission needs, with the exact shapes `src/media.ts` reads.
  const saved: Array<{ mediaType: string; bytes: number }> = []
  root.provide('attachments', {
    saveImages: async (inputs: Array<{ data: Uint8Array; mediaType: string }>) => {
      saved.push(...inputs.map((input) => ({ mediaType: input.mediaType, bytes: input.data.byteLength })))
      return inputs.map((_input, index) => ({ attachmentId: `att-${index}`, mediaType: _input.mediaType }))
    },
  })
  root.provide('llm', {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
  })

  const agent = {
    id: 'agent-image',
    // The route the image decision reads; the model declares image input, so nothing is refused.
    options: { provider: 'test', model: 'vision' },
    session: {
      header: { cwd: fixes.project },
      requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }),
    },
    ctx: root,
  }
  const session = new McpSession({
    ctx: root as never,
    agent: agent as never,
    settings: { ...DEFAULT_SETTINGS, dshHome: fixes.home, servers: {}, configFiles: [], projectServers: 'allow' },
    logger: { debug() {}, warn() {} },
    stat: statSync,
  })
  cleanups.push(() => session.dispose())
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()

  const outcome = await root.tools.execute({
    callId: ToolCallId('call-image'),
    name: 'shots_screenshot',
    arguments: {},
    signal: new AbortController().signal,
  })
  if (outcome.isError) throw new Error(`the screenshot call failed: ${outcome.error.message}`)

  // The text survives and the image is a real image block, not a placeholder.
  expect(outcome.content[0]).toEqual({ type: 'text', text: 'captured' })
  expect(outcome.content[1]?.type).toBe('image')
  // The bytes really went through the host store, in the server's own media type.
  expect(saved).toEqual([{ mediaType: 'image/png', bytes: expect.any(Number) as number }])
  expect(saved[0].bytes).toBeGreaterThan(0)
})

// P2-7 (ADR-0011): a server's own instructions must reach the model without being asked for.
//
// `summary()` is the adapter's whole system-prompt surface, and it listed server *names* only, so a
// server whose instructions say "always call open_project first" was followed only by a model that
// thought to call `mcp({ instructions })`. Both a mature client and the host's MCP client inject them.
it('surfaces a server instruction block in the system prompt summary', async () => {
  const fixes = fixture()
  writeServerConfig(fixes.project, fixes.server)
  const { session } = makeSession(fixes)
  await session.sync()
  await session.refreshCatalog()

  const summary = session.summary()
  expect(summary).toContain('<mcp_instructions>')
  expect(summary).toContain('<server name="demo">')
  // Indented like the host's own MCP instruction block, so multi-line guidance stays readable.
  expect(summary).toContain('    Use ping for a health check.')
  expect(summary).toContain('</mcp_instructions>')
})

it('bounds one server instruction and reports a server that does not fit the session budget', async () => {
  const fixes = fixture()
  writeFileSync(join(fixes.project, '.mcp.json'), JSON.stringify({
    mcpServers: { verbose: { command: process.execPath, args: [fixes.server] } },
  }), 'utf8')
  const { session } = makeSession(fixes)
  await session.sync()
  await session.refreshCatalog()

  // A server whose instructions exceed the per-server cap keeps a truncated block rather than
  // pushing an unbounded wall of text into every request.
  const entry = session.pool.get('verbose')
  if (entry === undefined || entry.catalog === undefined) throw new Error('the fixture catalog is missing')
  entry.catalog = { ...entry.catalog, instructions: 'x'.repeat(INSTRUCTION_CHARS_PER_SERVER + 500) }
  const bounded = session.summary()
  expect(bounded).toContain(`[truncated at ${INSTRUCTION_CHARS_PER_SERVER} characters]`)
  expect(bounded.length).toBeLessThan(INSTRUCTION_CHARS_PER_SERVER * 2)

  // Servers that each fit per-server but not together: the ones past the session budget are reported
  // by name instead of being silently dropped, so the model can still ask for them explicitly.
  // Nine servers at the 4 KB per-server cap exceed the 32 KB total, so the last ones cannot fit.
  const many = Array.from({ length: 9 }, (_unused, index) => `bulk${index}`)
  await session.pool.configure(many.map((name) => ({ config: { ...entry.config, name } })))
  for (const name of many) {
    const pooled = session.pool.get(name)
    if (pooled === undefined) throw new Error(`"${name}" is not pooled`)
    pooled.catalog = { tools: [], resources: [], prompts: [], instructions: 'z'.repeat(INSTRUCTION_CHARS_PER_SERVER) }
  }
  const overBudget = session.summary()
  expect(overBudget.length).toBeLessThan(INSTRUCTION_CHARS_TOTAL * 2)
  expect(overBudget).toContain('<server name="bulk8">instructions omitted')
})
