import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/index.ts'
import { createMcpRouter, createMcpWebRoutes, ROUTES } from '../src/routes.ts'
import { McpServersService } from '../src/service.ts'

function createMockReq(options: {
  method?: string
  url?: string
  body?: unknown
  rawBody?: string
}): any {
  const bodyText = options.rawBody !== undefined
    ? options.rawBody
    : (options.body !== undefined ? JSON.stringify(options.body) : '')
  const req = Readable.from(bodyText ? [Buffer.from(bodyText)] : []) as any
  req.method = options.method ?? 'GET'
  req.url = options.url ?? '/'
  req.headers = { 'content-type': 'application/json' }
  return req
}

function createMockRes(): {
  res: any
  getStatusCode: () => number
  getBody: () => any
  getRawText: () => string
  getHeaders: () => Record<string, string>
} {
  let statusCode = 200
  const headers: Record<string, string> = {}
  const chunks: Buffer[] = []
  const res: any = {
    writeHead: vi.fn((status: number, h?: Record<string, string>) => {
      statusCode = status
      if (h) Object.assign(headers, h)
      return res
    }),
    end: vi.fn((data?: any) => {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
    }),
  }
  return {
    res,
    getStatusCode: () => statusCode,
    getBody: () => {
      const text = Buffer.concat(chunks).toString('utf-8')
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    },
    getRawText: () => Buffer.concat(chunks).toString('utf-8'),
    getHeaders: () => headers,
  }
}

describe('Mcp Routes & WebServer Registration', () => {
  describe('ROUTES Constant', () => {
    it('defines expected route endpoints matching DSH conventions', () => {
      expect(ROUTES.servers).toBe('api/dsh-mcp-adapter/servers')
      expect(ROUTES.save).toBe('api/dsh-mcp-adapter/save')
      expect(ROUTES.approve).toBe('api/dsh-mcp-adapter/approve')
      expect(ROUTES.delete).toBe('api/dsh-mcp-adapter/delete')
      expect(ROUTES.probe).toBe('api/dsh-mcp-adapter/probe')
    })
  })

  describe('createMcpWebRoutes - Route Definitions', () => {
    it('returns exact web routes matching DSH Host WebServer interface', () => {
      const mockService = {} as unknown as McpServersService
      const routes = createMcpWebRoutes(mockService)
      expect(routes).toHaveLength(12)
      for (const route of routes) {
        expect(route.kind).toBe('exact')
        expect(typeof route.handler).toBe('function')
        expect(route.path.startsWith('/')).toBe(true)
      }
      const paths = routes.map((r) => r.path)
      expect(paths).toContain('/api/dsh-mcp-adapter/servers')
      expect(paths).toContain('/api/dsh-mcp-adapter/save')
      expect(paths).toContain('/api/dsh-mcp-adapter/approve')
      expect(paths).toContain('/api/dsh-mcp-adapter/delete')
      expect(paths).toContain('/api/dsh-mcp-adapter/probe')
      expect(paths).toContain('/api/dsh-mcp-adapter/presets')
      expect(paths).toContain('/api/dsh-mcp-adapter/presets/install')
      expect(paths).toContain('/api/dsh-mcp-adapter/toggle')
      expect(paths).toContain('/api/dsh-mcp-adapter/migrate-scope')
      expect(paths).toContain('/api/dsh-mcp-adapter/scan-external')
      expect(paths).toContain('/api/dsh-mcp-adapter/import-external')
      expect(paths).toContain('/api/dsh-mcp-adapter/catalog')
    })
  })

  describe('WebRoute Handlers', () => {
    const findRoute = (routes: ReturnType<typeof createMcpWebRoutes>, path: string) => {
      const route = routes.find((r) => r.path === path)
      if (!route) throw new Error(`Route not found for path: ${path}`)
      return route
    }

    describe('GET /api/dsh-mcp-adapter/servers', () => {
      it('returns server list with 200 on success', async () => {
        const mockResult = {
          servers: [{ name: 'test-server', scope: 'user', category: 'custom', transport: 'stdio' }],
          workspaceRoot: '/path/to/project',
          workspaces: [{ path: '/path/to/project', title: 'project' }],
        }
        const service = {
          listServers: vi.fn().mockResolvedValue(mockResult),
        } as unknown as McpServersService

        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/servers')
        const req = createMockReq({ method: 'GET', url: '/api/dsh-mcp-adapter/servers?cwd=/custom/cwd&scope=user' })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(service.listServers).toHaveBeenCalledWith({ cwd: '/custom/cwd', scope: 'user' })
        expect(getStatusCode()).toBe(200)
        expect(getBody()).toEqual(mockResult)
      })

      it('handles all / omitted scope by forwarding undefined scope', async () => {
        const service = {
          listServers: vi.fn().mockResolvedValue({ servers: [], workspaceRoot: '/root', workspaces: [] }),
        } as unknown as McpServersService

        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/servers')
        const req = createMockReq({ method: 'GET', url: '/api/dsh-mcp-adapter/servers?scope=all' })
        const { res, getStatusCode } = createMockRes()

        await route.handler(req, res)
        expect(service.listServers).toHaveBeenCalledWith({ cwd: undefined, scope: undefined })
        expect(getStatusCode()).toBe(200)
      })

      it('rejects invalid scope with 400', async () => {
        const service = { listServers: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/servers')
        const req = createMockReq({ method: 'GET', url: '/api/dsh-mcp-adapter/servers?scope=invalid' })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(400)
        expect(getBody().error).toContain('scope')
      })

      it('rejects non-GET methods with 405 Method Not Allowed', async () => {
        const service = { listServers: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/servers')
        const req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/servers' })
        const { res, getStatusCode } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(405)
      })

      it('returns 500 when service throws', async () => {
        const service = {
          listServers: vi.fn().mockRejectedValue(new Error('disk failure')),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/servers')
        const req = createMockReq({ method: 'GET', url: '/api/dsh-mcp-adapter/servers' })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(500)
        expect(getBody().error).toContain('disk failure')
      })
    })

    describe('POST /api/dsh-mcp-adapter/save', () => {
      it('saves server configuration and returns 200 ok', async () => {
        const service = {
          saveServer: vi.fn().mockResolvedValue({ ok: true }),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/save')

        const payload = {
          scope: 'user',
          name: 'memory',
          cwd: '/path/cwd',
          server: { command: 'node', args: ['server.js'] },
        }
        const req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/save', body: payload })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(service.saveServer).toHaveBeenCalledWith({
          scope: 'user',
          name: 'memory',
          originalName: undefined,
          originalScope: undefined,
          cwd: '/path/cwd',
          server: { command: 'node', args: ['server.js'] },
        })
        expect(getStatusCode()).toBe(200)
        expect(getBody()).toEqual({ ok: true })
      })

      it('forwards originalName and originalScope when provided', async () => {
        const service = {
          saveServer: vi.fn().mockResolvedValue({ ok: true }),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/save')

        const payload = {
          scope: 'workspace',
          name: 'renamed',
          originalName: 'old-name',
          originalScope: 'user',
          server: { command: 'node' },
        }
        const req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/save', body: payload })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(service.saveServer).toHaveBeenCalledWith({
          scope: 'workspace',
          name: 'renamed',
          originalName: 'old-name',
          originalScope: 'user',
          cwd: undefined,
          server: { command: 'node' },
        })
        expect(getStatusCode()).toBe(200)
      })

      it('validates required fields (scope, name, server)', async () => {
        const service = { saveServer: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/save')

        // Bad scope
        let req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/save', body: { scope: 'other', name: 's1', server: {} } })
        let mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('scope')

        // Missing name
        req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/save', body: { scope: 'user', name: '', server: {} } })
        mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('name')

        // Non-object server
        req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/save', body: { scope: 'user', name: 's1', server: 'invalid' } })
        mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('server')
      })

      it('rejects non-POST methods with 405', async () => {
        const service = { saveServer: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/save')
        const req = createMockReq({ method: 'GET', url: '/api/dsh-mcp-adapter/save' })
        const { res, getStatusCode } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(405)
      })

      it('returns 500 when service throws', async () => {
        const service = {
          saveServer: vi.fn().mockRejectedValue(new Error('write failed')),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/save')
        const req = createMockReq({
          method: 'POST',
          url: '/api/dsh-mcp-adapter/save',
          body: { scope: 'user', name: 'demo', server: {} },
        })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(500)
        expect(getBody().error).toContain('write failed')
      })
    })

    describe('POST /api/dsh-mcp-adapter/approve', () => {
      it('approves server and returns 200 ok', async () => {
        const service = {
          approveServer: vi.fn().mockResolvedValue({ ok: true }),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/approve')

        const payload = { cwd: '/workspace/dir', name: 'trusted-srv' }
        const req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/approve', body: payload })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(service.approveServer).toHaveBeenCalledWith({ cwd: '/workspace/dir', name: 'trusted-srv' })
        expect(getStatusCode()).toBe(200)
        expect(getBody()).toEqual({ ok: true })
      })

      it('allows optional cwd (falling back to process.cwd()) and validates required name', async () => {
        const service = { approveServer: vi.fn().mockResolvedValue({ ok: true }) } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/approve')

        // Missing cwd: succeeds with process.cwd() fallback
        let req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/approve', body: { name: 's1' } })
        let mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(200)
        expect(service.approveServer).toHaveBeenCalledWith({ cwd: process.cwd(), name: 's1' })

        // Missing name: 400
        req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/approve', body: { cwd: '/ws' } })
        mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('name')
      })

      it('rejects non-POST methods with 405', async () => {
        const service = { approveServer: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/approve')
        const req = createMockReq({ method: 'GET', url: '/api/dsh-mcp-adapter/approve' })
        const { res, getStatusCode } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(405)
      })

      it('returns 500 when service throws', async () => {
        const service = {
          approveServer: vi.fn().mockRejectedValue(new Error('Server not found')),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/approve')
        const req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/approve', body: { cwd: '/ws', name: 'srv' } })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(500)
        expect(getBody().error).toContain('Server not found')
      })
    })

    describe('POST /api/dsh-mcp-adapter/delete', () => {
      it('deletes server and returns 200 ok', async () => {
        const service = {
          deleteServer: vi.fn().mockResolvedValue({ ok: true }),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/delete')

        const payload = { scope: 'workspace', cwd: '/workspace/dir', name: 'old-server' }
        const req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/delete', body: payload })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(service.deleteServer).toHaveBeenCalledWith({
          scope: 'workspace',
          cwd: '/workspace/dir',
          name: 'old-server',
        })
        expect(getStatusCode()).toBe(200)
        expect(getBody()).toEqual({ ok: true })
      })

      it('validates required fields (scope, name)', async () => {
        const service = { deleteServer: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/delete')

        // Bad scope
        let req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/delete', body: { scope: 'bad', name: 's1' } })
        let mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('scope')

        // Missing name
        req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/delete', body: { scope: 'user' } })
        mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('name')
      })

      it('rejects non-POST methods with 405', async () => {
        const service = { deleteServer: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/delete')
        const req = createMockReq({ method: 'DELETE', url: '/api/dsh-mcp-adapter/delete' })
        const { res, getStatusCode } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(405)
      })

      it('returns 500 when service throws', async () => {
        const service = {
          deleteServer: vi.fn().mockRejectedValue(new Error('deletion failed')),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/delete')
        const req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/delete', body: { scope: 'user', name: 's1' } })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(500)
        expect(getBody().error).toContain('deletion failed')
      })
    })

    describe('POST /api/dsh-mcp-adapter/probe', () => {
      it('probes server and returns probe result', async () => {
        const service = {
          probeServer: vi.fn().mockResolvedValue({ ok: true, latencyMs: 25 }),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/probe')

        // Wrapped in server object
        let req = createMockReq({
          method: 'POST',
          url: '/api/dsh-mcp-adapter/probe',
          body: { server: { command: 'node', args: ['-v'] } },
        })
        let mock = createMockRes()
        await route.handler(req, mock.res)
        expect(service.probeServer).toHaveBeenCalledWith({ command: 'node', args: ['-v'] })
        expect(mock.getStatusCode()).toBe(200)
        expect(mock.getBody()).toEqual({ ok: true, latencyMs: 25 })

        // Direct server payload
        req = createMockReq({
          method: 'POST',
          url: '/api/dsh-mcp-adapter/probe',
          body: { command: 'node', args: ['-v'] },
        })
        mock = createMockRes()
        await route.handler(req, mock.res)
        expect(service.probeServer).toHaveBeenCalledWith({ command: 'node', args: ['-v'] })
        expect(mock.getStatusCode()).toBe(200)
        expect(mock.getBody()).toEqual({ ok: true, latencyMs: 25 })
      })

      it('validates server configuration object', async () => {
        const service = { probeServer: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/probe')

        const req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/probe', body: {} })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(400)
        expect(getBody().ok).toBe(false)
      })

      it('returns 500 when service throws', async () => {
        const service = {
          probeServer: vi.fn().mockRejectedValue(new Error('probe crash')),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/probe')
        const req = createMockReq({
          method: 'POST',
          url: '/api/dsh-mcp-adapter/probe',
          body: { server: { command: 'fail' } },
        })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(500)
        expect(getBody().ok).toBe(false)
        expect(getBody().error).toContain('probe crash')
      })
    })

    describe('GET /api/dsh-mcp-adapter/presets', () => {
      it('returns list of curated presets', async () => {
        const service = {
          listPresets: vi.fn().mockReturnValue([{ id: 'github', name: 'GitHub' }]),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/presets')
        const req = createMockReq({ method: 'GET', url: '/api/dsh-mcp-adapter/presets' })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(200)
        expect(getBody()).toEqual({ presets: [{ id: 'github', name: 'GitHub' }] })
      })

      it('rejects non-GET with 405', async () => {
        const service = { listPresets: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/presets')
        const req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/presets' })
        const { res, getStatusCode } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(405)
      })
    })

    describe('POST /api/dsh-mcp-adapter/presets/install', () => {
      it('installs preset with valid parameters', async () => {
        const service = {
          installPreset: vi.fn().mockResolvedValue({ ok: true, serverName: 'GitHub' }),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/presets/install')
        const req = createMockReq({
          method: 'POST',
          url: '/api/dsh-mcp-adapter/presets/install',
          body: { presetId: 'github', scope: 'workspace' },
        })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(200)
        expect(getBody()).toEqual({ ok: true, serverName: 'GitHub' })
      })

      it('validates missing presetId or invalid scope', async () => {
        const service = { installPreset: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/presets/install')

        let req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/presets/install', body: { scope: 'workspace' } })
        let mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('presetId')

        req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/presets/install', body: { presetId: 'github', scope: 'invalid' } })
        mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('scope')
      })
    })

    describe('POST /api/dsh-mcp-adapter/toggle', () => {
      it('toggles server status and returns 200 ok', async () => {
        const service = {
          toggleServer: vi.fn().mockResolvedValue({ ok: true, enabled: false }),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/toggle')
        const req = createMockReq({
          method: 'POST',
          url: '/api/dsh-mcp-adapter/toggle',
          body: { name: 'tavily', scope: 'user', enabled: false },
        })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(service.toggleServer).toHaveBeenCalledWith({ name: 'tavily', scope: 'user', cwd: undefined, enabled: false })
        expect(getStatusCode()).toBe(200)
        expect(getBody()).toEqual({ ok: true, enabled: false })
      })

      it('validates required fields (name, scope, enabled)', async () => {
        const service = { toggleServer: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/toggle')

        let req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/toggle', body: { scope: 'user', enabled: true } })
        let mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('name')

        req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/toggle', body: { name: 's1', scope: 'invalid', enabled: true } })
        mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('scope')

        req = createMockReq({ method: 'POST', url: '/api/dsh-mcp-adapter/toggle', body: { name: 's1', scope: 'user', enabled: 'not-bool' } })
        mock = createMockRes()
        await route.handler(req, mock.res)
        expect(mock.getStatusCode()).toBe(400)
        expect(mock.getBody().error).toContain('boolean')
      })
    })

    describe('GET /api/dsh-mcp-adapter/scan-external', () => {
      it('scans external MCP sources and returns 200 ok', async () => {
        const mockScanResult = {
          candidates: [{ source: 'claude-desktop', sourcePath: '/path', id: 'fs', rawKey: 'fs', transport: 'stdio' }],
          sources: [{ kind: 'claude-desktop', path: '/path', exists: true, count: 1 }],
        }
        const service = {
          scanExternal: vi.fn().mockReturnValue(mockScanResult),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/scan-external')
        const req = createMockReq({ method: 'GET', url: '/api/dsh-mcp-adapter/scan-external?cwd=/workspace' })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(service.scanExternal).toHaveBeenCalledWith({ cwd: '/workspace' })
        expect(getStatusCode()).toBe(200)
        expect(getBody()).toEqual(mockScanResult)
      })
    })

    describe('POST /api/dsh-mcp-adapter/import-external', () => {
      it('batch imports external candidates and returns 200 ok', async () => {
        const service = {
          importExternal: vi.fn().mockResolvedValue({ ok: true, importedCount: 2, errors: [] }),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/import-external')
        const req = createMockReq({
          method: 'POST',
          url: '/api/dsh-mcp-adapter/import-external',
          body: {
            items: [
              { source: 'cursor-global', sourcePath: '/p1', id: 's1', rawKey: 's1', transport: 'stdio' },
              { source: 'cursor-global', sourcePath: '/p2', id: 's2', rawKey: 's2', transport: 'http' },
            ],
            scope: 'workspace',
          },
        })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(service.importExternal).toHaveBeenCalledWith({
          items: expect.any(Array),
          scope: 'workspace',
          cwd: undefined,
        })
        expect(getStatusCode()).toBe(200)
        expect(getBody()).toEqual({ ok: true, importedCount: 2, errors: [] })
      })
    })

    describe('GET /api/dsh-mcp-adapter/catalog', () => {
      it('returns curated catalog and returns 200 ok', async () => {
        const service = {
          listCatalog: vi.fn().mockReturnValue([{ id: 'memory', name: 'Memory' }]),
        } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/catalog')
        const req = createMockReq({ method: 'GET', url: '/api/dsh-mcp-adapter/catalog' })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(service.listCatalog).toHaveBeenCalled()
        expect(getStatusCode()).toBe(200)
        expect(getBody()).toEqual({ catalog: [{ id: 'memory', name: 'Memory' }] })
      })
    })

    describe('Malformed JSON Handling', () => {
      it('returns 400 when body cannot be parsed as JSON', async () => {
        const service = { saveServer: vi.fn() } as unknown as McpServersService
        const route = findRoute(createMcpWebRoutes(service), '/api/dsh-mcp-adapter/save')
        const req = createMockReq({
          method: 'POST',
          url: '/api/dsh-mcp-adapter/save',
          rawBody: '{ bad json here',
        })
        const { res, getStatusCode, getBody } = createMockRes()

        await route.handler(req, res)
        expect(getStatusCode()).toBe(400)
        expect(getBody().error).toContain('JSON')
      })
    })
  })

  describe('createMcpRouter (Koa-compatible router)', () => {
    it('registers expected endpoints with document-relative paths', async () => {
      const routeMap = new Map<string, (ctx: any) => Promise<void>>()
      const mockRouter = {
        get: (p: string, handler: any) => routeMap.set(`GET ${p}`, handler),
        post: (p: string, handler: any) => routeMap.set(`POST ${p}`, handler),
      }

      const mockService = {
        listServers: vi.fn().mockResolvedValue({ servers: [], workspaceRoot: '/ws', workspaces: [] }),
        saveServer: vi.fn().mockResolvedValue({ ok: true }),
        approveServer: vi.fn().mockResolvedValue({ ok: true }),
        deleteServer: vi.fn().mockResolvedValue({ ok: true }),
        probeServer: vi.fn().mockResolvedValue({ ok: true, latencyMs: 10 }),
      } as unknown as McpServersService

      createMcpRouter(mockRouter as any, mockService)

      expect(Array.from(routeMap.keys())).toEqual(
        expect.arrayContaining([
          'GET api/dsh-mcp-adapter/servers',
          'POST api/dsh-mcp-adapter/save',
          'POST api/dsh-mcp-adapter/approve',
          'POST api/dsh-mcp-adapter/delete',
          'POST api/dsh-mcp-adapter/probe',
        ]),
      )

      // Test GET servers dispatch
      const getHandler = routeMap.get('GET api/dsh-mcp-adapter/servers')!
      const getCtx: any = { query: { cwd: '/test' } }
      await getHandler(getCtx)
      expect(getCtx.status).toBe(200)
      expect(getCtx.body.workspaceRoot).toBe('/ws')

      // Test POST save dispatch
      const saveHandler = routeMap.get('POST api/dsh-mcp-adapter/save')!
      const saveCtx: any = { request: { body: { scope: 'user', name: 'srv', server: { command: 'node' } } } }
      await saveHandler(saveCtx)
      expect(saveCtx.status).toBe(200)
      expect(saveCtx.body).toEqual({ ok: true })

      // Test POST approve dispatch
      const approveHandler = routeMap.get('POST api/dsh-mcp-adapter/approve')!
      const approveCtx: any = { request: { body: { cwd: '/test', name: 'srv' } } }
      await approveHandler(approveCtx)
      expect(approveCtx.status).toBe(200)
      expect(approveCtx.body).toEqual({ ok: true })

      // Test POST delete dispatch
      const deleteHandler = routeMap.get('POST api/dsh-mcp-adapter/delete')!
      const deleteCtx: any = { request: { body: { scope: 'workspace', cwd: '/test', name: 'srv' } } }
      await deleteHandler(deleteCtx)
      expect(deleteCtx.status).toBe(200)
      expect(deleteCtx.body).toEqual({ ok: true })

      // Test POST probe dispatch
      const probeHandler = routeMap.get('POST api/dsh-mcp-adapter/probe')!
      const probeCtx: any = { request: { body: { command: 'node' } } }
      await probeHandler(probeCtx)
      expect(probeCtx.status).toBe(200)
      expect(probeCtx.body).toEqual({ ok: true, latencyMs: 10 })
    })
  })

  describe('Cordis Plugin Lifecycle in src/index.ts', () => {
    it('declares webServer in inject list', () => {
      expect(name).toBe('mcp-adapter')
      expect(inject).toContain('webServer')
    })

    it('registers web routes when webServer is present on ctx', () => {
      const registeredRoutes: any[] = []
      const dummyWebServer = {
        register: vi.fn((route: any) => {
          registeredRoutes.push(route)
          return () => {}
        }),
      }

      const mockContext: any = {
        effect: (fn: () => unknown) => fn(),
        webServer: dummyWebServer,
        get: vi.fn((key: string) => (key === 'webServer' ? dummyWebServer : undefined)),
        systemPrompt: { context: vi.fn() },
        commands: { register: vi.fn() },
        on: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }

      apply(mockContext, { enabled: true })

      expect(registeredRoutes.length).toBe(12)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/servers')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/save')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/approve')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/delete')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/probe')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/presets')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/presets/install')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/toggle')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/migrate-scope')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/scan-external')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/import-external')).toBe(true)
      expect(registeredRoutes.some((r) => r.path === '/api/dsh-mcp-adapter/catalog')).toBe(true)
    })

    it('activates on a Cordis context that throws on undeclared property reads', () => {
      // The real Cordis context is a Proxy: reading a property that is not a declared service
      // throws instead of returning undefined. A plain object mock cannot catch that, and the
      // plugin crashed on activation when it read `ctx.router` (a service DSH does not have).
      const services = new Map<string, unknown>()
      const target: Record<string, unknown> = {
        get: (key: string, required = true) => {
          const value = services.get(key)
          if (value === undefined && required) throw new Error(`cannot get property "${key}" without inject`)
          return value
        },
        effect: (fn: () => unknown) => fn(),
        systemPrompt: { context: vi.fn() },
        commands: { register: vi.fn() },
        on: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }
      const declared = new Set(['get', 'effect', 'systemPrompt', 'commands', 'on', 'logger'])
      const proxy = new Proxy(target, {
        get(t, prop) {
          if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop)
          if (declared.has(prop)) return Reflect.get(t, prop)
          throw new Error(`cannot get property "${String(prop)}" without inject`)
        },
      })
      services.set('webServer', {
        register: vi.fn(() => () => {}),
      })

      expect(() => apply(proxy as never, { enabled: true })).not.toThrow()
    })
  })
})
