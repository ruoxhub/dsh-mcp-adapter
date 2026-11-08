import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { approve, approvalsPath, definitionHash, isApproved, partition } from '../src/trust.ts'
import { normalizeEntry } from '../src/config.ts'
import type { ServerConfig } from '../src/types.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'mcp-trust-')); dirs.push(dir); return dir }

describe('trust', () => {
  it('pins the exact definition: changing args invalidates the approval', () => {
    const home = temp()
    const original = normalizeEntry('demo', { command: 'npx', args: ['-y', 'a'] }) as ServerConfig
    approve(approvalsPath(home), '/repo', 'demo', original)
    expect(isApproved(approvalsPath(home), '/repo', 'demo', original)).toBe(true)
    const edited = normalizeEntry('demo', { command: 'npx', args: ['-y', 'evil'] }) as ServerConfig
    expect(isApproved(approvalsPath(home), '/repo', 'demo', edited)).toBe(false)
    expect(definitionHash(original)).not.toBe(definitionHash(edited))
  })

  it('holds a project server until approved, and lets a global one through', () => {
    const home = temp()
    const config = normalizeEntry('demo', { command: 'npx' }) as ServerConfig
    const servers = new Map([
      ['demo', { origin: 'project', path: '/repo/.mcp.json', config }],
      ['global', { origin: 'global', path: '/home/mcp.json', config: { ...config, name: 'global' } as ServerConfig }],
    ])
    const gated = partition({ servers, projectRoot: '/repo', policy: 'ask', approvalsFile: approvalsPath(home) })
    expect(gated.mount.map((entry) => entry.config.name)).toEqual(['global'])
    expect(gated.blocked[0]).toMatchObject({ name: 'demo' })
    expect(gated.blocked[0].reason).toContain('/mcp-adapter approve demo')
  })

  it('mounts a project server once it is approved', () => {
    const home = temp()
    const config = normalizeEntry('demo', { command: 'npx' }) as ServerConfig
    const servers = new Map([['demo', { origin: 'project', path: '/repo/.mcp.json', config }]])
    approve(approvalsPath(home), '/repo', 'demo', config)
    const gated = partition({ servers, projectRoot: '/repo', policy: 'ask', approvalsFile: approvalsPath(home) })
    expect(gated.mount.map((entry) => entry.config.name)).toEqual(['demo'])
    expect(gated.blocked).toEqual([])
  })

  it('an approval does not carry across projects or server names', () => {
    const home = temp()
    const config = normalizeEntry('demo', { command: 'npx' }) as ServerConfig
    approve(approvalsPath(home), '/repo', 'demo', config)
    expect(isApproved(approvalsPath(home), '/other-repo', 'demo', config)).toBe(false)
    expect(isApproved(approvalsPath(home), '/repo', 'other-name', config)).toBe(false)
    expect(isApproved(approvalsPath(home), '/repo', 'demo', config)).toBe(true)
  })
})

describe('definitionHash', () => {
  it('is stable for the same definition', () => {
    const one = normalizeEntry('demo', { command: 'npx', args: ['-y', 'a'], env: { TOKEN: 'one' } }) as ServerConfig
    const two = normalizeEntry('demo', { command: 'npx', args: ['-y', 'a'], env: { TOKEN: 'one' } }) as ServerConfig
    expect(definitionHash(one)).toBe(definitionHash(two))
  })

  it('covers exactly the stdio fields that decide what runs', () => {
    const base = normalizeEntry('demo', { command: 'npx', args: ['-y', 'a'], env: { TOKEN: 'one' } }) as ServerConfig
    const hash = definitionHash(base)
    expect(definitionHash({ ...base, command: 'node' })).not.toBe(hash)
    expect(definitionHash({ ...base, args: ['-y', 'b'] })).not.toBe(hash)
    expect(definitionHash({ ...base, env: { TOKEN: 'two' } })).not.toBe(hash)
    expect(definitionHash({ ...base, cwd: '/other' })).not.toBe(hash)
    // stdio material is ['stdio', command, args, env, cwd, gate]: the endpoint fields are not consulted.
    expect(definitionHash({ ...base, headers: { Authorization: 'Bearer two' }, socket: '/run/other.sock', url: 'http://evil/mcp' })).toBe(hash)
  })

  it('covers the url and headers of an http server, and ignores the process fields', () => {
    const base = normalizeEntry('demo', { url: 'http://h/mcp', headers: { Authorization: 'Bearer one' } }) as ServerConfig
    const hash = definitionHash(base)
    expect(definitionHash({ ...base, url: 'http://evil/mcp' })).not.toBe(hash)
    expect(definitionHash({ ...base, headers: { Authorization: 'Bearer two' } })).not.toBe(hash)
    // http material is ['http', url, headers, gate]: a local command does not decide the endpoint contacted.
    expect(definitionHash({ ...base, command: 'sh', args: ['-c', 'x'], env: { TOKEN: 'x' }, cwd: '/repo' })).toBe(hash)
  })

  it('hashes the fields the transport actually uses, so url plus command hashes as http', () => {
    const withCommand = normalizeEntry('demo', { url: 'http://h/mcp', command: 'npx' }) as ServerConfig
    expect(withCommand.transport).toBe('http')
    const changedHeaders = { ...withCommand, headers: { authorization: 'Bearer x' } } as ServerConfig
    expect(definitionHash(withCommand)).not.toBe(definitionHash(changedHeaders))
  })

  it('covers the gating fields for every transport, so adding autoApprove asks again', () => {
    const stdio = normalizeEntry('demo', { command: 'npx' }) as ServerConfig
    const http = normalizeEntry('demo', { url: 'http://h/mcp' }) as ServerConfig
    const socket = normalizeEntry('demo', { socket: '/run/mcp.sock' }) as ServerConfig
    for (const base of [stdio, http, socket]) {
      const hash = definitionHash(base)
      // The attack this blocks: a repository adds autoApprove to a server the user already approved,
      // which changes nothing about what runs and so used to keep the old hash and skip re-approval.
      expect(definitionHash({ ...base, autoApprove: true })).not.toBe(hash)
      expect(definitionHash({ ...base, approveTools: 'destructive' })).not.toBe(hash)
      expect(definitionHash({ ...base, directTools: 'search' })).not.toBe(hash)
      // A different list is a different gate: which tools skip the prompt is part of what was approved.
      expect(definitionHash({ ...base, autoApprove: ['ping'] })).not.toBe(definitionHash({ ...base, autoApprove: ['take_screenshot'] }))
    }
  })

  it('covers the socket path of a socket server, and ignores the process fields', () => {
    const base = normalizeEntry('demo', { socket: '/run/mcp.sock' }) as ServerConfig
    const hash = definitionHash(base)
    expect(definitionHash({ ...base, socket: '/run/other.sock' })).not.toBe(hash)
    expect(definitionHash({ ...base, command: 'sh', args: ['-c', 'x'], env: { TOKEN: 'x' }, cwd: '/repo' })).toBe(hash)
  })
})

describe('approvals store', () => {
  it('denies everything when the store is unreadable or malformed instead of throwing', () => {
    const home = temp()
    const file = approvalsPath(home)
    const config = normalizeEntry('demo', { command: 'npx' }) as ServerConfig
    approve(file, '/repo', 'demo', config)
    expect(isApproved(file, '/repo', 'demo', config)).toBe(true)

    writeFileSync(file, '{ not json')
    expect(isApproved(file, '/repo', 'demo', config)).toBe(false)

    writeFileSync(file, JSON.stringify({ version: 2, approvals: [{ projectRoot: '/repo', serverName: 'demo', definitionHash: definitionHash(config) }] }))
    expect(isApproved(file, '/repo', 'demo', config)).toBe(false)

    writeFileSync(file, JSON.stringify({ version: 1, approvals: 'nope' }))
    expect(isApproved(file, '/repo', 'demo', config)).toBe(false)

    // A record that is not even an object cannot answer the comparison, so it is not a match.
    writeFileSync(file, JSON.stringify({ version: 1, approvals: [null, 'x', { projectRoot: '/repo' }] }))
    expect(isApproved(file, '/repo', 'demo', config)).toBe(false)

    const asDirectory = join(home, 'store-is-a-directory.json')
    mkdirSync(asDirectory)
    expect(isApproved(asDirectory, '/repo', 'demo', config)).toBe(false)
  })

  it('replaces an existing record for the same project and server instead of appending a duplicate', () => {
    const home = temp()
    const file = approvalsPath(home)
    const first = normalizeEntry('demo', { command: 'npx', args: ['a'] }) as ServerConfig
    const second = normalizeEntry('demo', { command: 'npx', args: ['b'] }) as ServerConfig
    approve(file, '/repo', 'demo', first)
    approve(file, '/repo', 'demo', second)
    const store = JSON.parse(readFileSync(file, 'utf8')) as { approvals: Array<{ serverName: string; definitionHash: string }> }
    expect(store.approvals).toHaveLength(1)
    expect(store.approvals[0].definitionHash).toBe(definitionHash(second))
    expect(isApproved(file, '/repo', 'demo', first)).toBe(false)
    expect(isApproved(file, '/repo', 'demo', second)).toBe(true)

    // A different project root is a different approval, so that record survives.
    approve(file, '/other', 'demo', first)
    const grown = JSON.parse(readFileSync(file, 'utf8')) as { approvals: unknown[] }
    expect(grown.approvals).toHaveLength(2)
  })

  it('replaces a malformed same-pair record instead of leaving a duplicate pair', () => {
    const home = temp()
    const file = approvalsPath(home)
    const config = normalizeEntry('demo', { command: 'npx' }) as ServerConfig
    // A same-pair record whose hash is not a string: never a match, but still the same pair.
    writeFileSync(file, JSON.stringify({
      version: 1,
      approvals: [{ projectRoot: '/repo', serverName: 'demo', definitionHash: 42 }],
    }))
    approve(file, '/repo', 'demo', config)
    const store = JSON.parse(readFileSync(file, 'utf8')) as { approvals: Array<{ projectRoot?: unknown; serverName?: unknown }> }
    const pair = store.approvals.filter((record) => record.projectRoot === '/repo' && record.serverName === 'demo')
    expect(pair).toHaveLength(1)
    expect(isApproved(file, '/repo', 'demo', config)).toBe(true)
  })
})

describe('partition policy', () => {
  it('mounts a project server under allow without writing any approval record', () => {
    const home = temp()
    const config = normalizeEntry('demo', { command: 'npx' }) as ServerConfig
    const servers = new Map([['demo', { origin: 'project', path: '/repo/.mcp.json', config }]])
    const approvalsFile = approvalsPath(home)
    const result = partition({ servers, projectRoot: '/repo', policy: 'allow', approvalsFile })
    expect(result.mount.map((entry) => entry.config.name)).toEqual(['demo'])
    expect(result.blocked).toEqual([])
    expect(isApproved(approvalsFile, '/repo', 'demo', config)).toBe(false)
  })

  it('blocks a project server under deny with the policy as the reason', () => {
    const home = temp()
    const config = normalizeEntry('demo', { command: 'npx' }) as ServerConfig
    const servers = new Map([['demo', { origin: 'project', path: '/repo/.mcp.json', config }]])
    const result = partition({ servers, projectRoot: '/repo', policy: 'deny', approvalsFile: approvalsPath(home) })
    expect(result.mount).toEqual([])
    expect(result.blocked).toEqual([{ name: 'demo', origin: 'project', reason: 'projectServers is deny' }])
  })

  it('skips a disabled entry rather than mounting or blocking it', () => {
    const home = temp()
    const servers = new Map([
      ['off', { origin: 'project', path: '/repo/.mcp.json', config: normalizeEntry('off', { command: 'x', disabled: true }) }],
    ])
    const result = partition({ servers, projectRoot: '/repo', policy: 'ask', approvalsFile: approvalsPath(home) })
    expect(result.mount).toEqual([])
    expect(result.blocked).toEqual([])
  })
})

describe('a definition carries no session directory', () => {
  it('hashes one user-global server identically in every workspace', () => {
    // What two different sessions normalize from the same file: identical, because nothing about a
    // session was passed in. This is what lets one cached catalog and one approval record serve both.
    const inA = normalizeEntry('codegraph', { command: 'codegraph', args: ['serve', '--mcp'] }) as ServerConfig
    const inB = normalizeEntry('codegraph', { command: 'codegraph', args: ['serve', '--mcp'] }) as ServerConfig
    expect(inA.cwd).toBeUndefined()
    expect(definitionHash(inA)).toBe(definitionHash(inB))
  })

  it('still hashes a directory the config file actually wrote', () => {
    const plain = normalizeEntry('demo', { command: 'node' }) as ServerConfig
    const pinned = normalizeEntry('demo', { command: 'node', cwd: './servers' }) as ServerConfig
    // A relative value stays relative: it means "inside the session's directory", so the definition
    // reads the same in every checkout while the path it resolves to differs.
    expect(pinned.cwd).toBe('./servers')
    expect(definitionHash(pinned)).not.toBe(definitionHash(plain))
    expect(definitionHash(pinned)).toBe(definitionHash(
      normalizeEntry('demo', { command: 'node', cwd: './servers' }) as ServerConfig,
    ))
  })
})
