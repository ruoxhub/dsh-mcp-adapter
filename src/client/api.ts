import type {
  ExternalMcpCandidate,
  ExternalMcpScanResult,
  McpCatalogEntry,
  McpServerDetail,
  ProbeResult,
} from '../types.ts'

export const API_ROUTES = {
  servers: 'api/dsh-mcp-adapter/servers',
  save: 'api/dsh-mcp-adapter/save',
  approve: 'api/dsh-mcp-adapter/approve',
  delete: 'api/dsh-mcp-adapter/delete',
  probe: 'api/dsh-mcp-adapter/probe',
  presets: 'api/dsh-mcp-adapter/presets',
  installPreset: 'api/dsh-mcp-adapter/presets/install',
  toggle: 'api/dsh-mcp-adapter/toggle',
  migrateScope: 'api/dsh-mcp-adapter/migrate-scope',
  scanExternal: 'api/dsh-mcp-adapter/scan-external',
  importExternal: 'api/dsh-mcp-adapter/import-external',
  catalog: 'api/dsh-mcp-adapter/catalog',
} as const

export class ApiError extends Error {}

export class McpServersApiClient {
  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(url, init)
    if (!res.ok) {
      let errorMessage: string | undefined
      try {
        const body = (await res.json()) as Record<string, unknown>
        if (body && typeof body === 'object') {
          if (typeof body.error === 'string') errorMessage = body.error
          else if (typeof body.message === 'string') errorMessage = body.message
        }
      } catch {
        // Fall back to HTTP status text
      }
      throw new ApiError(errorMessage || `Request failed with status ${res.status}: ${res.statusText}`)
    }
    return (await res.json()) as T
  }

  async getServers(params?: { cwd?: string; scope?: string }): Promise<{ servers: McpServerDetail[]; workspaceRoot: string; workspaces?: Array<{ path: string; title: string }> }> {
    const query = new URLSearchParams()
    if (params?.cwd) query.set('cwd', params.cwd)
    if (params?.scope) query.set('scope', params.scope)
    const queryString = query.toString()
    const url = queryString ? `${API_ROUTES.servers}?${queryString}` : API_ROUTES.servers
    return this.request<{ servers: McpServerDetail[]; workspaceRoot: string }>(url, { method: 'GET' })
  }

  async saveServer(payload: {
    scope: string
    cwd?: string
    name: string
    originalName?: string
    originalScope?: string
    server: Record<string, unknown>
  }): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(API_ROUTES.save, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  async approveServer(payload: { cwd?: string; name: string }): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(API_ROUTES.approve, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  async deleteServer(payload: { scope: string; cwd?: string; name: string }): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(API_ROUTES.delete, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  async probeServer(server: Record<string, unknown>): Promise<ProbeResult> {
    return this.request<ProbeResult>(API_ROUTES.probe, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server }),
    })
  }

  async getPresets(): Promise<{ presets: Array<{ id: string; name: string; summary: string; category: string; entry: Record<string, unknown>; requiredEnv?: string[] }> }> {
    return this.request(API_ROUTES.presets, { method: 'GET' })
  }

  async installPreset(payload: { presetId: string; scope: string; cwd?: string; envOverrides?: Record<string, string> }): Promise<{ ok: boolean; path: string; serverName: string }> {
    return this.request(API_ROUTES.installPreset, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  async toggleServer(payload: {
    name: string
    scope: string
    cwd?: string
    enabled: boolean
  }): Promise<{ ok: boolean; enabled: boolean }> {
    return this.request<{ ok: boolean; enabled: boolean }>(API_ROUTES.toggle, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  async migrateScope(payload: {
    name: string
    fromScope: string
    toScope: string
    cwd?: string
  }): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(API_ROUTES.migrateScope, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  async scanExternal(params?: { cwd?: string }): Promise<ExternalMcpScanResult> {
    const query = new URLSearchParams()
    if (params?.cwd) query.set('cwd', params.cwd)
    const queryString = query.toString()
    const url = queryString ? `${API_ROUTES.scanExternal}?${queryString}` : API_ROUTES.scanExternal
    return this.request<ExternalMcpScanResult>(url, { method: 'GET' })
  }

  async importExternal(payload: {
    items: ExternalMcpCandidate[]
    scope: string
    cwd?: string
  }): Promise<{ ok: boolean; importedCount: number; errors: string[] }> {
    return this.request<{ ok: boolean; importedCount: number; errors: string[] }>(API_ROUTES.importExternal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  async getCatalog(): Promise<{ catalog: McpCatalogEntry[] }> {
    return this.request<{ catalog: McpCatalogEntry[] }>(API_ROUTES.catalog, { method: 'GET' })
  }
}
