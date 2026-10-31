// The surfaces that are easy to wire up wrongly and never notice: resources, prompt commands, and
// the approval gate. Each is driven through the same session the model would use.

import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { needsApproval } from '../src/approval.ts'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import type { AdapterSettings } from '../src/config.ts'
import { flattenPromptResult, parsePromptArgs, promptCommandName } from '../src/prompts.ts'
import { McpSession } from '../src/session.ts'
import { TEST_SERVER_SOURCE } from '../src/testserver.ts'

interface Fixture {
  root: string
  project: string
  home: string
}

const dirs: string[] = []
const cleanups: Array<() => unknown> = []

afterEach(async () => {
  // Children first: a failed assertion must not leave a spawned server behind for the next run.
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      // Best effort: the session is already torn down.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(extraConfig: Record<string, unknown> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-surfaces-'))
  dirs.push(root)
  const project = join(root, 'project')
  const home = join(root, 'home')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(home, 'mcp-adapter'), { recursive: true })
  const server = join(project, 'server.mjs')
  writeFileSync(server, TEST_SERVER_SOURCE, 'utf8')
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { demo: { command: process.execPath, args: [server], ...extraConfig } },
  }), 'utf8')
  return { root, project, home }
}

/** One approval question, as the adapter asks it; the answerer is the test's own stub. */
interface AskedApproval {
  toolName: string
  reason: string
}

interface ApprovalService {
  request: (request: AskedApproval) => Promise<string>
}

/** The fake Agent the session reads: an id, a cwd, and the log `CommandRuntime` appends to. */
interface FakeAgent {
  id: string
  session: { header: { cwd: string }; append: (type: string, data: unknown) => { type: string; data: unknown } }
}

/**
 * The host surfaces `McpSession` uses. Host types, not behaviour: the session only reads
 * `agent.id`/`agent.session.header.cwd` and calls `tools.register`/`tools.restrict`/
 * `commands.register`/`ctx.get('approval')`, so a full Cordis Agent is never built here.
 */
function makeSession(fixes: Fixture, { approval, settings = {} }: { approval?: ApprovalService; settings?: Partial<AdapterSettings> } = {}): {
  session: McpSession
  tools: Map<string, ToolDefinition>
  commands: Map<string, CommandDefinition>
} {
  const tools = new Map<string, ToolDefinition>()
  const commands = new Map<string, CommandDefinition>()
  const agent: FakeAgent = {
    id: 'agent-1',
    session: { header: { cwd: fixes.project }, append: (type, data) => ({ type, data }) },
  }
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
      restrict: () => {},
    },
    commands: {
      register: (definition: CommandDefinition) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) },
    },
    get: (service: string) => (service === 'approval' ? approval : undefined),
  }
  const session = new McpSession({
    ctx: ctx as never,
    agent: agent as never,
    settings: { ...DEFAULT_SETTINGS, dshHome: fixes.home, servers: {}, configFiles: [], idleTimeout: 10, projectServers: 'allow', directTools: false, ...settings },
    logger: { debug() {}, warn() {} },
    stat: statSync,
  })
  cleanups.push(() => session.dispose())
  return { session, tools, commands }
}

/** The first text block's body, narrowed without a cast so a changed result shape fails loudly. */
function firstText(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) throw new Error('the proxy result has no content')
  const { content } = result
  if (!Array.isArray(content)) throw new Error('the proxy result content is not an array')
  const block: unknown = content[0]
  if (typeof block !== 'object' || block === null || !('text' in block) || typeof block.text !== 'string') throw new Error('the proxy result has no first text block')
  return block.text
}

it('resources are listable and readable through the proxy', async () => {
  const fixes = fixture()
  const { session, tools } = makeSession(fixes)
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()
  const proxy = tools.get('mcp')
  if (proxy === undefined) throw new Error('the proxy tool was not registered')

  const listed = await proxy.execute({ resources: 'demo' }, {} as never)
  expect(firstText(listed)).toMatch(/demo:\/\/readme/)
  expect(firstText(listed)).toMatch(/Demo resource/)

  const read = await proxy.execute({ server: 'demo', read: 'demo://readme' }, {} as never)
  expect(firstText(read)).toBe('readme body')
  await session.dispose()
})

it('a prompt becomes a slash command and flattens its messages', async () => {
  const fixes = fixture()
  const { session, commands } = makeSession(fixes)
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()

  const name = promptCommandName('demo', 'review')
  expect(name).toBe('mcp__demo__review')
  const command = commands.get(name)
  expect(command, 'the prompt is registered as a command').toBeDefined()
  if (command === undefined) throw new Error('the prompt command was not registered')
  expect(command.description).toMatch(/Review a change/)

  // The exact CommandResult, not a bare string: `CommandRuntime` rejects every other shape with a
  // TypeError, so this is the only assertion pinning the prompt command's return contract.
  const rendered = await command.handler({ rawInput: '"retry policy" mode=strict' } as never)
  expect(rendered).toEqual({ kind: 'success', text: '[user] Review retry policy in strict' })

  const missing = await command.handler({ rawInput: '' } as never)
  expect(missing).toEqual({ kind: 'error', text: 'missing required argument(s): target' })
  await session.dispose()
})

it('the approval gate stops a destructive tool and runs an ordinary one', async () => {
  const fixes = fixture()
  const asked: AskedApproval[] = []
  const approval: ApprovalService = {
    async request(request) {
      asked.push(request)
      return request.toolName.includes('delete_widget') ? 'rejected' : 'allowed-once'
    },
  }
  const { session, tools } = makeSession(fixes, { approval, settings: { approveTools: 'destructive' } })
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()
  const proxy = tools.get('mcp')
  if (proxy === undefined) throw new Error('the proxy tool was not registered')

  const fine = await proxy.execute({ tool: 'demo_take_screenshot', args: {} }, {} as never)
  expect(firstText(fine)).toMatch(/shot \{\}/)
  expect(asked.length, 'a read-only tool is not gated').toBe(0)

  const denied = await proxy.execute({ tool: 'demo_delete_widget', args: { id: 'w1' } }, {} as never)
  expect(firstText(denied)).toMatch(/not approved|rejected/)
  expect(asked.length).toBe(1)
  expect(asked[0].toolName).toMatch(/delete_widget/)
  await session.dispose()
})

it('approveTools selects by config as well as by annotation', () => {
  const tool = { name: 'demo_ping', originalName: 'ping', server: 'demo', annotations: {} } as never
  const destructive = { name: 'demo_delete', originalName: 'delete', server: 'demo', annotations: { destructiveHint: true } } as never
  expect(needsApproval({ approveTools: true } as never, tool, {} as never)).toBe(true)
  expect(needsApproval({ approveTools: ['ping'] } as never, tool, {} as never)).toBe(true)
  expect(needsApproval({ approveTools: ['other'] } as never, tool, {} as never)).toBe(false)
  expect(needsApproval({ approveTools: 'destructive' } as never, destructive, {} as never)).toBe(true)
  expect(needsApproval({ approveTools: 'destructive' } as never, tool, {} as never)).toBe(false)
  // The global setting applies when the server itself says nothing.
  expect(needsApproval({} as never, destructive, { approveTools: 'destructive' } as never)).toBe(true)
  expect(needsApproval({ approveTools: false } as never, destructive, { approveTools: 'destructive' } as never)).toBe(false)
})

it('prompt arguments accept positional and key=value forms', () => {
  const definitions = [{ name: 'target', required: true }, { name: 'mode' }]
  expect(parsePromptArgs('one two', definitions)).toEqual({ args: { target: 'one', mode: 'two' }, missing: [] })
  expect(parsePromptArgs('mode=strict "a b"', definitions)).toEqual({ args: { mode: 'strict', target: 'a b' }, missing: [] })
  expect(parsePromptArgs('', definitions).missing).toEqual(['target'])
  expect(flattenPromptResult({ messages: [{ role: 'assistant', content: { type: 'text', text: 'hi' } }] })).toBe('[assistant] hi')
})

it('coerces scalar prompt arguments and refuses an object one instead of sending [object Object]', async () => {
  const fixes = fixture()
  const { session, tools } = makeSession(fixes)
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()
  const proxy = tools.get('mcp')
  if (proxy === undefined) throw new Error('the proxy tool was not registered')

  // The server sees the string form MCP declares; the demo server echoes both values.
  const scalar = await proxy.execute({ server: 'demo', prompt: 'review', args: { target: 'retry', mode: true } }, {} as never)
  expect(firstText(scalar)).toBe('[user] Review retry in true')

  // The old behaviour stringified this, so the server received "[object Object]" as the whole prompt.
  await expect(proxy.execute({ server: 'demo', prompt: 'review', args: { target: { nested: 1 } } }, {} as never))
    .rejects.toThrow('prompts/get argument "target" must be a string, number, or boolean, got object')
  await session.dispose()
})

it('autoApprove is an allowlist: listed tools skip the prompt, unlisted ones ask', async () => {
  // The shape a Cursor/Claude-Code .mcp.json uses, including the empty string some of them carry.
  const fixes = fixture({ autoApprove: ['ping', 'take_screenshot', ''] })
  const asked: AskedApproval[] = []
  const approval: ApprovalService = { async request(request) { asked.push(request); return 'allowed-once' } }
  const { session, tools } = makeSession(fixes, { approval })
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()
  const proxy = tools.get('mcp')
  if (proxy === undefined) throw new Error('the proxy tool was not registered')

  const listed = await proxy.execute({ tool: 'demo_ping', args: {} }, {} as never)
  expect(firstText(listed)).toBe('pong')
  expect(asked.length, 'a listed tool never prompts').toBe(0)

  const unlisted = await proxy.execute({ tool: 'demo_delete_widget', args: { id: 'w1' } }, {} as never)
  expect(firstText(unlisted)).toBe('deleted w1')
  expect(asked.length, 'an unlisted tool asks once').toBe(1)
  expect(asked[0].reason).toMatch(/autoApprove/)
  await session.dispose()
})

it('autoApprove also reads from the server entry, and true means nothing asks', async () => {
  const fixes = fixture({ autoApprove: ['ping', ''] })
  const asked: AskedApproval[] = []
  const approval: ApprovalService = { async request(request) { asked.push(request); return 'allowed-once' } }
  const { session, tools } = makeSession(fixes, { approval })
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()
  const proxy = tools.get('mcp')
  if (proxy === undefined) throw new Error('the proxy tool was not registered')
  await proxy.execute({ tool: 'demo_take_screenshot', args: {} }, {} as never)
  expect(asked.length, "not on this server's list, so it asks").toBe(1)
  await proxy.execute({ tool: 'demo_ping', args: {} }, {} as never)
  expect(asked.length, 'on the list, so no second prompt').toBe(1)
  await session.dispose()
})

it("directTools: 'search' leaves its tools callable only after mcp({ search }) matches one", async () => {
  const fixes = fixture({ directTools: 'search' })
  const { session, tools } = makeSession(fixes)
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()
  const direct = tools.get('demo_ping')
  if (direct === undefined) throw new Error('the hidden direct tool was not registered')

  // Registered but inactive: the mode exists so a call before the search is refused, not run.
  await expect(direct.execute({}, {} as never)).rejects.toThrow('is not active')

  // A search that matches nothing must not activate anything.
  const proxy = tools.get('mcp')
  if (proxy === undefined) throw new Error('the proxy tool was not registered')
  await proxy.execute({ search: 'widget' }, {} as never)
  await expect(direct.execute({}, {} as never)).rejects.toThrow('is not active')

  // The search that names it is the activation gesture, and the same tool is then callable.
  const page = await proxy.execute({ search: 'ping' }, {} as never)
  expect(firstText(page)).toContain('demo_ping')
  expect(firstText(await direct.execute({}, {} as never)), 'the search activated it').toBe('pong')
  await session.dispose()
})

// The one case the fake registry cannot reach: `CommandRuntime.execute` normalizes the handler's
// return value and throws a TypeError for anything that is not a `CommandResult`. That is the bug
// the prompt handler was fixed for, so the session's own registered command is driven through the
// real registry here — a regression to a bare string fails this test instead of passing silently.
it("the prompt command's CommandResult is accepted by the real CommandRuntime", async () => {
  const fixes = fixture()
  const root = new Context()
  // `systemPrompt` is the one stub: the command registry below and the tool registry are genuine.
  root.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    variable: () => () => {},
    sectionFor: () => () => {},
  })
  new ToolRuntime(root)
  new CommandRuntime(root)

  const agent: FakeAgent = {
    id: 'agent-1',
    session: { header: { cwd: fixes.project }, append: (type, data) => ({ type, data }) },
  }
  const session = new McpSession({
    ctx: root as never,
    agent: agent as never,
    settings: { ...DEFAULT_SETTINGS, dshHome: fixes.home, servers: {}, configFiles: [], idleTimeout: 10, projectServers: 'allow', directTools: false },
    logger: { debug() {}, warn() {} },
    stat: statSync,
  })
  cleanups.push(() => session.dispose())
  await session.sync()
  session.registerTools()
  await session.refreshCatalog()

  const name = promptCommandName('demo', 'review')
  expect(root.commands.list(agent as never).map((descriptor) => descriptor.name)).toContain(name)

  const signal = new AbortController().signal
  const rendered = await root.commands.execute(agent as never, `/${name} "retry policy" mode=strict`, [], signal)
  expect(rendered?.result).toEqual({ kind: 'success', text: '[user] Review retry policy in strict' })

  const missing = await root.commands.execute(agent as never, `/${name}`, [], signal)
  expect(missing?.result).toEqual({ kind: 'error', text: 'missing required argument(s): target' })
  await session.dispose()
})
