import type { McpServerDetail, Scope } from '../types.ts'

export interface ServerDraft {
  name: string
  scope: 'user' | 'workspace'
  transport: 'stdio' | 'http' | 'sse' | 'websocket'
  command: string
  args: string
  url?: string
  headers?: Array<{ key: string; value: string }>
  timeoutMs: number
  protocolVersion: string
  env: Array<{ key: string; value: string }>
  rawJson?: string
}

export interface ControllerState {
  scope: 'user' | 'workspace'
  /** The workspace whose `.mcp.json` this panel manages; `undefined` means the active project root. */
  workspacePath?: string
  searchQuery: string
  viewMode: 'list' | 'editor'
  editorMode: 'form' | 'json'
  editingServer: McpServerDetail | null
  draft: ServerDraft
  jsonError: string | null
  panelOpen?: boolean
}

export function parseArgsString(str: string): string[] {
  if (!str || !str.trim()) return []
  const matches = str.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g)
  if (!matches) return []
  return matches.map((m) => {
    if ((m.startsWith('"') && m.endsWith('"')) || (m.startsWith("'") && m.endsWith("'"))) {
      return m.slice(1, -1).replace(/\\(["'])/g, '$1')
    }
    return m
  })
}

function formatArgsArray(args: unknown[]): string {
  return args
    .map((a) => {
      const str = String(a)
      return str.includes(' ') && !str.startsWith('"') && !str.startsWith("'") ? `"${str}"` : str
    })
    .join(' ')
}

function defaultDraft(scope: Scope = 'user'): ServerDraft {
  return {
    name: '',
    scope,
    transport: 'stdio',
    command: '',
    args: '',
    url: '',
    headers: [],
    timeoutMs: 30000,
    protocolVersion: '',
    env: [],
    rawJson: '',
  }
}

export class McpPanelController {
  private state: ControllerState
  private snapshot: ControllerState
  private readonly listeners = new Set<() => void>()

  constructor(initialState?: Partial<ControllerState>) {
    const scope = initialState?.scope ?? 'user'
    this.state = {
      scope,
      searchQuery: '',
      viewMode: 'list',
      editorMode: 'form',
      editingServer: null,
      draft: defaultDraft(scope),
      jsonError: null,
      ...initialState,
    }
    this.snapshot = this.cloneState()
  }

  private cloneState(): ControllerState {
    return {
      ...this.state,
      draft: {
        ...this.state.draft,
        env: this.state.draft.env.map((e) => ({ ...e })),
        headers: this.state.draft.headers ? this.state.draft.headers.map((h) => ({ ...h })) : undefined,
      },
    }
  }

  private commit(): void {
    this.snapshot = this.cloneState()
    for (const listener of this.listeners) {
      listener()
    }
  }

  getSnapshot(): ControllerState {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setScope(scope: 'user' | 'workspace'): void {
    if (this.state.scope === scope) return
    this.state.scope = scope
    this.commit()
  }

  /** Select the workspace whose `.mcp.json` the panel manages (and switch to that scope). */
  setWorkspacePath(path: string | undefined): void {
    const next = path && path.trim() !== '' ? path : undefined
    if (this.state.workspacePath === next && this.state.scope === 'workspace') return
    this.state.workspacePath = next
    this.state.scope = 'workspace'
    this.commit()
  }

  setSearchQuery(q: string): void {
    if (this.state.searchQuery === q) return
    this.state.searchQuery = q
    this.commit()
  }

  syncPanelSelection(panelId: string | null): void {
    const isMcp = panelId === 'mcp-servers'
    if (this.state.panelOpen === isMcp) return
    this.state.panelOpen = isMcp
    this.commit()
  }

  openCreate(scope?: 'user' | 'workspace'): void {
    const targetScope = scope ?? this.state.scope
    this.state.viewMode = 'editor'
    this.state.editorMode = 'form'
    this.state.editingServer = null
    this.state.jsonError = null
    this.state.draft = defaultDraft(targetScope)
    this.syncDraftToJson()
  }

  openEdit(server: McpServerDetail): void {
    this.state.viewMode = 'editor'
    this.state.editorMode = 'form'
    this.state.editingServer = server
    this.state.jsonError = null
    this.state.draft = {
      name: server.name,
      scope: server.scope,
      transport: server.transport === 'http' ? 'http' : (server.transport as any) ?? 'stdio',
      command: server.command ?? '',
      args: Array.isArray(server.args) ? formatArgsArray(server.args) : '',
      url: server.url ?? '',
      headers: [],
      timeoutMs: server.timeoutMs ?? 30000,
      protocolVersion: server.protocolVersion ?? '',
      env: server.env
        ? Object.entries(server.env).map(([key, value]) => ({ key, value }))
        : [],
      rawJson: '',
    }
    this.syncDraftToJson()
  }

  closeEditor(): void {
    this.state.viewMode = 'list'
    this.state.editingServer = null
    this.state.jsonError = null
    this.commit()
  }

  setEditorMode(mode: 'form' | 'json'): boolean {
    if (this.state.editorMode === mode) return true
    if (mode === 'json') {
      this.syncDraftToJson()
      this.state.editorMode = mode
      this.commit()
      return true
    } else {
      const res = this.syncJsonToDraft()
      if (!res.ok) {
        return false
      }
      this.state.editorMode = mode
      this.commit()
      return true
    }
  }

  updateDraft(updater: (draft: ServerDraft) => Partial<ServerDraft>): void {
    const patch = updater(this.state.draft)
    Object.assign(this.state.draft, patch)
    this.commit()
  }

  syncDraftToJson(): void {
    const d = this.state.draft
    const config: Record<string, unknown> = {}

    if (d.transport === 'stdio') {
      if (d.command) config.command = d.command
      const argsArr = parseArgsString(d.args)
      if (argsArr.length > 0) config.args = argsArr
    } else {
      // `transport` is not a field this adapter reads for an HTTP server: the transport is derived
      // from the presence of `url`, and the SSE-versus-streamable choice is `httpTransport`. Writing
      // the old spelling produced a key nothing consumed, so the panel now emits the real one.
      if (d.transport === 'sse') config.httpTransport = 'sse'
      if (d.url) config.url = d.url
      if (d.headers && d.headers.length > 0) {
        const headersRecord: Record<string, string> = {}
        for (const h of d.headers) {
          if (h.key && h.key.trim()) {
            headersRecord[h.key.trim()] = h.value
          }
        }
        if (Object.keys(headersRecord).length > 0) config.headers = headersRecord
      }
    }

    if (d.env && d.env.length > 0) {
      const envRecord: Record<string, string> = {}
      for (const e of d.env) {
        if (e.key && e.key.trim()) {
          envRecord[e.key.trim()] = e.value
        }
      }
      if (Object.keys(envRecord).length > 0) config.env = envRecord
    }

    // The canonical spelling. `timeoutMs` is still accepted when read, but writing only the
    // canonical key is what keeps a saved file from drifting away from what the normalizer consumes.
    if (typeof d.timeoutMs === 'number' && d.timeoutMs > 0 && d.timeoutMs !== 30000) {
      config.requestTimeoutMs = d.timeoutMs
    }
    if (d.protocolVersion && d.protocolVersion.trim()) {
      config.protocolVersion = d.protocolVersion.trim()
    }

    d.rawJson = JSON.stringify(config, null, 2)
    this.commit()
  }

  syncJsonToDraft(): { ok: boolean; error?: string } {
    const d = this.state.draft
    if (!d.rawJson || !d.rawJson.trim()) {
      this.state.jsonError = null
      this.commit()
      return { ok: true }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(d.rawJson)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.state.jsonError = msg
      this.commit()
      return { ok: false, error: msg }
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const msg = 'Server configuration must be a JSON object'
      this.state.jsonError = msg
      this.commit()
      return { ok: false, error: msg }
    }

    const record = parsed as Record<string, unknown>
    let serverName = d.name
    let targetConfig: Record<string, unknown> = record

    if (record.mcpServers && typeof record.mcpServers === 'object' && !Array.isArray(record.mcpServers)) {
      const serversMap = record.mcpServers as Record<string, unknown>
      const keys = Object.keys(serversMap)
      if (keys.length > 0) {
        const matchKey = d.name && serversMap[d.name] ? d.name : keys[0]
        serverName = matchKey
        if (typeof serversMap[matchKey] === 'object' && serversMap[matchKey] !== null && !Array.isArray(serversMap[matchKey])) {
          targetConfig = serversMap[matchKey] as Record<string, unknown>
        }
      }
    } else if (record.servers && typeof record.servers === 'object' && !Array.isArray(record.servers)) {
      const serversMap = record.servers as Record<string, unknown>
      const keys = Object.keys(serversMap)
      if (keys.length > 0) {
        const matchKey = d.name && serversMap[d.name] ? d.name : keys[0]
        serverName = matchKey
        if (typeof serversMap[matchKey] === 'object' && serversMap[matchKey] !== null && !Array.isArray(serversMap[matchKey])) {
          targetConfig = serversMap[matchKey] as Record<string, unknown>
        }
      }
    } else {
      const keys = Object.keys(record)
      if (keys.length === 1 && !('command' in record) && !('url' in record) && !('transport' in record)) {
        const singleKey = keys[0]
        const val = record[singleKey]
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          serverName = singleKey
          targetConfig = val as Record<string, unknown>
        }
      }
    }

    d.name = serverName || (typeof targetConfig.name === 'string' ? targetConfig.name : d.name)

    // Reset default values first so deleted JSON fields don't ghost into next draft!
    d.command = ''
    d.args = ''
    d.url = ''
    d.env = []
    d.headers = []
    d.timeoutMs = 30000
    d.protocolVersion = ''

    if (typeof targetConfig.command === 'string') {
      d.command = targetConfig.command
    } else if (Array.isArray(targetConfig.command) && targetConfig.command.length > 0) {
      d.command = String(targetConfig.command[0])
      if (!targetConfig.args) {
        d.args = formatArgsArray(targetConfig.command.slice(1))
      }
    }

    if (Array.isArray(targetConfig.args)) {
      d.args = formatArgsArray(targetConfig.args)
    } else if (typeof targetConfig.args === 'string') {
      d.args = targetConfig.args
    }

    if (targetConfig.url) {
      d.url = String(targetConfig.url)
    }

    if (typeof targetConfig.transport === 'string' && ['stdio', 'http', 'sse', 'websocket'].includes(targetConfig.transport)) {
      d.transport = targetConfig.transport as 'stdio' | 'http' | 'sse' | 'websocket'
    } else if (targetConfig.url) {
      d.transport = 'http'
    } else {
      d.transport = 'stdio'
    }

    if (targetConfig.env && typeof targetConfig.env === 'object' && !Array.isArray(targetConfig.env)) {
      d.env = Object.entries(targetConfig.env as Record<string, unknown>).map(([k, v]) => ({
        key: k,
        value: String(v),
      }))
    }

    if (targetConfig.headers && typeof targetConfig.headers === 'object' && !Array.isArray(targetConfig.headers)) {
      d.headers = Object.entries(targetConfig.headers as Record<string, unknown>).map(([k, v]) => ({
        key: k,
        value: String(v),
      }))
    }

    if (typeof targetConfig.timeoutMs === 'number') {
      d.timeoutMs = targetConfig.timeoutMs
    } else if (typeof targetConfig.requestTimeoutMs === 'number') {
      d.timeoutMs = targetConfig.requestTimeoutMs
    }

    if (typeof targetConfig.protocolVersion === 'string') {
      d.protocolVersion = targetConfig.protocolVersion
    }

    this.state.jsonError = null
    this.commit()
    return { ok: true }
  }
}
