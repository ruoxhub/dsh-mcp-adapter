// The fence's own contract. Each case names the attack it stops rather than the header it reads,
// because the headers are only a means: a route here writes config files and starts processes.

import { describe, expect, it, vi } from 'vitest'
import { isTrustedPanelRequest } from '../src/request-trust.ts'
import { createMcpWebRoutes, type McpWebRoute } from '../src/routes.ts'

/** The smallest request the fence reads: a Host plus whatever browser markers a case adds. */
function request(headers: Record<string, string | undefined>): { headers: Record<string, string | undefined> } {
  return { headers }
}

describe('isTrustedPanelRequest', () => {
  it('accepts the same-origin request a GUI page makes to a loopback listener', () => {
    expect(isTrustedPanelRequest(request({
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
    }) as never)).toBe(true)
  })

  it('accepts a localhost Host and any 127/8 address, and an IPv6 loopback', () => {
    expect(isTrustedPanelRequest(request({ host: 'localhost:3080' }) as never)).toBe(true)
    expect(isTrustedPanelRequest(request({ host: '127.5.6.7:3080' }) as never)).toBe(true)
    expect(isTrustedPanelRequest(request({ host: '[::1]:3080' }) as never)).toBe(true)
  })

  it('refuses a request with no Host at all', () => {
    // Identity is the point: an absent Host is not evidence of anything.
    expect(isTrustedPanelRequest(request({}) as never)).toBe(false)
  })

  it('refuses DNS rebinding: a foreign hostname that resolves to this machine', () => {
    // The socket reached us, but Host names the attacker's domain. This is the case Host exists for.
    expect(isTrustedPanelRequest(request({ host: 'evil.example.com:3080' }) as never)).toBe(false)
    expect(isTrustedPanelRequest(request({ host: 'evilexample.com' }) as never)).toBe(false)
  })

  it('refuses a cross-site request even when the Host is ours', () => {
    expect(isTrustedPanelRequest(request({
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'cross-site',
    }) as never)).toBe(false)
  })

  it('refuses a foreign Origin on a request whose Host is ours', () => {
    // What a form post or a no-cors fetch from a malicious page produces: Host is fine, Origin is not.
    expect(isTrustedPanelRequest(request({
      host: '127.0.0.1:3080',
      origin: 'https://evil.example.com',
    }) as never)).toBe(false)
  })

  it('refuses a non-HTTP Origin scheme', () => {
    // `file://` and `null` (a sandboxed iframe) both parse as URLs; neither is a page we serve.
    expect(isTrustedPanelRequest(request({ host: '127.0.0.1:3080', origin: 'file:///tmp/x.html' }) as never)).toBe(false)
    expect(isTrustedPanelRequest(request({ host: '127.0.0.1:3080', origin: 'null' }) as never)).toBe(false)
  })

  it('accepts the listener bind literal when it is not loopback', () => {
    // A deployment on a concrete interface: the browser dials that literal, and it is no rebinding
    // target. Without the bind fact from `ctx.webServer` this would be refused.
    expect(isTrustedPanelRequest(
      request({ host: '192.168.1.10:3080' }) as never,
      { bindHost: '192.168.1.10' },
    )).toBe(true)
    // Still closed for a hostname nobody configured.
    expect(isTrustedPanelRequest(
      request({ host: 'evil.example.com:3080' }) as never,
      { bindHost: '192.168.1.10' },
    )).toBe(false)
  })

  it('normalizes a default port on both sides, so http://localhost:80 matches Host localhost', () => {
    expect(isTrustedPanelRequest(
      request({ host: 'localhost', origin: 'http://localhost:80' }) as never,
      { protocol: 'http:' },
    )).toBe(true)
  })

  it('reads the first value when a header repeats', () => {
    expect(isTrustedPanelRequest({ headers: { host: ['127.0.0.1:3080', 'evil.example.com'] } } as never)).toBe(true)
  })
})

describe('the panel routes are behind that fence', () => {
  const service = {
    listServers: vi.fn(async () => ({ servers: [], workspaceRoot: '', workspaces: [] })),
  }

  /** The first registered route; the fence wraps every one of them identically. */
  function firstRoute(): McpWebRoute {
    const route = createMcpWebRoutes(service as never)[0]
    if (route === undefined) throw new Error('no routes were created')
    return route
  }

  function response(): { res: unknown; status: () => number; body: () => unknown } {
    let status = 0
    let text = ''
    const res = {
      writeHead: (code: number) => { status = code },
      end: (body?: string) => { text = body ?? '' },
    }
    return { res, status: () => status, body: () => (text ? JSON.parse(text) : undefined) }
  }

  it('refuses a cross-site request before the handler runs', async () => {
    const { res, status, body } = response()
    await firstRoute().handler({ method: 'GET', url: '/api/dsh-mcp-adapter/servers', headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } } as never, res as never)
    expect(status()).toBe(403)
    expect((body() as { error: string }).error).toContain('did not come from this Harness GUI')
    expect(service.listServers).not.toHaveBeenCalled()
  })

  it('lets a same-origin request through to the handler', async () => {
    const { res, status } = response()
    await firstRoute().handler({
      method: 'GET',
      url: '/api/dsh-mcp-adapter/servers',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    } as never, res as never)
    expect(status()).toBe(200)
    expect(service.listServers).toHaveBeenCalled()
  })
})
