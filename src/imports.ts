// Adopting the MCP files other coding agents already have on this machine.
//
// pi-mcp-adapter imports Cursor / Claude Code / Codex / VS Code configs. The same files are the
// reason a user has nothing to retype here: a repository's `.mcp.json` is already read directly,
// and these global files are where the per-machine servers live.
//
// Importing is opt-in (`settings.importHosts`), because reading another tool's credentials file
// without being asked is a surprise, not a feature.
//
// `config.ts` imports this module and this module imports `config.ts`: a real cycle. Both
// directions are function declarations used at call time, never during module evaluation, so the
// ESM live bindings resolve it. Do not "fix" it by inverting either side.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseJsonText } from './config.ts'
import type {
  ExternalMcpCandidate,
  ExternalMcpScanResult,
  ExternalMcpSourceReport,
  McpSourceKind,
} from './types.ts'

/** One place a host keeps its servers: the file, and the key holding the server map inside it. */
export interface HostConfig {
  host: string
  path: string
  key: string
}

/** One adopted server, with the file that defined it and the raw entry `normalizeEntry` reads. */
export interface ImportedHostServer {
  origin: 'imported'
  path: string
  host: string
  raw: unknown
}

/** One host file that actually contributed at least one server. */
export interface ImportedHostSource {
  host: string
  path: string
  count: number
}

export interface ImportHostServersResult {
  servers: Map<string, ImportedHostServer>
  sources: ImportedHostSource[]
  errors: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  }
  return out
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Sanitize server name to standard alphanumeric plus dash/underscore */
export function sanitizeServerId(rawKey: string): string {
  const cleaned = rawKey.trim().replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'mcp_server'
}

/**
 * The known host config locations, per host.
 * @param home - the user's home directory.
 * @returns `{ host, path, key }` entries; `key` names where that host keeps its servers.
 */
export function hostConfigs(home: string = homedir()): HostConfig[] {
  return [
    { host: 'claude-code', path: join(home, '.claude', 'mcp.json'), key: 'mcpServers' },
    { host: 'claude-code', path: join(home, '.claude.json'), key: 'mcpServers' },
    { host: 'cursor', path: join(home, '.cursor', 'mcp.json'), key: 'mcpServers' },
    { host: 'vscode', path: join(home, '.vscode', 'mcp.json'), key: 'servers' },
    { host: 'codex', path: join(home, '.codex', 'config.json'), key: 'mcpServers' },
    // The de-facto shared file several agents read.
    { host: 'shared', path: join(home, '.config', 'mcp', 'mcp.json'), key: 'mcpServers' },
    { host: 'agents', path: join(home, '.agents', 'mcp.json'), key: 'mcpServers' },
  ]
}

/**
 * Read the hosts the user opted into.
 * @param hosts - host names from `settings.importHosts`; `true` means every known host.
 * @returns `{ servers, sources, errors }` — servers keyed by name, with the file they came from.
 */
export function importHostServers(hosts: boolean | string[] | undefined, home: string = homedir()): ImportHostServersResult {
  const wanted = hosts === true ? undefined : new Set(Array.isArray(hosts) ? hosts.map(String) : [])
  if (hosts === false || hosts === undefined || (wanted !== undefined && wanted.size === 0)) {
    return { servers: new Map<string, ImportedHostServer>(), sources: [], errors: [] }
  }
  const servers = new Map<string, ImportedHostServer>()
  const sources: ImportedHostSource[] = []
  const errors: string[] = []
  for (const config of hostConfigs(home)) {
    if (wanted !== undefined && !wanted.has(config.host)) continue
    if (!existsSync(config.path)) continue
    let value: unknown
    try {
      value = parseJsonText(readFileSync(config.path, 'utf8'), config.path)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      continue
    }
    const found = isRecord(value) ? value[config.key] : undefined
    if (!isRecord(found)) continue
    let count = 0
    for (const [name, entry] of Object.entries(found)) {
      if (servers.has(name)) continue
      servers.set(name, { origin: 'imported', path: config.path, host: config.host, raw: entry })
      count += 1
    }
    if (count > 0) sources.push({ host: config.host, path: config.path, count })
  }
  return { servers, sources, errors }
}

export function candidateFromRecord(
  source: McpSourceKind,
  sourcePath: string,
  rawKey: string,
  raw: Record<string, unknown>,
): ExternalMcpCandidate {
  const warnings: string[] = []
  const id = sanitizeServerId(rawKey)
  const label = typeof raw.label === 'string' && raw.label.trim()
    ? raw.label.trim()
    : typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim()
      : rawKey

  const description = typeof raw.description === 'string' && raw.description.trim()
    ? raw.description.trim()
    : undefined

  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  const command = typeof raw.command === 'string'
    ? raw.command.trim()
    : Array.isArray(raw.command)
      ? String(raw.command[0] || '').trim()
      : ''

  const args = Array.isArray(raw.command)
    ? raw.command.slice(1).map(String)
    : stringList(raw.args) ?? []

  const declared = typeof raw.type === 'string'
    ? raw.type.toLowerCase()
    : typeof raw.transport === 'string'
      ? raw.transport.toLowerCase()
      : ''

  const isHttp = Boolean(url) || declared.includes('http') || declared.includes('sse')
  const isSocket = Boolean(raw.socket) || declared.includes('socket')
  const disabled = raw.disabled === true || raw.enabled === false ? true : undefined

  if (isHttp) {
    if (!url) warnings.push('HTTP server missing URL')
    return {
      source,
      sourcePath,
      id,
      rawKey,
      label,
      description,
      transport: 'http',
      url: url || undefined,
      headers: stringMap(raw.headers),
      disabled,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  if (isSocket) {
    return {
      source,
      sourcePath,
      id,
      rawKey,
      label,
      description,
      transport: 'socket',
      url: typeof raw.socket === 'string' ? raw.socket : undefined,
      disabled,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  if (!command) warnings.push('stdio server missing command')
  return {
    source,
    sourcePath,
    id,
    rawKey,
    label,
    description,
    transport: 'stdio',
    command: command || undefined,
    args,
    env: stringMap(raw.env),
    disabled,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

export interface ScanExternalOptions {
  homeDir?: string
  projectPath?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

function resolveClaudeDesktopPath(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (platform === 'win32') {
    const appdata = env.APPDATA && env.APPDATA.trim() ? env.APPDATA : join(home, 'AppData', 'Roaming')
    return join(appdata, 'Claude', 'claude_desktop_config.json')
  }
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(home, '.config')
  return join(xdg, 'Claude', 'claude_desktop_config.json')
}

export function scanFileForMcp(
  source: McpSourceKind,
  filePath: string,
  keyExtractor?: (root: Record<string, unknown>) => Record<string, unknown> | null,
): { report: ExternalMcpSourceReport; candidates: ExternalMcpCandidate[] } {
  const report: ExternalMcpSourceReport = { kind: source, path: filePath, exists: false, count: 0 }
  if (!existsSync(filePath)) {
    return { report, candidates: [] }
  }
  report.exists = true
  let root: unknown
  try {
    const text = readFileSync(filePath, 'utf8')
    root = parseJsonText(text, filePath)
  } catch (err: unknown) {
    report.error = err instanceof Error ? err.message : String(err)
    return { report, candidates: [] }
  }

  if (!isRecord(root)) {
    report.error = 'Root is not an object'
    return { report, candidates: [] }
  }

  let serverMap: Record<string, unknown> | null = null
  if (keyExtractor) {
    serverMap = keyExtractor(root)
  } else {
    serverMap = isRecord(root.mcpServers)
      ? root.mcpServers
      : isRecord(root.servers)
        ? root.servers
        : isRecord(root.mcp)
          ? root.mcp
          : null
  }

  if (!isRecord(serverMap)) {
    return { report, candidates: [] }
  }

  const candidates: ExternalMcpCandidate[] = []
  for (const [key, value] of Object.entries(serverMap)) {
    if (!isRecord(value)) continue
    candidates.push(candidateFromRecord(source, filePath, key, value))
  }
  report.count = candidates.length
  return { report, candidates }
}

export function scanDirectoryForSingleServerJson(
  source: McpSourceKind,
  dirPath: string,
): { report: ExternalMcpSourceReport; candidates: ExternalMcpCandidate[] } {
  const report: ExternalMcpSourceReport = { kind: source, path: dirPath, exists: false, count: 0 }
  if (!existsSync(dirPath)) {
    return { report, candidates: [] }
  }
  report.exists = true
  const candidates: ExternalMcpCandidate[] = []
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith('.json')) {
        const full = join(dirPath, ent.name)
        try {
          const content = readFileSync(full, 'utf8')
          const parsed = parseJsonText(content, full)
          if (isRecord(parsed)) {
            const rawKey = typeof parsed.id === 'string' ? parsed.id : basename(ent.name, '.json')
            candidates.push(candidateFromRecord(source, full, rawKey, parsed))
          }
        } catch {
          // ignore corrupted single files
        }
      }
    }
    report.count = candidates.length
  } catch (err: unknown) {
    report.error = err instanceof Error ? err.message : String(err)
  }
  return { report, candidates }
}

export function scanExternalMcp(opts: ScanExternalOptions = {}): ExternalMcpScanResult {
  const home = opts.homeDir ?? homedir()
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env

  const candidates: ExternalMcpCandidate[] = []
  const sources: ExternalMcpSourceReport[] = []

  // 1. Claude Desktop
  const claudeDesktopFile = resolveClaudeDesktopPath(home, platform, env)
  const cd = scanFileForMcp('claude-desktop', claudeDesktopFile)
  sources.push(cd.report)
  candidates.push(...cd.candidates)

  // 2. Claude Code
  const ccSettings = scanFileForMcp('claude-code', join(home, '.claude', 'settings.json'))
  const ccLegacy = scanFileForMcp('claude-code', join(home, '.claude.json'))
  const ccMcp = scanFileForMcp('claude-code', join(home, '.claude', 'mcp.json'))
  sources.push(ccSettings.report, ccLegacy.report, ccMcp.report)
  candidates.push(...ccSettings.candidates, ...ccLegacy.candidates, ...ccMcp.candidates)

  // 3. Cursor Global
  const curGlobal = scanFileForMcp('cursor-global', join(home, '.cursor', 'mcp.json'))
  sources.push(curGlobal.report)
  candidates.push(...curGlobal.candidates)

  // 4. Cursor Project
  if (opts.projectPath) {
    const curProj = scanFileForMcp('cursor-project', join(opts.projectPath, '.cursor', 'mcp.json'))
    sources.push(curProj.report)
    candidates.push(...curProj.candidates)
  }

  // 5. VS Code
  const vscGlobal = scanFileForMcp('vscode', join(home, '.vscode', 'mcp.json'))
  sources.push(vscGlobal.report)
  candidates.push(...vscGlobal.candidates)
  if (opts.projectPath) {
    const vscProj = scanFileForMcp('vscode', join(opts.projectPath, '.vscode', 'mcp.json'))
    sources.push(vscProj.report)
    candidates.push(...vscProj.candidates)
  }

  // 6. Codex
  const codexJson = scanFileForMcp('codex', join(home, '.codex', 'config.json'))
  sources.push(codexJson.report)
  candidates.push(...codexJson.candidates)

  // 7. OpenCode
  const ocConfig = scanFileForMcp('opencode', join(home, '.config', 'opencode', 'opencode.json'))
  const ocHome = scanFileForMcp('opencode', join(home, '.opencode.json'))
  sources.push(ocConfig.report, ocHome.report)
  candidates.push(...ocConfig.candidates, ...ocHome.candidates)

  // 8. Agents Servers (PI-Desktop directory layout)
  const agentsGlobalMcp = scanFileForMcp('agents-servers', join(home, '.agents', 'mcp.json'))
  const agentsGlobalDir = scanDirectoryForSingleServerJson('agents-servers', join(home, '.agents', 'servers'))
  sources.push(agentsGlobalMcp.report, agentsGlobalDir.report)
  candidates.push(...agentsGlobalMcp.candidates, ...agentsGlobalDir.candidates)

  if (opts.projectPath) {
    const agentsProjDir = scanDirectoryForSingleServerJson('agents-servers', join(opts.projectPath, '.agents', 'servers'))
    sources.push(agentsProjDir.report)
    candidates.push(...agentsProjDir.candidates)
  }

  // 9. ChatGPT Desktop
  sources.push({ kind: 'chatgpt-desktop', path: '', exists: false, count: 0 })

  // Deduplicate candidates by `${cand.source}:${cand.id}`
  const seen = new Set<string>()
  const deduped: ExternalMcpCandidate[] = []
  for (const c of candidates) {
    const key = `${c.source}:${c.id}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(c)
  }

  return { candidates: deduped, sources }
}
