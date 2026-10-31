import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpServersService } from './service.ts'
import type { Scope } from './types.ts'

export const ROUTES = {
  servers: 'api/dsh-mcp-adapter/servers',
  save: 'api/dsh-mcp-adapter/save',
  approve: 'api/dsh-mcp-adapter/approve',
  delete: 'api/dsh-mcp-adapter/delete',
  probe: 'api/dsh-mcp-adapter/probe',
  presets: 'api/dsh-mcp-adapter/presets',
  installPreset: 'api/dsh-mcp-adapter/presets/install',
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

export function createMcpWebRoutes(service: McpServersService): McpWebRoute[] {
  return [
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
          const { scope, cwd, name, server } = body
          if (scope !== 'user' && scope !== 'workspace') {
            writeJson(res, 400, { error: 'Field "scope" must be "user" or "workspace"' })
            return
          }
          if (!name || typeof name !== 'string' || name.trim().length === 0) {
            writeJson(res, 400, { error: 'Field "name" is required' })
            return
          }
          if (!isPlainObject(server)) {
            writeJson(res, 400, { error: 'Field "server" must be an object' })
            return
          }
          await service.saveServer({
            scope: scope as Scope,
            name: name.trim(),
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
          const effectiveCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : process.cwd()
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
  ]
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
      const { scope, cwd, name, server } = body
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
      if (!isPlainObject(server)) {
        ctx.status = 400
        ctx.body = { error: 'Field "server" must be an object' }
        return
      }
      await service.saveServer({
        scope: scope as Scope,
        name: name.trim(),
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
      const effectiveCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : process.cwd()
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
}
