import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, expandEnv, findProjectRoot, isDisabledEntry, loadConfig, normalizeEntry, parseJsonText, resolveDshHome, SERVER_NAME_PATTERN } from '../src/config.ts'
import type { ServerConfig } from '../src/types.ts'

describe('config', () => {
  it('expands the three env spellings other agents use', () => {
    expect(expandEnv('a${X}b', { X: '1' })).toBe('a1b')
    expect(expandEnv('a$env:X', { X: '2' })).toBe('a2')
    expect(expandEnv('a{env:X}', { X: '3' })).toBe('a3')
  })

  it('strips comments but keeps a trailing comma as an error', () => {
    expect(parseJsonText('// c\n{"a":1}', 'f')).toEqual({ a: 1 })
    expect(() => parseJsonText('{"a":1,}', 'f')).toThrow(/invalid JSON/)
  })

  it('normalizes a stdio entry and defaults its lifecycle to lazy', () => {
    const entry = normalizeEntry('demo', { command: 'npx', args: ['-y', 'x'] })
    // No directory in the definition: it describes what runs, and the session supplies where.
    expect(entry).toMatchObject({ name: 'demo', transport: 'stdio', lifecycle: 'lazy', args: ['-y', 'x'] })
    expect((entry as ServerConfig).cwd).toBeUndefined()
  })

  it('rejects an entry with neither command, url nor socket', () => {
    expect(() => normalizeEntry('bad', {}, {})).toThrow(/needs "command", "url", or "socket"/)
  })

  it('keeps the server name pattern at the dsh character set', () => {
    expect(SERVER_NAME_PATTERN.test('chrome-devtools_1')).toBe(true)
    expect(SERVER_NAME_PATTERN.test('has space')).toBe(false)
    expect(DEFAULT_SETTINGS.idleTimeout).toBe(10)
  })

  it('mounts project servers by default, with the trust gate one setting away', () => {
    // A cloned repository's `.mcp.json` used to wait for a per-definition approval. The default is
    // now `allow`; `ask` still brings that gate back for anyone who wants it.
    expect(DEFAULT_SETTINGS.projectServers).toBe('allow')
    const repo = mkdtempSync(join(tmpdir(), 'mcp-config-'))
    try {
      mkdirSync(join(repo, '.git'), { recursive: true })
      writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'npx' } } }))
      const home = join(repo, 'home')
      expect(loadConfig({ cwd: repo, dshHome: home, env: {}, homeDir: home }).settings.projectServers).toBe('allow')
      mkdirSync(join(home, 'mcp-adapter'), { recursive: true })
      writeFileSync(join(home, 'mcp-adapter', 'mcp-adapter.json'), JSON.stringify({ settings: { projectServers: 'ask' } }))
      expect(loadConfig({ cwd: repo, dshHome: home, env: {}, homeDir: home }).settings.projectServers).toBe('ask')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('finds the nearest ancestor with a .git directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-config-'))
    try {
      mkdirSync(join(root, 'repo', '.git'), { recursive: true })
      mkdirSync(join(root, 'repo', 'nested', 'deeper'), { recursive: true })
      expect(findProjectRoot(join(root, 'repo', 'nested', 'deeper'))).toBe(join(root, 'repo'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('merges by name with later files winning and keeps disabled entries as entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-config-'))
    try {
      mkdirSync(join(root, 'repo', '.git'), { recursive: true })
      mkdirSync(join(root, 'home', 'mcp-adapter'), { recursive: true })
      writeFileSync(
        join(root, 'home', 'mcp-adapter', 'mcp.json'),
        JSON.stringify({ mcpServers: { demo: { command: 'global-one' }, off: { command: 'x', disabled: true } } }),
      )
      writeFileSync(join(root, 'repo', '.mcp.json'), JSON.stringify({ servers: { demo: { command: 'project-one' } } }))

      const loaded = loadConfig({ cwd: join(root, 'repo'), dshHome: join(root, 'home'), env: {}, homeDir: join(root, 'home') })

      expect(loaded.paths).toHaveLength(4)
      expect(loaded.loaded).toHaveLength(2)
      expect(loaded.servers.get('demo')).toMatchObject({ origin: 'project', config: { command: 'project-one' } })
      // A project file's entry carries no directory of its own — the session supplies it at spawn.
      expect((loaded.servers.get('demo')?.config as ServerConfig).cwd).toBeUndefined()
      const off = loaded.servers.get('off')
      expect(off?.config && isDisabledEntry(off.config)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets the user file lift the project-server gate and a project file not', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-config-'))
    try {
      mkdirSync(join(root, 'repo', '.git'), { recursive: true })
      mkdirSync(join(root, 'home', 'mcp-adapter'), { recursive: true })
      writeFileSync(
        join(root, 'home', 'mcp-adapter', 'mcp-adapter.json'),
        JSON.stringify({ settings: { projectServers: 'allow', idleTimeout: 3 } }),
      )
      writeFileSync(
        join(root, 'repo', '.mcp.json'),
        JSON.stringify({ settings: { projectServers: 'deny', idleTimeout: 7 } }),
      )

      const loaded = loadConfig({ cwd: join(root, 'repo'), dshHome: join(root, 'home'), env: {}, homeDir: join(root, 'home') })

      // The project file may set ordinary policy keys but may not lift the trust gate.
      expect(loaded.settings.projectServers).toBe('allow')
      expect(loaded.settings.idleTimeout).toBe(7)
      expect(loaded.errors).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not let a project file lower the approval policy the user set', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-config-'))
    try {
      mkdirSync(join(root, 'repo', '.git'), { recursive: true })
      mkdirSync(join(root, 'home', 'mcp-adapter'), { recursive: true })
      writeFileSync(
        join(root, 'home', 'mcp-adapter', 'mcp-adapter.json'),
        JSON.stringify({ settings: { approveTools: true, importHosts: ['claude-code'], directTools: false, toolPrefix: 'user_' } }),
      )
      // A cloned repository turns every gate off in one file.
      writeFileSync(
        join(root, 'repo', '.mcp.json'),
        JSON.stringify({ settings: { approveTools: false, importHosts: true, directTools: true, toolPrefix: 'repo_' } }),
      )

      const loaded = loadConfig({ cwd: join(root, 'repo'), dshHome: join(root, 'home'), env: {}, homeDir: join(root, 'home') })

      // The user's policy wins for every key that decides what runs or what is auto-approved.
      expect(loaded.settings.approveTools).toBe(true)
      expect(loaded.settings.importHosts).toEqual(['claude-code'])
      expect(loaded.settings.directTools).toBe(false)
      // Ordinary per-project tuning still applies.
      expect(loaded.settings.toolPrefix).toBe('repo_')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Deliberate deviation from the pre-port `lib/config.mjs:129`, which keeps the raw value: this port
  // coerces with `String(url)` so `ServerConfig.url` stays a string. Downstream `new URL(config.url)`
  // applies the same ToString, so the entry connects identically; only the stored shape differs,
  // which changes `definitionHash` for a malformed config and so re-prompts an old approval (fails
  // closed).
  it('coerces an array-shaped url to a string instead of dropping it', () => {
    const entry = normalizeEntry('demo', { url: ['http://h/mcp'] }, {}) as ServerConfig
    expect(entry.transport).toBe('http')
    expect(entry.url).toBe('http://h/mcp')
  })

  it('keeps an empty url alongside a command, as the source does', () => {
    const entry = normalizeEntry('demo', { url: '', command: 'x' }, {}) as ServerConfig
    expect(entry.transport).toBe('stdio')
    expect(entry.url).toBe('')
  })

  it('omits a null url rather than stringifying it', () => {
    const entry = normalizeEntry('demo', { url: null, command: 'x' }, {}) as ServerConfig
    expect(entry.transport).toBe('stdio')
    expect(Object.hasOwn(entry, 'url')).toBe(false)
  })

  it('returns a non-string unchanged rather than coercing it', () => {
    expect(expandEnv(5)).toBe(5)
    expect(expandEnv(null)).toBe(null)
  })

  it('falls back to the home default when DSH_HOME is only whitespace', () => {
    expect(resolveDshHome({ DSH_HOME: '  ' })).toBe(join(homedir(), '.dsh'))
  })

  // The panel used to write `timeoutMs` and `transport`, neither of which `normalizeEntry` read, so a
  // server saved from the UI silently lost its timeout and its SSE choice. Both spellings now resolve.
  describe('the alias spellings other MCP clients and the old panel wrote', () => {
    it('reads timeoutMs as requestTimeoutMs', () => {
      const entry = normalizeEntry('demo', { command: 'npx', timeoutMs: 15_000 }, {}) as ServerConfig
      expect(entry.requestTimeoutMs).toBe(15_000)
    })

    it('prefers the canonical requestTimeoutMs when both are present', () => {
      const entry = normalizeEntry('demo', { command: 'npx', requestTimeoutMs: 5_000, timeoutMs: 15_000 }, {}) as ServerConfig
      expect(entry.requestTimeoutMs).toBe(5_000)
    })

    it('ignores a non-positive timeout rather than disabling the guard', () => {
      const entry = normalizeEntry('demo', { command: 'npx', timeoutMs: 0 }, {}) as ServerConfig
      expect(entry.requestTimeoutMs).toBeUndefined()
    })

    it('reads transport: "sse" as httpTransport', () => {
      const entry = normalizeEntry('demo', { url: 'http://h/mcp', transport: 'sse' }, {}) as ServerConfig
      expect(entry.httpTransport).toBe('sse')
    })

    it('does not treat transport: "stdio" as an http transport override', () => {
      const entry = normalizeEntry('demo', { command: 'npx', transport: 'stdio' }, {}) as ServerConfig
      expect(entry.httpTransport).toBeUndefined()
    })
  })

  // A socket entry used to normalize fine and then throw at connect time, mid tool call. Refusing it
  // where servers are mounted turns that into a line `mcp({})` and the panel both show.
  it('refuses a unix-socket server at load time with a reason, instead of failing on first call', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-socket-'))
    try {
      const repo = join(root, 'repo')
      mkdirSync(join(repo, '.git'), { recursive: true })
      writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { sock: { socket: '/run/mcp.sock' }, ok: { command: 'npx' } } }))

      const loaded = loadConfig({ cwd: repo, dshHome: join(root, 'home'), env: {}, homeDir: join(root, 'home') })

      expect(loaded.servers.has('sock')).toBe(false)
      expect(loaded.servers.has('ok')).toBe(true)
      expect(loaded.errors.join('\n')).toMatch(/server "sock" uses a unix socket/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  // `oauth`/`auth` used to normalize onto the config and then reach no consumer, so an OAuth-protected
  // server failed at connect with a bare 401 that looked like any other outage. Refusing it at load
  // time and naming the supported alternative is the same contract the socket refusal above follows
  // (ADR-0011); silently accepting the object would be worse than refusing it.
  it('refuses an OAuth server at load time instead of accepting a field nothing reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-oauth-'))
    try {
      const repo = join(root, 'repo')
      mkdirSync(join(repo, '.git'), { recursive: true })
      writeFileSync(join(repo, '.mcp.json'), JSON.stringify({
        mcpServers: {
          oauthed: { url: 'https://example.test/mcp', oauth: {} },
          spelled: { url: 'https://example.test/mcp', auth: 'oauth' },
          token: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } },
          // `oauth: false` asks for no OAuth at all, which is exactly what this adapter does.
          plain: { url: 'https://example.test/mcp', oauth: false },
        },
      }))

      const loaded = loadConfig({ cwd: repo, dshHome: join(root, 'home'), env: {}, homeDir: join(root, 'home') })

      expect(loaded.servers.has('oauthed')).toBe(false)
      expect(loaded.servers.has('spelled')).toBe(false)
      expect(loaded.servers.has('token')).toBe(true)
      expect(loaded.servers.has('plain')).toBe(true)
      const errors = loaded.errors.join('\n')
      expect(errors).toMatch(/server "oauthed" asks for OAuth/)
      expect(errors).toMatch(/server "spelled" asks for OAuth/)
      // The reason names what to do instead, so the message is actionable rather than a dead end.
      expect(errors).toMatch(/bearerTokenEnv/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

})
