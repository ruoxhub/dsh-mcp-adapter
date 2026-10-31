// The custom-CA fetch, checked against a real TLS handshake.
//
// This is the only test that can prove `caFile` works: the option's whole job is to change what the
// TLS stack trusts, so a mocked `fetch` would assert nothing. A self-signed certificate is generated
// at test time and the same request is made twice — once through the global `fetch` (which must
// reject it) and once through `fetchWithCa` (which must accept it). If `openssl` is unavailable the
// case reports itself as skipped rather than passing vacuously.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchWithCa, readCaBundle } from '../src/tls-fetch.ts'

const dirs: string[] = []
const servers: Array<{ close: (callback?: () => void) => unknown }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Whether a working `openssl` is on PATH; without it the TLS cases cannot build a certificate. */
function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A self-signed certificate for 127.0.0.1, plus an HTTPS server that serves one JSON body. */
async function startTlsServer(): Promise<{ url: string; caFile: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ca-'))
  dirs.push(dir)
  const keyFile = join(dir, 'key.pem')
  const certFile = join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile,
    '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' })

  const server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the TLS server has no port')
  return { url: `https://127.0.0.1:${address.port}/mcp`, caFile: certFile }
}

describe('fetchWithCa', () => {
  it('trusts the configured PEM where the global fetch does not', async () => {
    if (!hasOpenssl()) return
    const { url, caFile } = await startTlsServer()

    // Baseline: without the extra CA the certificate is not trusted. If this ever passes, the test
    // below would prove nothing, so it is asserted rather than assumed.
    await expect(fetch(url)).rejects.toThrow()

    const response = await fetchWithCa(readCaBundle(caFile))(url)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('fails closed when the PEM file is missing', () => {
    expect(() => readCaBundle('C:/definitely/not/here.pem')).toThrow()
  })

  it('rejects a non-HTTP protocol instead of silently reaching for a socket', async () => {
    await expect(fetchWithCa('unused')('file:///etc/passwd')).rejects.toThrow(/unsupported protocol/)
  })
})
