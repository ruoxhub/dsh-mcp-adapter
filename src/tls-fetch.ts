// A `fetch` that trusts one extra PEM CA, for servers configured with `caFile`.
//
// Why this exists instead of passing a CA to the SDK: `@modelcontextprotocol/client` forwards a
// `FetchLike` to both HTTP transports, but the runtime's global `fetch` (undici) has no per-request
// CA option and undici is not importable from this package. Node's `https.request` does take `ca`,
// so the shim below is a `fetch`-shaped wrapper over it — no new dependency.
//
// Scope, stated so it cannot be mistaken for more: the extra CA is trusted for the ONE server whose
// entry named it, and it is added to Node's default roots rather than replacing them. Redirects are
// not followed, because following one would silently move the trust to an origin nobody configured.

import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'

/** The SDK's own `FetchLike`, restated so this module needs no SDK import. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

/**
 * Read the PEM bundle a server named in `caFile`.
 * @throws when the file is missing or unreadable — a configured trust anchor that silently does
 * nothing is worse than a connect that fails and says why.
 */
export function readCaBundle(path: string): string {
  return readFileSync(path, 'utf8')
}

/** A request body as the raw bytes `https.request` writes. */
function bodyOf(body: RequestInit['body']): string | Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  // A stream body has no synchronous form; the MCP SDK only sends strings and buffers.
  return undefined
}

/** Flatten `RequestInit.headers` (which `Headers` accepts in four shapes) into a plain map. */
function headersOf(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(init.headers).forEach((value, key) => {
    out[key] = value
  })
  return out
}

/**
 * Build a `fetch` that trusts `ca` in addition to Node's default roots.
 *
 * The response body is streamed rather than buffered: the SSE transport reads an event stream off
 * it, and buffering would deadlock a stream that never ends.
 * @param ca - PEM text of the extra trust anchor.
 * @returns a `FetchLike` for one transport.
 */
export function fetchWithCa(ca: string): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(String(input))
    const secure = url.protocol === 'https:'
    if (!secure && url.protocol !== 'http:') throw new Error(`unsupported protocol ${url.protocol} for ${url.href}`)

    const send = secure ? httpsRequest : httpRequest
    const body = bodyOf(init.body)
    const signal = init.signal ?? undefined

    return await new Promise<Response>((resolve, reject) => {
      const req = send({
        method: init.method ?? 'GET',
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: headersOf(init),
        ...(secure ? { ca } : {}),
      }, (res: IncomingMessage) => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          if (Array.isArray(value)) for (const item of value) headers.append(key, item)
          else headers.set(key, value)
        }
        const status = res.statusCode ?? 502
        // A 204/304 must not carry a body; `Response` rejects one that does.
        const noBody = status === 204 || status === 304
        resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), { status, headers }))
      })
      req.on('error', reject)
      if (signal !== undefined) {
        if (signal.aborted) {
          req.destroy(new Error('aborted'))
          return
        }
        signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
      }
      if (body !== undefined) req.write(body)
      req.end()
    })
  }
}
