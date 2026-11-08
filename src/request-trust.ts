// The browser-trust fence for this adapter's own /api routes.
//
// DSH fences every request that reaches its RPC bridge (`packages/client/connection/src/
// api-request-trust.ts`), but that fence sits on the RPC host, not on the web server: a route
// registered through `ctx.webServer.register()` is served before any of it. Without this file the
// panel's routes — which write `.mcp.json` and start processes — answer any page that can reach
// the port, and a browser makes that reachable two ways: DNS rebinding (the socket lands here while
// `Host` names the attacker's domain) and a plain cross-site `fetch`/form post.
//
// The rules are DSH's, restated here because its helper is not part of the published surface: the
// package exports neither `isTrustedApiRequest` nor a way to read the deployment's `trustedHosts`,
// and the plugin cannot depend on the client-connection package at all. Restating them keeps one
// behaviour instead of inventing a second, weaker one; when DSH exports a reusable check this file
// should call it and shrink to a wrapper.

import type { IncomingMessage } from 'node:http'

/** The listener facts a fence needs; both come from `ctx.webServer`, never from a request header. */
export interface ListenerFacts {
  /** The bind address the webserver was configured with, as a bare literal (`127.0.0.1`, `::1`). */
  bindHost?: string
  /** The protocol the listener speaks. Follows configuration, so no proxy can change it. */
  protocol?: 'http:' | 'https:'
}

/** A header value as Node delivers it: a string, an array of strings, or absent. */
type HeaderValue = string | string[] | undefined

/**
 * Parse a bare authority (`host` or `host:port`) as the browser sent it.
 *
 * A WHATWG parse is used on purpose: it normalizes default ports and rejects the malformed values,
 * which is what keeps `Host` comparisons exact instead of prefix matches.
 * @param value - the header value, verbatim.
 * @param protocol - the listener protocol, for the default port.
 * @returns the parsed URL, or `undefined` when the value is not an authority.
 */
function parseAuthority(value: string, protocol: string): URL | undefined {
  try {
    // A value that already carries a scheme is parsed as-is; a bare authority gets the listener's.
    return new URL(value.includes('://') ? value : `${protocol}//${value}`)
  } catch {
    return undefined
  }
}

/** Whether a hostname names this machine: `localhost`, any `127/8` address, or IPv6 loopback. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a hostname is the listener's own bind address.
 *
 * The port is ignored, like a port-less `trustedHosts` entry: a browser dialing the literal sends it
 * as `Host`, and accepting it grants nothing more — the Origin and cross-site rules still apply. An
 * IPv6 zone (`fe80::1%eth0`) is an interface selector rather than address text, so it is stripped.
 * @param hostname - the parsed `Host` hostname.
 * @param bindHost - the configured bind literal, if the webserver exposed one.
 */
function isBindAddress(hostname: string, bindHost: string | undefined): boolean {
  if (bindHost === undefined || bindHost.length === 0) return false
  const zoneAt = bindHost.indexOf('%')
  const address = zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt)
  const bindUrl = parseAuthority(address.includes(':') ? `[${address}]` : address, 'http:')
  return bindUrl !== undefined && bindUrl.hostname === hostname
}

/** Whether an `Origin` value names exactly the authority a request arrived on. */
function isSameAuthorityOrigin(origin: string, host: URL): boolean {
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  const scheme = originUrl.protocol
  if (scheme !== 'http:' && scheme !== 'https:') return false
  // Re-parse the Host under the Origin's scheme so a default port normalizes the same way on both.
  const hostUrl = parseAuthority(host.href, scheme)
  return hostUrl !== undefined && originUrl.host === hostUrl.host
}

/** One header value, first occurrence wins for the array form. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value: HeaderValue = req.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Decide whether one panel request may reach this adapter's routes.
 *
 * Three rules, all of which a same-origin page in this GUI passes:
 * 1. `Host` must name this listener — loopback or its own bind address. It is required, because over
 *    plain HTTP a rebound browser read carries neither Origin nor Fetch-Metadata, and `Host` is the
 *    one header rebinding cannot forge.
 * 2. `Sec-Fetch-Site: cross-site` is refused even with an acceptable Host: the request came from a
 *    page this deployment does not serve.
 * 3. An attached `Origin` must be this listener's own authority. Generated cross-site POSTs carry
 *    one, so this is what stops a form post from a malicious page.
 * @param req - the incoming request; only its headers are read.
 * @param listener - the listener facts from `ctx.webServer`.
 * @returns true when the request may be served.
 */
export function isTrustedPanelRequest(req: IncomingMessage, listener: ListenerFacts = {}): boolean {
  const protocol = listener.protocol ?? 'http:'
  const host = headerOf(req, 'host')
  if (host === undefined || host.length === 0) return false
  const hostUrl = parseAuthority(host, protocol)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isBindAddress(hostUrl.hostname, listener.bindHost)) return false
  if (headerOf(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(req, 'origin')
  if (origin === undefined || origin.length === 0) return true
  return isSameAuthorityOrigin(origin, hostUrl)
}
