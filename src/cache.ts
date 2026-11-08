// The tool catalog cache. This is what lets search and describe work while a server is stopped:
// the tool list, resources, prompts, and instructions are persisted, keyed by a hash of the
// definition, so an edited server starts from a clean slate instead of serving a stale catalog.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { definitionHash } from './trust.ts'
import type { ServerCatalog, ServerConfig, ServerTool } from './types.ts'

/**
 * ADR-0010: v2 stops persisting each tool's `outputSchema` in full. The SDK validates results
 * from its own `tools/list` cache, so the adapter only needs to know whether a schema was
 * declared. On real data that is ~3.6 MB of a 4 MB cache file that was parsed on every `sync()`
 * and never read. A v1 file fails the envelope check and cold-starts once.
 */
export const CACHE_VERSION = 2

/**
 * One server's persisted catalog: the server's own payload from `ServerCatalog`, plus the hash of
 * the definition it was fetched from and when. Keeping the payload shape as `ServerCatalog` is what
 * lets a restored entry be handed to `buildCatalog` exactly like a live one.
 */
export interface CachedCatalog extends ServerCatalog {
  configHash: string
  cachedAt: number
}

/**
 * The whole cache file. Only the envelope (`version`, object-shaped `servers`) is checked on read;
 * each entry keeps its declared shape without field-by-field validation, which is what the source
 * did — the cache is this adapter's own file, and a stale or edited one still has to hash-match
 * before it is served.
 */
export interface CatalogCache {
  version: number
  servers: Record<string, CachedCatalog>
}

export function cachePath(home: string): string {
  return join(home, 'mcp-cache.json')
}

/** A stable hash of the fields that change the catalog: transport addressing and tool filters. */
export function configHash(config: ServerConfig): string {
  return createHash('sha256')
    .update(JSON.stringify([
      definitionHash(config),
      config.includeTools ?? null,
      config.excludeTools ?? null,
      config.exposeResources !== false,
    ]))
    .digest('hex')
}

function emptyCache(): CatalogCache {
  return { version: CACHE_VERSION, servers: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The envelope the source accepted: matching version, `servers` object-shaped and not null. */
function isCatalogCache(value: unknown): value is CatalogCache {
  if (!isRecord(value)) return false
  return value.version === CACHE_VERSION && typeof value.servers === 'object' && value.servers !== null
}

export function loadCache(path: string): CatalogCache {
  if (!existsSync(path)) return emptyCache()
  try {
    // Rejecting the wrong shape is what makes a corrupt or upgraded file a cold start.
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isCatalogCache(parsed) ? parsed : emptyCache()
  } catch {
    // A corrupt cache is a cold start, never a crash.
    return emptyCache()
  }
}

export function saveCache(path: string, cache: CatalogCache): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(cache), 'utf8')
  renameSync(temporary, path)
}

/** The cached catalog for one server, or undefined when the definition changed. */
export function cachedEntry(cache: CatalogCache, name: string, config: ServerConfig): CachedCatalog | undefined {
  const entry = cache.servers?.[name]
  if (!entry || entry.configHash !== configHash(config)) return undefined
  return entry
}

/**
 * The persisted form of one tool: the fields `buildCatalog` and `searchTools` actually read, plus
 * the ADR-0010 presence flag. Projecting at the write boundary (rather than relying on every
 * producer) is what guarantees a full `outputSchema` never reaches `mcp-cache.json` — the file is
 * editable by hand, so a stray schema in a catalog would otherwise be serialized back verbatim.
 */
function storedTool(tool: ServerTool): ServerTool {
  // A hand-edited/older catalog may still carry the full schema under the removed field name.
  // Read it only to derive the flag; never copy it into the persisted entry.
  const legacy = (tool as ServerTool & { outputSchema?: unknown }).outputSchema
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description ?? '',
    ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    hasOutputSchema: tool.hasOutputSchema === true || legacy !== undefined,
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  }
}

/** Replace one server's catalog. A server that reports nothing keeps an explicit empty catalog. */
export function storeEntry(cache: CatalogCache, name: string, config: ServerConfig, catalog: ServerCatalog): CachedCatalog {
  cache.servers[name] = {
    configHash: configHash(config),
    tools: (catalog.tools ?? []).map(storedTool),
    resources: catalog.resources ?? [],
    prompts: catalog.prompts ?? [],
    instructions: catalog.instructions ?? '',
    cachedAt: Date.now(),
  }
  return cache.servers[name]
}

export function forgetEntry(cache: CatalogCache, name: string): void {
  delete cache.servers[name]
}

/** Purge one server's catalog from the persistent cache file on disk. */
export function purgeCacheEntry(path: string, name: string): void {
  const cache = loadCache(path)
  if (cache.servers && name in cache.servers) {
    forgetEntry(cache, name)
    saveCache(path, cache)
  }
}
