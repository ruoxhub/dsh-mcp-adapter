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

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseJsonText } from './config.ts'

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
      // The first host that defines a name wins, matching "the file it already lives in".
      if (servers.has(name)) continue
      servers.set(name, { origin: 'imported', path: config.path, host: config.host, raw: entry })
      count += 1
    }
    if (count > 0) sources.push({ host: config.host, path: config.path, count })
  }
  return { servers, sources, errors }
}
