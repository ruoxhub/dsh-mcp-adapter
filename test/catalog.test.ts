import { describe, expect, it } from 'vitest'
import { buildCatalog, describeTool, searchTools, summarizeParameters } from '../src/catalog.ts'
import { configHash, cachedEntry, loadCache, saveCache, storeEntry } from '../src/cache.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Additions for the coverage appended below; the four imports above are the brief's, untouched.
import { afterEach } from 'vitest'
import { formatSearchPage } from '../src/catalog.ts'
import { cachePath, CACHE_VERSION, forgetEntry } from '../src/cache.ts'
import { isDisabledEntry, normalizeEntry } from '../src/config.ts'
import { definitionHash } from '../src/trust.ts'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { ServerConfig } from '../src/types.ts'

const config = { name: 'demo', transport: 'stdio', args: [], env: {}, inheritEnv: true, cwd: '', headers: {}, lifecycle: 'lazy', directTools: false, exposeResources: true, appendStructuredContent: true, debug: false } as const

function catalogOf(names: string[]) {
  const entry = {
    config,
    catalog: {
      tools: names.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })),
      resources: [], prompts: [], instructions: '',
    },
  }
  return buildCatalog(new Map([['demo', entry as never]]), {})
}

describe('catalog', () => {
  it('prefixes tool names and ranks an exact match first', () => {
    const catalog = catalogOf(['ping', 'take_screenshot'])
    expect([...catalog.tools.keys()]).toEqual(['demo_ping', 'demo_take_screenshot'])
    expect(searchTools(catalog, 'take_screenshot').items[0].name).toBe('demo_take_screenshot')
  })

  it('summarizes parameters with required first', () => {
    expect(summarizeParameters({ type: 'object', properties: { q: {}, limit: {} }, required: ['q'] })).toBe('q, limit?')
  })

  it('suggests a near miss instead of failing silently', () => {
    expect(describeTool(catalogOf(['ping']), 'pong')).toContain('No MCP tool named "pong"')
  })

  it('never serves a cached catalog whose definition changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-cache-'))
    const path = join(dir, 'mcp-cache.json')
    const cache = loadCache(path)
    storeEntry(cache, 'demo', config as never, { tools: [{ name: 'ping' }], resources: [], prompts: [], instructions: '' })
    saveCache(path, cache)
    const reloaded = loadCache(path)
    expect(cachedEntry(reloaded, 'demo', config as never)?.tools).toHaveLength(1)
    expect(cachedEntry(reloaded, 'demo', { ...config, args: ['-y', 'evil'] } as never)).toBeUndefined()
    expect(configHash(config as never)).toMatch(/^[0-9a-f]{64}$/)
  })
})

// The brief's four tests above are the floor. The rest of both modules is guarded here, because
// they are what search, describe, and the cache actually rest on.

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'mcp-catalog-')); dirs.push(dir); return dir }

/** A real normalized config, so the tests exercise the same field shapes the adapter sees. */
function serverConfig(name = 'demo', extra: Record<string, unknown> = {}): ServerConfig {
  const entry = normalizeEntry(name, { command: 'node', ...extra })
  if (isDisabledEntry(entry)) throw new Error('test config unexpectedly disabled')
  return entry
}

function build(servers: Array<{ config: ServerConfig; tools: string[] }>, settings: Record<string, unknown> = {}) {
  const entries = new Map(servers.map((server) => [server.config.name, {
    config: server.config,
    catalog: {
      tools: server.tools.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } })),
      resources: [{ uri: `file:///${server.config.name}`, name: `${server.config.name}-res` }],
      prompts: [{ name: 'p', description: 'a prompt' }],
      instructions: `${server.config.name} instructions`,
    },
  }]))
  return buildCatalog(entries, settings)
}

describe('configHash', () => {
  it('covers the tool filters and the resource switch, which definitionHash does not', () => {
    const base = serverConfig()
    const includeTools = serverConfig('demo', { includeTools: ['read_*'] })
    const excludeTools = serverConfig('demo', { excludeTools: ['write_*'] })
    const noResources = serverConfig('demo', { exposeResources: false })

    // Each of these edits changes what the catalog holds, so each must invalidate a cached catalog.
    expect(configHash(includeTools)).not.toBe(configHash(base))
    expect(configHash(excludeTools)).not.toBe(configHash(base))
    expect(configHash(noResources)).not.toBe(configHash(base))

    // definitionHash deliberately ignores them: it hashes only what decides what runs.
    expect(definitionHash(includeTools)).toBe(definitionHash(base))
    expect(definitionHash(excludeTools)).toBe(definitionHash(base))
    expect(definitionHash(noResources)).toBe(definitionHash(base))
  })

  it('is stable for the same definition and points at the cache file', () => {
    expect(configHash(serverConfig())).toBe(configHash(serverConfig()))
    expect(cachePath('/home/mcp-adapter')).toBe(join('/home/mcp-adapter', 'mcp-cache.json'))
  })
})

describe('loadCache', () => {
  it('is a cold start for an absent file, malformed JSON, and a wrong version', () => {
    const dir = temp()
    const empty = { version: CACHE_VERSION, servers: {} }

    expect(loadCache(join(dir, 'missing.json'))).toEqual(empty)

    const malformed = join(dir, 'malformed.json')
    writeFileSync(malformed, '{ not json', 'utf8')
    expect(loadCache(malformed)).toEqual(empty)

    const wrongVersion = join(dir, 'wrong-version.json')
    writeFileSync(wrongVersion, JSON.stringify({ version: CACHE_VERSION + 1, servers: { demo: { configHash: 'x' } } }), 'utf8')
    expect(loadCache(wrongVersion)).toEqual(empty)

    // `servers: null` and a non-object payload are the same kind of corrupt: never a crash.
    const nullServers = join(dir, 'null-servers.json')
    writeFileSync(nullServers, JSON.stringify({ version: CACHE_VERSION, servers: null }), 'utf8')
    expect(loadCache(nullServers)).toEqual(empty)
    const arrayRoot = join(dir, 'array-root.json')
    writeFileSync(arrayRoot, JSON.stringify([1, 2, 3]), 'utf8')
    expect(loadCache(arrayRoot)).toEqual(empty)
  })
})

describe('saveCache', () => {
  it('writes through a temporary file and renames it into place', () => {
    const dir = temp()
    const path = join(dir, 'mcp-cache.json')
    const cache = loadCache(path)
    storeEntry(cache, 'demo', serverConfig(), { tools: [{ name: 'ping' }], resources: [], prompts: [], instructions: '' })

    saveCache(path, cache)

    // The payload replaced the target, and the temporary staging file is gone: it was renamed, not
    // left behind. Its exact name is the source's `${path}.${process.pid}.tmp`.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(cache)
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false)
  })

  it('cannot clobber the existing cache when the temporary write fails', () => {
    const dir = temp()
    const path = join(dir, 'mcp-cache.json')
    writeFileSync(path, '{"version":1,"servers":{"keep":{"configHash":"x"}}}', 'utf8')

    // Occupy the temporary path with a directory. A direct write to `path` would succeed and eat the
    // old file; the source's temp-then-rename sequence fails at the staging step instead.
    mkdirSync(`${path}.${process.pid}.tmp`)

    expect(() => saveCache(path, { version: CACHE_VERSION, servers: {} })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{"version":1,"servers":{"keep":{"configHash":"x"}}}')
  })

  it('forgetEntry removes exactly one server', () => {
    const dir = temp()
    const path = join(dir, 'mcp-cache.json')
    const cache = loadCache(path)
    storeEntry(cache, 'alpha', serverConfig('alpha'), { tools: [{ name: 'a' }], resources: [], prompts: [], instructions: '' })
    storeEntry(cache, 'beta', serverConfig('beta'), { tools: [{ name: 'b' }], resources: [], prompts: [], instructions: '' })

    forgetEntry(cache, 'alpha')
    saveCache(path, cache)

    const reloaded = loadCache(path)
    expect(Object.keys(reloaded.servers)).toEqual(['beta'])
    expect(cachedEntry(reloaded, 'alpha', serverConfig('alpha'))).toBeUndefined()
    expect(cachedEntry(reloaded, 'beta', serverConfig('beta'))?.tools).toEqual([{ name: 'b' }])
  })
})

describe('buildCatalog filters and prefixes', () => {
  it('applies includeTools and excludeTools, including * wildcards', () => {
    const included = build([{ config: serverConfig('demo', { includeTools: ['read_*'] }), tools: ['read_file', 'write_file'] }])
    expect([...included.tools.keys()]).toEqual(['demo_read_file'])

    const excluded = build([{ config: serverConfig('demo', { excludeTools: ['write_*'] }), tools: ['read_file', 'write_file'] }])
    expect([...excluded.tools.keys()]).toEqual(['demo_read_file'])

    // `*` matches everything, and an exact pattern matches one name and nothing else.
    expect([...build([{ config: serverConfig('demo', { excludeTools: ['*'] }), tools: ['read_file', 'write_file'] }]).tools.keys()]).toEqual([])
    expect([...build([{ config: serverConfig('demo', { includeTools: ['read_file'] }), tools: ['read_file', 'read_files'] }]).tools.keys()]).toEqual(['demo_read_file'])

    // An empty include list is still truthy, so it admits nothing. The source behaves the same way.
    expect([...build([{ config: serverConfig('demo', { includeTools: [] }), tools: ['read_file'] }]).tools.keys()]).toEqual([])
  })

  it('prefixes with the server prefix first, then the settings default', () => {
    expect([...build([{ config: serverConfig('demo', { toolPrefix: 'x_' }), tools: ['ping'] }]).tools.keys()]).toEqual(['x_demo_ping'])
    expect([...build([{ config: serverConfig('demo'), tools: ['ping'] }], { toolPrefix: 's_' }).tools.keys()]).toEqual(['s_demo_ping'])
    expect([...build([{ config: serverConfig('demo', { toolPrefix: 'x_' }), tools: ['ping'] }], { toolPrefix: 's_' }).tools.keys()]).toEqual(['x_demo_ping'])
  })

  it('drops resources for a server that opted out, and re-keys prompts by server', () => {
    const catalog = build([{ config: serverConfig('demo', { exposeResources: false }), tools: ['ping'] }])
    expect([...catalog.resources.keys()]).toEqual([])
    expect([...catalog.prompts.keys()]).toEqual(['demo:p'])
    expect(catalog.prompts.get('demo:p')).toMatchObject({ server: 'demo', name: 'p', description: 'a prompt' })
  })
})

describe('searchTools', () => {
  const tools = ['ping', 'ping_pong', 'take_screenshot', 'list_files', 'read_file']

  it('ranks an exact name match first', () => {
    const catalog = build([{ config: serverConfig('demo'), tools }])
    const page = searchTools(catalog, 'demo_ping')
    expect(page.items[0].name).toBe('demo_ping')
    expect(page.total).toBe(2)
    expect(page.items[1].name).toBe('demo_ping_pong')
  })

  it('keeps an exact match ahead of a tool that wins every other signal', () => {
    // `ping` scores 100 for the exact original name plus the substring and de-hyphen bonuses (160).
    // `ping_alt` collects a keyword match, a description hit, and the same bonuses (105), so only
    // the exact-match weight keeps the exact tool first.
    const catalog = buildCatalog(new Map([['demo', {
      config: serverConfig('demo', { searchKeywords: { ping_alt: ['ping'] } }),
      catalog: {
        tools: [
          { name: 'ping', description: '', inputSchema: { type: 'object', properties: {} } },
          { name: 'ping_alt', description: 'ping', inputSchema: { type: 'object', properties: {} } },
        ],
        resources: [], prompts: [], instructions: '',
      },
    }]]))
    expect(searchTools(catalog, 'ping').items.map((item) => item.name)).toEqual(['demo_ping', 'demo_ping_alt'])
  })

  it('honours server filtering', () => {
    const catalog = build([
      { config: serverConfig('alpha'), tools: ['ping'] },
      { config: serverConfig('beta'), tools: ['ping'] },
    ])
    expect(searchTools(catalog, 'ping').total).toBe(2)
    const filtered = searchTools(catalog, 'ping', { server: 'beta' })
    expect(filtered.total).toBe(1)
    expect(filtered.items[0].name).toBe('beta_ping')
    expect(searchTools(catalog, 'ping', { server: 'nobody' }).total).toBe(0)
  })

  it('pages with limit and offset and reports hasMore and nextOffset', () => {
    const catalog = build([{ config: serverConfig('demo'), tools }])
    const first = searchTools(catalog, 'file', { limit: 1 })
    expect(first.total).toBe(2)
    expect(first.items).toHaveLength(1)
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBe(1)

    const second = searchTools(catalog, 'file', { limit: 1, offset: 1 })
    expect(second.items).toHaveLength(1)
    expect(second.hasMore).toBe(false)
    expect(second.nextOffset).toBeNull()

    const past = searchTools(catalog, 'file', { offset: 99 })
    expect(past.items).toEqual([])
    expect(past.hasMore).toBe(false)
    expect(past.nextOffset).toBeNull()
  })

  it('supports regex mode and reports an invalid pattern as an error', () => {
    const catalog = build([{ config: serverConfig('demo'), tools }])
    const matched = searchTools(catalog, '^demo_ping$', { regex: true })
    expect(matched.total).toBe(1)
    expect(matched.items[0].name).toBe('demo_ping')

    // The pattern is tested against the prefixed name and the description.
    expect(searchTools(catalog, 'screenshot tool', { regex: true }).items[0].name).toBe('demo_take_screenshot')

    const invalid = searchTools(catalog, '[', { regex: true })
    expect(invalid.items).toEqual([])
    expect(invalid.total).toBe(0)
    expect(invalid.hasMore).toBe(false)
    expect(invalid.nextOffset).toBeNull()
    expect(invalid.error).toContain('invalid regex:')
  })

  it('leaves the schema summary off a page only when asked', () => {
    const catalog = build([{ config: serverConfig('demo'), tools: ['ping'] }])
    expect(searchTools(catalog, 'ping').items[0].parameters).toBe('')
    expect('parameters' in searchTools(catalog, 'ping', { includeSchemas: false }).items[0]).toBe(false)
  })
})

describe('formatSearchPage', () => {
  it('renders hits, the empty message, and the next-page hint', () => {
    const catalog = build([{ config: serverConfig('demo'), tools: ['ping', 'ping_pong'] }])
    const page = searchTools(catalog, 'ping')
    const text = formatSearchPage(page, 'ping')
    expect(text).toContain('MCP tools matching "ping" (2 total, showing 2):')
    expect(text).toContain('demo_ping [demo] — ping tool')
    expect(text).toContain('Call one with mcp({ tool: "<name>", args: { ... } }).')

    expect(formatSearchPage(searchTools(catalog, 'nothing-matches'), 'nothing-matches')).toBe('No MCP tools match "nothing-matches".')

    // The hint only appears while a further page exists, and it quotes the query as JSON.
    const firstPage = searchTools(catalog, 'ping', { limit: 1 })
    expect(formatSearchPage(firstPage, 'ping')).toContain('More results: mcp({ search: "ping", offset: 1 })')
    expect(formatSearchPage(searchTools(catalog, 'ping'), 'ping')).not.toContain('More results:')

    // An error page is rendered as the error itself.
    expect(formatSearchPage(searchTools(catalog, '[', { regex: true }), '[')).toContain('invalid regex:')
  })
})

describe('describeTool', () => {
  it('finds a tool by its original name and prints its schema and hints', () => {
    const catalog = build([{ config: serverConfig('demo'), tools: ['ping'] }])
    const description = describeTool(catalog, 'ping')
    expect(description).toContain('demo_ping [demo]')
    expect(description).toContain('Parameters (JSON Schema):')
    expect(describeTool(catalog, 'ping', { includeSchema: false })).not.toContain('Parameters (JSON Schema):')
  })

  it('suggests a near miss by substring, in either direction', () => {
    const catalog = build([{ config: serverConfig('demo'), tools: ['ping'] }])
    // A candidate is suggested when the catalog name contains the query, or the query contains it.
    expect(describeTool(catalog, 'demo_pin')).toBe('No MCP tool named "demo_pin". Did you mean: demo_ping?')
    expect(describeTool(catalog, 'demo_ping_extra')).toBe('No MCP tool named "demo_ping_extra". Did you mean: demo_ping?')
    // 'pong' is a substring of nothing, so there is no suggestion to offer.
    expect(describeTool(catalog, 'pong')).toBe('No MCP tool named "pong".')
  })
})

