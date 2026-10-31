// Direct cover for the host-config adoption module.
//
// The e2e suite reaches this module only through `loadConfig`'s adoption branch, so the
// opt-in gate, the per-host key names and the first-host-wins rule had no test of their own.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { hostConfigs, importHostServers } from '../src/imports.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-imports-'))
  dirs.push(dir)
  return dir
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value), 'utf8')
}

/** The path each known host uses for its server map, keyed by host name. */
function pathOf(home: string, host: string): string {
  const entry = hostConfigs(home).find((candidate) => candidate.host === host)
  if (entry === undefined) throw new Error(`unknown host ${host}`)
  return entry.path
}

describe('host configs', () => {
  it('lists the seven known host files, with vscode keeping its own key name', () => {
    const configs = hostConfigs('/home/u')
    expect(configs).toHaveLength(7)
    expect(configs.map((entry) => entry.host)).toEqual([
      'claude-code', 'claude-code', 'cursor', 'vscode', 'codex', 'shared', 'agents',
    ])
    // Only VS Code spells the map `servers`; every other host uses `mcpServers`.
    expect(configs.filter((entry) => entry.key === 'servers').map((entry) => entry.host)).toEqual(['vscode'])
    expect(configs[0].path).toBe(join('/home/u', '.claude', 'mcp.json'))
  })

  it('reads nothing unless the user opted in', () => {
    const home = temp()
    write(pathOf(home, 'cursor'), { mcpServers: { demo: { command: 'npx' } } })
    for (const hosts of [false, undefined, [] as string[]]) {
      const result = importHostServers(hosts, home)
      expect(result.servers.size).toBe(0)
      expect(result.sources).toEqual([])
      expect(result.errors).toEqual([])
    }
  })

  // The opt-in early return is what keeps `false` meaning "do not read anyone's credential files".
  // Without it the empty-wanted set still skips every host, so the three assertions above cannot tell
  // the two implementations apart. This one can: it proves the early return fires BEFORE any file is
  // read, by planting a file that would report an error if it were opened at all.
  it('does not even open a host file when the user has not opted in', () => {
    const home = temp()
    const broken = pathOf(home, 'cursor')
    mkdirSync(dirname(broken), { recursive: true })
    writeFileSync(broken, '{ not json', 'utf8')

    for (const hosts of [false, undefined]) {
      const result = importHostServers(hosts, home)
      // Opening the broken file would push an error; the early return happens first, so it stays empty.
      expect(result.errors).toEqual([])
      expect(result.servers.size).toBe(0)
    }

    // Control: with a real opt-in the same file IS read, which is what makes the assertion above
    // meaningful rather than vacuous.
    expect(importHostServers(['cursor'], home).errors).toHaveLength(1)
  })

  it('adopts only the named host when given a list, and tags the origin', () => {
    const home = temp()
    write(pathOf(home, 'cursor'), { mcpServers: { fromCursor: { command: 'a' } } })
    write(pathOf(home, 'codex'), { mcpServers: { fromCodex: { command: 'b' } } })

    const result = importHostServers(['cursor'], home)
    expect([...result.servers.keys()]).toEqual(['fromCursor'])
    expect(result.servers.get('fromCursor')).toMatchObject({
      origin: 'imported',
      host: 'cursor',
      path: pathOf(home, 'cursor'),
    })
    expect(result.sources).toEqual([{ host: 'cursor', path: pathOf(home, 'cursor'), count: 1 }])
  })

  it('reads every known host under the vscode key name too when asked for everything', () => {
    const home = temp()
    write(pathOf(home, 'vscode'), { servers: { fromVsCode: { command: 'c' } } })
    const result = importHostServers(true, home)
    expect([...result.servers.keys()]).toEqual(['fromVsCode'])
    expect(result.servers.get('fromVsCode')?.host).toBe('vscode')
  })

  it('lets the first host that defines a name win', () => {
    const home = temp()
    // hostConfigs lists claude-code's project file before cursor, so claude-code wins.
    write(pathOf(home, 'claude-code'), { mcpServers: { shared: { command: 'first' } } })
    write(pathOf(home, 'cursor'), { mcpServers: { shared: { command: 'second' } } })

    const result = importHostServers(true, home)
    expect(result.servers.get('shared')?.raw).toEqual({ command: 'first' })
    expect(result.servers.get('shared')?.host).toBe('claude-code')
  })

  it('reports an unreadable file and keeps importing the rest', () => {
    const home = temp()
    const broken = pathOf(home, 'cursor')
    mkdirSync(dirname(broken), { recursive: true })
    writeFileSync(broken, '{ not json', 'utf8')
    write(pathOf(home, 'codex'), { mcpServers: { fine: { command: 'x' } } })

    const result = importHostServers(true, home)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('invalid JSON')
    expect([...result.servers.keys()]).toEqual(['fine'])
  })

  it('ignores a host file whose server map is missing or not an object', () => {
    const home = temp()
    write(pathOf(home, 'cursor'), { mcpServers: ['not', 'a', 'map'] })
    write(pathOf(home, 'codex'), { somethingElse: {} })
    const result = importHostServers(true, home)
    expect(result.servers.size).toBe(0)
    expect(result.sources).toEqual([])
    expect(result.errors).toEqual([])
  })
})
