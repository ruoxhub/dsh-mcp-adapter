// Self-check for the browser bundle's contract with the client module system, plus the one return
// shape the command registry rejects at runtime.
//
// What this would catch: a bundle the loader silently skips (wrong envelope id, no `apply`/`inject`
// exports), a package.json that declares a client half the scanner cannot resolve, and a
// `/mcp-adapter` handler that returns a bare string where `CommandRuntime` demands a `CommandResult`.

import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

// `process.cwd()` is the package root (`vitest run` is the package script). The paths are not built
// from `import.meta.url` because Vite rewrites an inline `new URL(rel, import.meta.url)` against the
// dev-server origin: `import.meta.url` IS a `file:` URL under vitest + jsdom, but the URL built from
// it comes back as `http://localhost:3000/...`, so `readFileSync` would look for a phantom file.
const BUNDLE = join(process.cwd(), 'lib', 'client.js')
const MANIFEST: Manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

/** The manifest fields this contract reads; a mistyped key is a compile error, not `undefined`. */
interface Manifest {
  name: string
  main: string
  exports: Record<string, { types?: string; default?: string }>
  files: string[]
  dsh: { client: { platform: string; inject: string[] } }
}

/** The loader envelope the bundle must produce: the id it registers under, and its closure factory. */
interface LoaderEntry {
  id: string
  factory: (require: (name: string) => unknown) => ClientExports
}

/** What cordis loading needs from the bundle: the two plugin fields and nothing else. */
interface ClientExports {
  apply: (ctx: unknown) => void
  inject: string[]
}

/**
 * Run the bundle exactly the way the browser loader does: hand it a `window` with a
 * `__ModuleLoader__` sink and a `require` that answers the host's shared modules with stand-ins.
 *
 * The stand-in table covers the platform modules the panel (Task 14) pulls in; the stub only uses
 * `react`, and the `require` below names any module this check does not answer.
 * @returns the bundle's exports plus the header the loader keyed it by.
 */
function loadBundle(): { entry: LoaderEntry; exports: ClientExports } {
  const source = readFileSync(BUNDLE, 'utf8')
  let loaded: LoaderEntry | undefined
  const window = {
    __ModuleLoader__: {
      load(entry: LoaderEntry) {
        loaded = entry
      },
    },
  }
  const modules: Record<string, unknown> = {
    'react': { useState: () => [], useEffect: () => {}, useRef: () => ({ current: null }), useCallback: () => () => {}, createElement: () => null },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' },
    'react-dom': { createPortal: () => null },
    '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: () => () => null }),
  }
  const require = (name: string): unknown => {
    if (name in modules) return modules[name]
    throw new Error(`bundle required a module this check does not stand in for: ${name}`)
  }
  // eslint-disable-next-line no-new-func -- the loader is a function of the global, exactly like the browser
  new Function('window', 'document', source)(window, undefined)
  expect(loaded, 'the bundle never called window.__ModuleLoader__.load').toBeDefined()
  // The assertion above reports the failure; this throw is the type narrowing it cannot express.
  if (loaded === undefined) throw new Error('the bundle never called window.__ModuleLoader__.load')
  return { entry: loaded, exports: loaded.factory(require) }
}

const fixtures: string[] = []

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('the bundle registers under the package name the manifest declares', () => {
  const { entry } = loadBundle()
  expect(entry.id).toBe(MANIFEST.name)
})

it('the bundle exports what the client loader injects and calls', () => {
  const { exports } = loadBundle()
  expect(typeof exports.apply).toBe('function')
  expect(Array.isArray(exports.inject)).toBe(true)
  // Every service named here must be one the composition actually provides, or the plugin never loads.
  for (const service of exports.inject) expect(typeof service).toBe('string')
  expect(exports.inject, 'the panel reads the projection through `sessions`').toContain('sessions')
  expect(exports.inject).toContain('slots')
  expect(exports.inject).toContain('locale')
  expect(exports.inject).toContain('layout')
})

it('the manifest declares a web client half that resolves to the bundle', () => {
  expect(MANIFEST.dsh.client.platform).toBe('web')
  // The host half: the Loader row in cordis.patch.yml names `./lib/index.js`, so the export must too.
  expect(MANIFEST.main).toBe('lib/index.js')
  expect(MANIFEST.exports['.']?.default).toBe('./lib/index.js')
  expect(MANIFEST.exports['./client']?.default).toBe('./lib/client.js')
  // `files` enumerates globs, so the bundle ships through the `lib/**/*.js` pattern (and its map
  // through `lib/**/*.js.map`); a literal `lib/client.js` entry is not how this manifest lists it.
  expect(MANIFEST.files, 'the bundle must ship').toContain('lib/**/*.js')
  expect(MANIFEST.files, 'the bundle map must ship').toContain('lib/**/*.js.map')
  // The scanner throws when a package declares dsh.client but exports no ./client bundle.
  expect(readFileSync(BUNDLE, 'utf8')).toContain('__ModuleLoader__')
})

// The registry, not the type, is what breaks: `CommandRuntime.execute` normalizes the handler's
// return value and throws a TypeError for anything that is not a `CommandResult`. So every branch is
// driven through a real `CommandRuntime` here — a regression to a bare string fails this test
// instead of passing silently, and the status / usage / tools / reload branches all get executed.
it('the /mcp-adapter command returns a CommandResult, not a bare string', async () => {
  const root = new Context()
  // `systemPrompt` is the one stub: the command registry and the tool registry below are genuine,
  // and `ToolRuntime` consumes `tools`/`section` at construction while `apply` consumes `context` and
  // `getContextOrder`.
  root.provide('systemPrompt', {
    context: () => () => {},
    getContextOrder: () => 200,
    tools: () => () => {},
    section: () => () => {},
    variable: () => () => {},
    sectionFor: () => () => {},
  })
  new ToolRuntime(root)
  new CommandRuntime(root)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-command-'))
  fixtures.push(dir)
  const project = join(dir, 'project')
  const home = join(dir, 'home')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(home, { recursive: true })

  /** The two Agent fields this path reads: the Session (cwd + log) and its scoped context. */
  const agent = {
    id: 'agent-1',
    ctx: root,
    session: { header: { cwd: project }, append: () => ({}) },
  }

  apply(root as never, { dshHome: home })

  const signal = new AbortController().signal
  // No `agent/created` yet, so the handler takes its "not initialized" branch.
  const cold = await root.commands.execute(agent as never, '/mcp-adapter status', [], signal)
  expect(cold, 'the command is registered globally, so it resolves for any agent').toBeDefined()
  expect(cold?.result).toEqual({ kind: 'success', text: 'MCP is not initialized for this session yet — send a message first.' })

  // Arm the Agent the way dsh does: the listener builds the session, the command then reaches the
  // remaining four branches for real.
  await root.parallel('agent/created', { agent } as never)

  // Review focus: this composition provides no `sessionProjections` service, and the `mcp` tool must
  // still be there. The panel's read path is optional; the tool surface is not.
  expect(root.tools.get('mcp'), 'the proxy tool survives a composition without sessionProjections').toBeDefined()

  const status = await root.commands.execute(agent as never, '/mcp-adapter status', [], signal)
  expect(status?.result).toEqual({
    kind: 'success',
    text: [
      `project root: ${project}`,
      `no MCP servers found — add one to ${join(home, 'mcp-adapter', 'mcp.json')} or this project's .mcp.json`,
    ].join('\n'),
  })

  const usage = await root.commands.execute(agent as never, '/mcp-adapter approve', [], signal)
  expect(usage?.result).toEqual({ kind: 'error', text: 'usage: /mcp-adapter approve <server>' })

  const tools = await root.commands.execute(agent as never, '/mcp-adapter tools', [], signal)
  expect(tools?.result).toEqual({ kind: 'success', text: 'No MCP tools available.' })

  const reload = await root.commands.execute(agent as never, '/mcp-adapter reload', [], signal)
  expect(reload?.result).toEqual({ kind: 'success', text: 'MCP configuration reloaded.' })

  // The disposal listener is the other half of the lifecycle; running it keeps the case honest.
  await root.parallel('agent/disposed', { agent } as never)
})
