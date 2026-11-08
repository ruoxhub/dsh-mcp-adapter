// The tool catalog as the model sees it: prefixed names, filters, search ranking, and the compact
// parameter summaries that keep `mcp({ search })` cheap.

import { prefixedToolName } from './util.ts'
import type { AdapterSettings } from './config.ts'
import type { Catalog, CatalogTool, CatalogToolSearchFields, SearchItem, SearchPage, ServerCatalog, ServerConfig } from './types.ts'

/**
 * Anything object-shaped, arrays included. The source's own checks are `typeof x === 'object'` plus
 * a null test, so an array-shaped schema field is read the way it read it: as an object.
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * One server's catalog as `buildCatalog` receives it: the config to read filters off, and the raw
 * catalog when the server has one. A pool entry without a catalog is a server never warmed yet.
 */
export interface BuildCatalogEntry {
  config: ServerConfig
  catalog?: ServerCatalog
}

/** Server name -> its tools, after include/exclude filters and name prefixing. */
export function buildCatalog(servers: Map<string, BuildCatalogEntry>, settings: Partial<AdapterSettings> = {}): Catalog {
  const tools = new Map<string, CatalogTool>()
  const resources: Catalog['resources'] = new Map()
  const prompts: Catalog['prompts'] = new Map()
  for (const [serverName, entry] of servers) {
    const config = entry.config
    const prefix = typeof config.toolPrefix === 'string' ? config.toolPrefix : typeof settings.toolPrefix === 'string' ? settings.toolPrefix : ''
    for (const tool of entry.catalog?.tools ?? []) {
      const candidates = getToolCandidates(tool.name, serverName, prefix)
      if (config.includeTools && !matchesAny(candidates, config.includeTools)) continue
      if (config.excludeTools && matchesAny(candidates, config.excludeTools)) continue
      const name = prefixedToolName(serverName, tool.name, prefix)
      const entry: CatalogTool = {
        name,
        server: serverName,
        originalName: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        hasOutputSchema: tool.hasOutputSchema === true,
        annotations: tool.annotations,
        keywords: keywordsFor(config.searchKeywords, candidates),
      }
      entry.search = computeSearchFields(entry)
      tools.set(name, entry)
    }
    if (config.exposeResources !== false && settings.exposeResources !== false) {
      for (const resource of entry.catalog?.resources ?? []) {
        const name = prefixedToolName(serverName, resource.name || 'resource', prefix)
        resources.set(name, { name, server: serverName, uri: resource.uri, description: resource.description ?? '', mimeType: resource.mimeType })
      }
    }
    for (const prompt of entry.catalog?.prompts ?? []) {
      prompts.set(`${serverName}:${prompt.name}`, { server: serverName, ...prompt })
    }
  }
  return { tools, resources, prompts }
}

/**
 * Lowercase the fields `searchTools` scores on, once per catalog build instead of once per search.
 * A hand-built `CatalogTool` without `search` still works: `searchTools` computes these lazily.
 */
export function computeSearchFields(tool: CatalogTool): CatalogToolSearchFields {
  return {
    name: tool.name.toLowerCase(),
    originalName: tool.originalName.toLowerCase(),
    server: tool.server.toLowerCase(),
    description: tool.description.toLowerCase(),
    normalizedName: tool.name.toLowerCase().replace(/[-_]/g, ''),
    keywords: tool.keywords.map((keyword) => keyword.toLowerCase()),
    parameters: summarizeParameters(tool.inputSchema),
  }
}

/** Simple glob matching: `*` matches any run of characters, `?` matches a single character. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

export function matchesPattern(candidate: string, pattern: string): boolean {
  if (pattern.includes('*') || pattern.includes('?')) {
    return globToRegExp(pattern).test(candidate)
  }
  return candidate === pattern
}

export function getToolCandidates(originalName: string, serverName: string, prefix: string): Set<string> {
  const prefixed = prefixedToolName(serverName, originalName, prefix)
  const candidates = new Set<string>([
    originalName,
    prefixed,
    `${serverName}_${originalName}`,
    `${serverName}.${originalName}`,
  ])
  const normalized = originalName.replace(/-/g, '_')
  if (normalized !== originalName) {
    candidates.add(normalized)
    candidates.add(prefixedToolName(serverName, normalized, prefix))
    candidates.add(`${serverName}_${normalized}`)
  }
  return candidates
}

/** Include/exclude globs: matches if any pattern matches any candidate name. */
export function matchesAny(candidates: Set<string> | string, patterns: string[]): boolean {
  const candidateSet = typeof candidates === 'string' ? new Set([candidates]) : candidates
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    for (const candidate of candidateSet) {
      if (matchesPattern(candidate, pattern)) return true
    }
  }
  return false
}

/** Per-server `searchKeywords`: exact name, prefixed name, glob pattern, or `*` for every tool. */
function keywordsFor(configured: unknown, candidates: Set<string>): string[] {
  if (!isObjectLike(configured)) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(configured)) {
    if (!Array.isArray(value)) continue
    if (key === '*') {
      out.push(...value.map(String))
      continue
    }
    for (const candidate of candidates) {
      if (matchesPattern(candidate, key)) {
        out.push(...value.map(String))
        break
      }
    }
  }
  return out
}

export interface SearchOptions {
  limit?: number
  offset?: number
  regex?: boolean
  includeSchemas?: boolean
  server?: string
}

/**
 * Rank tools for a query. Weighted matches across name, server, description, and keywords, with
 * an exact-phrase bonus — the same shape as pi-mcp-adapter's lexical search, and it works offline
 * because it only reads the cached catalog.
 * @returns `{ items, total, hasMore, nextOffset }` over prefixed tool names.
 */
export function searchTools(catalog: Catalog, query: string, { limit = 12, offset = 0, regex = false, includeSchemas = true, server }: SearchOptions = {}): SearchPage {
  const candidates = [...catalog.tools.values()].filter((tool) => server === undefined || tool.server === server)
  let scored: Array<{ tool: CatalogTool; score: number }>
  if (regex && query) {
    let pattern: RegExp
    try {
      pattern = new RegExp(query, 'i')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { items: [], total: 0, hasMore: false, nextOffset: null, error: `invalid regex: ${message}` }
    }
    scored = candidates.filter((tool) => pattern.test(tool.name) || pattern.test(tool.description)).map((tool) => ({ tool, score: 1 }))
  } else {
    const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) {
      scored = candidates.map((tool) => ({ tool, score: 1 }))
    } else {
      // `query` may be any string, including one that is only whitespace: that is the empty search.
      scored = []
      for (const tool of candidates) {
        // `buildCatalog` precomputes these; a hand-built CatalogTool derives them here once.
        const fields = tool.search ?? (tool.search = computeSearchFields(tool))
        let score = 0
        let matchedAll = true
        for (const term of terms) {
          let termScore = 0
          if (fields.name === term || fields.originalName === term) termScore += 100
          if (fields.name.includes(term)) termScore += 40
          // Hyphens and underscores are interchangeable, as in pi-mcp-adapter's fuzzy naming.
          if (fields.normalizedName.includes(term.replace(/[-_]/g, ''))) termScore += 20
          if (fields.keywords.some((keyword) => keyword === term)) termScore += 30
          if (fields.keywords.some((keyword) => keyword.includes(term))) termScore += 10
          if (fields.description.includes(term)) termScore += 5
          if (fields.server.includes(term)) termScore += 2
          if (termScore === 0) matchedAll = false
          score += termScore
        }
        if (matchedAll && score > 0) scored.push({ tool, score })
      }
      scored.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    }
  }

  const total = scored.length
  const page = scored.slice(offset, offset + limit)
  const items: SearchItem[] = page.map(({ tool }) => ({
    name: tool.name,
    server: tool.server,
    description: tool.description,
    ...(includeSchemas ? { parameters: (tool.search ?? (tool.search = computeSearchFields(tool))).parameters } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }))
  return { items, total, hasMore: offset + page.length < total, nextOffset: offset + page.length < total ? offset + page.length : null }
}

/** A one-line parameter summary: `query, limit?` — required first, nested detail left to describe. */
export function summarizeParameters(schema: unknown): string | null {
  if (!isObjectLike(schema) || schema.type !== 'object' || !isObjectLike(schema.properties)) return null
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const names = Object.keys(schema.properties)
  const ordered = [...names.filter((name) => required.has(name)), ...names.filter((name) => !required.has(name))]
  return ordered.map((name) => (required.has(name) ? name : `${name}?`)).join(', ')
}

/** Render one search page the way the proxy tool returns it. */
export function formatSearchPage(page: SearchPage, query: string): string {
  if (page.error) return page.error
  if (page.total === 0) return `No MCP tools match "${query}".`
  const lines = [`MCP tools matching "${query}" (${page.total} total, showing ${page.items.length}):`, '']
  for (const item of page.items) {
    const params = item.parameters ? `(${item.parameters})` : ''
    lines.push(`${item.name}${params} [${item.server}] — ${item.description || '(no description)'}`)
  }
  if (page.hasMore) lines.push('', `More results: mcp({ search: ${JSON.stringify(query)}, offset: ${page.nextOffset} })`)
  lines.push('', 'Call one with mcp({ tool: "<name>", args: { ... } }).')
  return lines.join('\n')
}

/** The full description of one tool, including its JSON Schema. */
export function describeTool(catalog: Catalog, name: string, { includeSchema = true }: { includeSchema?: boolean } = {}): string {
  const tool = catalog.tools.get(name) ?? [...catalog.tools.values()].find((candidate) => candidate.originalName === name)
  if (tool === undefined) {
    const suggestions = [...catalog.tools.keys()].filter((candidate) => candidate.includes(name) || name.includes(candidate)).slice(0, 5)
    return suggestions.length > 0
      ? `No MCP tool named "${name}". Did you mean: ${suggestions.join(', ')}?`
      : `No MCP tool named "${name}".`
  }
  const lines = [`${tool.name} [${tool.server}]`, tool.description || '(no description)']
  const hints = describeAnnotations(tool.annotations)
  if (hints) lines.push(`Hints: ${hints}`)
  if (includeSchema && tool.inputSchema) lines.push('', 'Parameters (JSON Schema):', JSON.stringify(tool.inputSchema, null, 2))
  return lines.join('\n')
}

function describeAnnotations(annotations: CatalogTool['annotations']): string {
  if (!annotations) return ''
  const hints: string[] = []
  if (annotations.readOnlyHint === true) hints.push('read-only')
  if (annotations.destructiveHint === true) hints.push('destructive')
  if (annotations.idempotentHint === true) hints.push('idempotent')
  if (annotations.openWorldHint === true) hints.push('open-world')
  return hints.join(', ')
}
