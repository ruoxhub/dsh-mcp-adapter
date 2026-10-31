// Project trust: a server written in a cloned repository is code from that repository, so it is
// mounted only after that exact definition was approved once. The record pins project root, server
// name, and a hash of the fields that decide what runs or what runs unwatched — editing the command,
// args, env, url, or headers asks again, because that edit is exactly what an attacker would change;
// editing the approval fields asks again too, or a repository could add `autoApprove: true` to a
// server the user already approved and never show another prompt.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDisabledEntry } from './config.ts'
import type { ServerEntry } from './config.ts'
import type { ServerConfig } from './types.ts'

const APPROVALS_VERSION = 1

/** One approved definition: the repository, the server name, and the hash of what it does. */
export interface ApprovalRecord {
  projectRoot: string
  serverName: string
  definitionHash: string
  approvedAt?: string
}

/**
 * The approvals file. `approvals` stays `unknown[]`: the file is untrusted input, so a record
 * counts only once `isApprovalRecord` accepts it.
 */
export interface ApprovalStore {
  version: number
  approvals: unknown[]
}

/** One server as `partition` receives it: where it came from, and its (possibly disabled) config. */
export interface PartitionEntry {
  origin: string
  path: string
  config: ServerEntry
}

/** One held-back server, with a reason the model can act on. */
export interface BlockedServer {
  name: string
  origin: string
  reason: string
}

export interface PartitionInput {
  servers: Map<string, PartitionEntry>
  projectRoot: string
  policy: 'ask' | 'allow' | 'deny'
  approvalsFile: string
}

export interface PartitionResult {
  mount: PartitionEntry[]
  blocked: BlockedServer[]
}

export function approvalsPath(home: string): string {
  return join(home, 'mcp-project-approvals.json')
}

/**
 * Hash what decides which process runs, which endpoint is contacted, and how that server is gated.
 *
 * The gating fields ride in one trailing element shared by every transport, so a repository that
 * adds `autoApprove` (or changes `approveTools`/`directTools`) to a server the user already approved
 * changes the hash and has to be approved again. Adding a key here changes every existing hash on
 * purpose: the only cost is one re-approval per project server.
 */
export function definitionHash(config: ServerConfig): string {
  const endpoint = config.transport === 'stdio'
    ? ['stdio', config.command, config.args, config.env, config.cwd]
    : config.transport === 'socket'
      ? ['socket', config.socket]
      : ['http', config.url, config.headers]
  const gate = { autoApprove: config.autoApprove, approveTools: config.approveTools, directTools: config.directTools }
  return createHash('sha256').update(JSON.stringify([...endpoint, gate])).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The three fields a comparison reads; anything else on a record is carried along untouched. */
function isApprovalRecord(value: unknown): value is ApprovalRecord {
  return isRecord(value)
    && typeof value.projectRoot === 'string'
    && typeof value.serverName === 'string'
    && typeof value.definitionHash === 'string'
}

function readStore(path: string): ApprovalStore {
  if (!existsSync(path)) return { version: APPROVALS_VERSION, approvals: [] }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed) || parsed.version !== APPROVALS_VERSION || !Array.isArray(parsed.approvals)) return { version: APPROVALS_VERSION, approvals: [] }
    // Spread rather than rebuild: a key this adapter does not know about rides through a rewrite.
    return { ...parsed, version: APPROVALS_VERSION, approvals: parsed.approvals }
  } catch {
    // An unreadable store denies everything rather than trusting silently.
    return { version: APPROVALS_VERSION, approvals: [] }
  }
}

/** A record counts only when every field the comparison reads is a string. */
function matches(record: unknown, projectRoot: string, serverName: string, hash: string): boolean {
  return isApprovalRecord(record) && record.projectRoot === projectRoot && record.serverName === serverName && record.definitionHash === hash
}

function writeStore(path: string, store: ApprovalStore): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

export function isApproved(path: string, projectRoot: string, serverName: string, config: ServerConfig): boolean {
  const hash = definitionHash(config)
  return readStore(path).approvals.some((record) => matches(record, projectRoot, serverName, hash))
}

export function approve(path: string, projectRoot: string, serverName: string, config: ServerConfig): string {
  const store = readStore(path)
  const hash = definitionHash(config)
  // Compare the bare pair, as the source does: a same-pair record this adapter cannot parse must
  // still be replaced, or the file keeps a duplicate pair forever.
  store.approvals = store.approvals.filter((record) => !(isRecord(record) && record.projectRoot === projectRoot && record.serverName === serverName))
  store.approvals.push({ projectRoot, serverName, definitionHash: hash, approvedAt: new Date().toISOString() })
  writeStore(path, store)
  return hash
}

export function removeApproval(path: string, projectRoot: string, serverName: string): void {
  const store = readStore(path)
  const initialLen = store.approvals.length
  store.approvals = store.approvals.filter((record) => !(isRecord(record) && record.projectRoot === projectRoot && record.serverName === serverName))
  if (store.approvals.length !== initialLen) {
    writeStore(path, store)
  }
}

/**
 * Split the merged server map into what may start and what is held back.
 * @returns `{ mount, blocked }`, where blocked entries carry a reason the model can act on.
 */
export function partition({ servers, projectRoot, policy, approvalsFile }: PartitionInput): PartitionResult {
  const mount: PartitionEntry[] = []
  const blocked: BlockedServer[] = []
  for (const [name, entry] of servers) {
    if (isDisabledEntry(entry.config)) continue
    if (entry.origin !== 'project' || policy === 'allow') {
      mount.push(entry)
      continue
    }
    if (policy === 'deny') {
      blocked.push({ name, origin: entry.origin, reason: 'projectServers is deny' })
      continue
    }
    if (isApproved(approvalsFile, projectRoot, name, entry.config)) mount.push(entry)
    else blocked.push({ name, origin: entry.origin, reason: `${entry.path} is not approved — run /mcp-adapter approve ${name}` })
  }
  return { mount, blocked }
}
