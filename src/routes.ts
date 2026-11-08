import type { IncomingMessage, ServerResponse } from 'node:http'
import { isTrustedPanelRequest, type ListenerFacts } from './request-trust.ts'
import type { McpServersService } from './service.ts'
import type { ExternalMcpCandidate, Scope } from './types.ts'

export const ROUTES = {
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

export interface RouterLike {
  get(path: string, ...handlers: any[]): any
  post(path: string, ...handlers: any[]): any
}

export interface McpWebRoute {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

interface HttpError extends Error {
  statusCode?: number
}

const DEFAULT_MAX_BODY_BYTES = 512 * 1024

async function readJsonBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    totalBytes += buf.length
    if (totalBytes > maxBytes) {
      const error: HttpError = new Error(`Request payload exceeds maximum allowed size of ${maxBytes} bytes`)
      error.statusCode = 413
      throw error
    }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  if (!text || text.trim().length === 0) return null
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch (err: unknown) {
    const error: HttpError = new Error(`Malformed JSON body: ${err instanceof Error ? err.message : String(err)}`)
    error.statusCode = 400
    throw error
  }
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The panel's REST surface.
 *
 * Every route is wrapped in the browser-trust fence before it runs: these routes write config files
 * and start processes, and DSH's own /api fence sits on the RPC bridge rather than on the web
 * server, so a route registered here would otherwise answer any page that can reach the port.
 * @param service - the backend these routes call.
 * @param listener - the listener facts `ctx.webServer` exposes; the fence needs them.
 * @returns one exact-path route per panel operation.
 */
export function createMcpWebRoutes(service: McpServersService, listener: ListenerFacts = {}): McpWebRoute[] {
  const routes: McpWebRoute[] = [
    {
      kind: 'exact',
      path: `/${ROUTES.servers}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const cwd = url.searchParams.get('cwd')?.trim() || undefined
          const scopeParam = url.searchParams.get('scope')?.trim()
          if (scopeParam && !['user', 'workspace', 'all'].includes(scopeParam)) {
            writeJson(res, 400, { error: 'Query parameter "scope" must be "user", "workspace", or "all"' })
            return
          }
          const scope = (scopeParam === 'user' || scopeParam === 'workspace') ? scopeParam : undefined
          const result = await service.listServers({ cwd, scope })
          writeJson(res, 200, result)
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to list MCP servers' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.save}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const body = (await readJsonBody(req)) ?? {}
          const { scope, cwd, name, originalName, originalScope, server } = body
          if (scope !== 'user' && scope !== 'workspace') {
            writeJson(res, 400, { error: 'Field "scope" must be "user" or "workspace"' })
            return
          }
          if (originalScope !== undefined && originalScope !== 'user' && originalScope !== 'workspace') {
            writeJson(res, 400, { error: 'Field "originalScope" must be "user" or "workspace"' })
            return
          }
          if (!name || typeof name !== 'string' || name.trim().length === 0) {
            writeJson(res, 400, { error: 'Field "name" is required' })
            return
          }
          if (originalName !== undefined && (typeof originalName !== 'string' || originalName.trim().length === 0)) {
            writeJson(res, 400, { error: 'Field "originalName" must be a non-empty string' })
            return
          }
          if (!isPlainObject(server)) {
            writeJson(res, 400, { error: 'Field "server" must be an object' })
            return
          }
          await service.saveServer({
            scope: scope as Scope,
            name: name.trim(),
            originalName: typeof originalName === 'string' ? originalName.trim() : undefined,
            originalScope: originalScope as Scope | undefined,
            server,
            cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
          })
          writeJson(res, 200, { ok: true })
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to save MCP server' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.approve}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const body = (await readJsonBody(req)) ?? {}
          const { cwd, name } = body
          if (!name || typeof name !== 'string' || name.trim().length === 0) {
            writeJson(res, 400, { error: 'Field "name" is required' })
            return
          }
          // No `process.cwd()` fallback: the service refuses a workspace write that names no
          // workspace, because the host's launch directory is not one this panel may modify.
          const effectiveCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined
          await service.approveServer({ cwd: effectiveCwd, name: name.trim() })
          writeJson(res, 200, { ok: true })
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to approve MCP server' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.delete}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const body = (await readJsonBody(req)) ?? {}
          const { scope, cwd, name } = body
          if (scope !== 'user' && scope !== 'workspace') {
            writeJson(res, 400, { error: 'Field "scope" must be "user" or "workspace"' })
            return
          }
          if (!name || typeof name !== 'string' || name.trim().length === 0) {
            writeJson(res, 400, { error: 'Field "name" is required' })
            return
          }
          await service.deleteServer({
            scope: scope as Scope,
            name: name.trim(),
            cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
          })
          writeJson(res, 200, { ok: true })
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to delete MCP server' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.probe}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const body = (await readJsonBody(req)) ?? {}
          const target = isPlainObject(body.server) ? body.server : body
          if (!isPlainObject(target) || Object.keys(target).length === 0) {
            writeJson(res, 400, { ok: false, error: 'Field "server" must be an object' })
            return
          }
          const result = await service.probeServer(target)
          writeJson(res, 200, result)
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { ok: false, error: messageOf(err) || 'Failed to probe MCP server' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.presets}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const presets = service.listPresets()
          writeJson(res, 200, { presets })
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to list presets' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.installPreset}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const body = (await readJsonBody(req)) ?? {}
          const { presetId, scope, cwd, envOverrides } = body
          if (!presetId || typeof presetId !== 'string' || presetId.trim().length === 0) {
            writeJson(res, 400, { error: 'Field "presetId" is required' })
            return
          }
          if (scope !== 'user' && scope !== 'workspace') {
            writeJson(res, 400, { error: 'Field "scope" must be "user" or "workspace"' })
            return
          }
          const result = await service.installPreset({
            presetId: presetId.trim(),
            scope: scope as Scope,
            cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
            envOverrides: isPlainObject(envOverrides) ? (envOverrides as Record<string, string>) : undefined,
          })
          writeJson(res, 200, result)
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to install preset' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.toggle}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const body = (await readJsonBody(req)) ?? {}
          const { name, scope, cwd, enabled } = body
          if (!name || typeof name !== 'string' || name.trim().length === 0) {
            writeJson(res, 400, { error: 'Field "name" is required' })
            return
          }
          if (scope !== 'user' && scope !== 'workspace') {
            writeJson(res, 400, { error: 'Field "scope" must be "user" or "workspace"' })
            return
          }
          if (typeof enabled !== 'boolean') {
            writeJson(res, 400, { error: 'Field "enabled" must be a boolean' })
            return
          }
          const result = await service.toggleServer({
            name: name.trim(),
            scope: scope as Scope,
            cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
            enabled,
          })
          writeJson(res, 200, result)
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to toggle server' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.migrateScope}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const body = (await readJsonBody(req)) ?? {}
          const { name, fromScope, toScope, cwd } = body
          if (!name || typeof name !== 'string' || name.trim().length === 0) {
            writeJson(res, 400, { error: 'Field "name" is required' })
            return
          }
          if ((fromScope !== 'user' && fromScope !== 'workspace') || (toScope !== 'user' && toScope !== 'workspace')) {
            writeJson(res, 400, { error: 'Fields "fromScope" and "toScope" must be "user" or "workspace"' })
            return
          }
          const result = await service.migrateScope({
            name: name.trim(),
            fromScope: fromScope as Scope,
            toScope: toScope as Scope,
            cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
          })
          writeJson(res, 200, result)
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to migrate server scope' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.scanExternal}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const cwd = url.searchParams.get('cwd')?.trim() || undefined
          const result = service.scanExternal({ cwd })
          writeJson(res, 200, result)
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to scan external MCP configurations' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.importExternal}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const body = (await readJsonBody(req)) ?? {}
          const { items, scope, cwd } = body
          if (!Array.isArray(items)) {
            writeJson(res, 400, { error: 'Field "items" must be an array' })
            return
          }
          if (scope !== 'user' && scope !== 'workspace') {
            writeJson(res, 400, { error: 'Field "scope" must be "user" or "workspace"' })
            return
          }
          const result = await service.importExternal({
            items: items as ExternalMcpCandidate[],
            scope: scope as Scope,
            cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
          })
          writeJson(res, 200, result)
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to import external MCP configurations' })
        }
      },
    },
    {
      kind: 'exact',
      path: `/${ROUTES.catalog}`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          res.writeHead(405)
          res.end('Method Not Allowed')
          return
        }
        try {
          const result = service.listCatalog()
          writeJson(res, 200, { catalog: result })
        } catch (err: unknown) {
          const status = (err as HttpError)?.statusCode ?? 500
          writeJson(res, status, { error: messageOf(err) || 'Failed to list MCP catalog' })
        }
      },
    },
  ]
  return routes.map((route) => ({
    ...route,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedPanelRequest(req, listener)) {
        writeJson(res, 403, { error: 'Refused: this request did not come from this Harness GUI' })
        return
      }
      return route.handler(req, res)
    },
  }))
}

export function createMcpRouter(router: RouterLike, service: McpServersService): void {
  // GET api/dsh-mcp-adapter/servers
  router.get(ROUTES.servers, async (ctx: any) => {
    try {
      const query = ctx.query ?? ctx.request?.query ?? {}
      const cwd = typeof query.cwd === 'string' && query.cwd.trim().length > 0 ? query.cwd.trim() : undefined
      const scopeParam = typeof query.scope === 'string' ? query.scope.trim() : undefined
      if (scopeParam && !['user', 'workspace', 'all'].includes(scopeParam)) {
        ctx.status = 400
        ctx.body = { error: 'Query parameter "scope" must be "user", "workspace", or "all"' }
        return
      }
      const scope = (scopeParam === 'user' || scopeParam === 'workspace') ? scopeParam : undefined
      const result = await service.listServers({ cwd, scope })
      ctx.status = 200
      ctx.body = result
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to list MCP servers' }
    }
  })

  // POST api/dsh-mcp-adapter/save
  router.post(ROUTES.save, async (ctx: any) => {
    try {
      const body = ctx.request?.body ?? ctx.body ?? {}
      const { scope, cwd, name, originalName, originalScope, server } = body
      if (scope !== 'user' && scope !== 'workspace') {
        ctx.status = 400
        ctx.body = { error: 'Field "scope" must be "user" or "workspace"' }
        return
      }
      if (originalScope !== undefined && originalScope !== 'user' && originalScope !== 'workspace') {
        ctx.status = 400
        ctx.body = { error: 'Field "originalScope" must be "user" or "workspace"' }
        return
      }
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        ctx.status = 400
        ctx.body = { error: 'Field "name" is required' }
        return
      }
      if (originalName !== undefined && (typeof originalName !== 'string' || originalName.trim().length === 0)) {
        ctx.status = 400
        ctx.body = { error: 'Field "originalName" must be a non-empty string' }
        return
      }
      if (!isPlainObject(server)) {
        ctx.status = 400
        ctx.body = { error: 'Field "server" must be an object' }
        return
      }
      await service.saveServer({
        scope: scope as Scope,
        name: name.trim(),
        originalName: typeof originalName === 'string' ? originalName.trim() : undefined,
        originalScope: originalScope as Scope | undefined,
        server,
        cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
      })
      ctx.status = 200
      ctx.body = { ok: true }
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to save MCP server' }
    }
  })

  // POST api/dsh-mcp-adapter/approve
  router.post(ROUTES.approve, async (ctx: any) => {
    try {
      const body = ctx.request?.body ?? ctx.body ?? {}
      const { cwd, name } = body
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        ctx.status = 400
        ctx.body = { error: 'Field "name" is required' }
        return
      }
      const effectiveCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined
      await service.approveServer({ cwd: effectiveCwd, name: name.trim() })
      ctx.status = 200
      ctx.body = { ok: true }
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to approve MCP server' }
    }
  })

  // POST api/dsh-mcp-adapter/delete
  router.post(ROUTES.delete, async (ctx: any) => {
    try {
      const body = ctx.request?.body ?? ctx.body ?? {}
      const { scope, cwd, name } = body
      if (scope !== 'user' && scope !== 'workspace') {
        ctx.status = 400
        ctx.body = { error: 'Field "scope" must be "user" or "workspace"' }
        return
      }
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        ctx.status = 400
        ctx.body = { error: 'Field "name" is required' }
        return
      }
      await service.deleteServer({
        scope: scope as Scope,
        name: name.trim(),
        cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
      })
      ctx.status = 200
      ctx.body = { ok: true }
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to delete MCP server' }
    }
  })

  // POST api/dsh-mcp-adapter/probe
  router.post(ROUTES.probe, async (ctx: any) => {
    try {
      const body = ctx.request?.body ?? ctx.body ?? {}
      const target = isPlainObject(body.server) ? body.server : body
      if (!isPlainObject(target) || Object.keys(target).length === 0) {
        ctx.status = 400
        ctx.body = { ok: false, error: 'Field "server" must be an object' }
        return
      }
      const result = await service.probeServer(target)
      ctx.status = 200
      ctx.body = result
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { ok: false, error: messageOf(err) || 'Failed to probe MCP server' }
    }
  })

  // GET api/dsh-mcp-adapter/presets
  router.get(ROUTES.presets, async (ctx: any) => {
    try {
      ctx.status = 200
      ctx.body = { presets: service.listPresets() }
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to list presets' }
    }
  })

  // POST api/dsh-mcp-adapter/presets/install
  router.post(ROUTES.installPreset, async (ctx: any) => {
    try {
      const body = ctx.request?.body ?? ctx.body ?? {}
      const { presetId, scope, cwd, envOverrides } = body
      if (!presetId || typeof presetId !== 'string' || presetId.trim().length === 0) {
        ctx.status = 400
        ctx.body = { error: 'Field "presetId" is required' }
        return
      }
      if (scope !== 'user' && scope !== 'workspace') {
        ctx.status = 400
        ctx.body = { error: 'Field "scope" must be "user" or "workspace"' }
        return
      }
      const result = await service.installPreset({
        presetId: presetId.trim(),
        scope: scope as Scope,
        cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
        envOverrides: isPlainObject(envOverrides) ? (envOverrides as Record<string, string>) : undefined,
      })
      ctx.status = 200
      ctx.body = result
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to install preset' }
    }
  })

  // POST api/dsh-mcp-adapter/toggle
  router.post(ROUTES.toggle, async (ctx: any) => {
    try {
      const body = ctx.request?.body ?? ctx.body ?? {}
      const { name, scope, cwd, enabled } = body
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        ctx.status = 400
        ctx.body = { error: 'Field "name" is required' }
        return
      }
      if (scope !== 'user' && scope !== 'workspace') {
        ctx.status = 400
        ctx.body = { error: 'Field "scope" must be "user" or "workspace"' }
        return
      }
      if (typeof enabled !== 'boolean') {
        ctx.status = 400
        ctx.body = { error: 'Field "enabled" must be a boolean' }
        return
      }
      const result = await service.toggleServer({
        name: name.trim(),
        scope: scope as Scope,
        cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
        enabled,
      })
      ctx.status = 200
      ctx.body = result
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to toggle server' }
    }
  })

  // POST api/dsh-mcp-adapter/migrate-scope
  router.post(ROUTES.migrateScope, async (ctx: any) => {
    try {
      const body = ctx.request?.body ?? ctx.body ?? {}
      const { name, fromScope, toScope, cwd } = body
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        ctx.status = 400
        ctx.body = { error: 'Field "name" is required' }
        return
      }
      if ((fromScope !== 'user' && fromScope !== 'workspace') || (toScope !== 'user' && toScope !== 'workspace')) {
        ctx.status = 400
        ctx.body = { error: 'Fields "fromScope" and "toScope" must be "user" or "workspace"' }
        return
      }
      const result = await service.migrateScope({
        name: name.trim(),
        fromScope: fromScope as Scope,
        toScope: toScope as Scope,
        cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
      })
      ctx.status = 200
      ctx.body = result
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to migrate server scope' }
    }
  })

  // GET api/dsh-mcp-adapter/scan-external
  router.get(ROUTES.scanExternal, async (ctx: any) => {
    try {
      const query = ctx.query ?? ctx.request?.query ?? {}
      const cwd = typeof query.cwd === 'string' && query.cwd.trim().length > 0 ? query.cwd.trim() : undefined
      const result = service.scanExternal({ cwd })
      ctx.status = 200
      ctx.body = result
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to scan external MCP configurations' }
    }
  })

  // POST api/dsh-mcp-adapter/import-external
  router.post(ROUTES.importExternal, async (ctx: any) => {
    try {
      const body = ctx.request?.body ?? ctx.body ?? {}
      const { items, scope, cwd } = body
      if (!Array.isArray(items)) {
        ctx.status = 400
        ctx.body = { error: 'Field "items" must be an array' }
        return
      }
      if (scope !== 'user' && scope !== 'workspace') {
        ctx.status = 400
        ctx.body = { error: 'Field "scope" must be "user" or "workspace"' }
        return
      }
      const result = await service.importExternal({
        items: items as ExternalMcpCandidate[],
        scope: scope as Scope,
        cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
      })
      ctx.status = 200
      ctx.body = result
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to import external MCP configurations' }
    }
  })

  // GET api/dsh-mcp-adapter/catalog
  router.get(ROUTES.catalog, async (ctx: any) => {
    try {
      const result = service.listCatalog()
      ctx.status = 200
      ctx.body = { catalog: result }
    } catch (err: unknown) {
      ctx.status = (err as HttpError)?.statusCode ?? 500
      ctx.body = { error: messageOf(err) || 'Failed to list MCP catalog' }
    }
  })
}
