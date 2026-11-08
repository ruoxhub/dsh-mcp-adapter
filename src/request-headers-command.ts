import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { FetchLike } from './tls-fetch.ts'
import type { HttpRequestHeadersCommand } from './types.ts'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 64 * 1024

function killCommandProcess(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    } catch {
      // Fall back to standard kill
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Ignore error if process already terminated
  }
}

export async function invokeHeadersCommand(
  config: HttpRequestHeadersCommand,
  envelope: { version: 1; method: string; url: string; bodyBase64: string },
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  return new Promise<Record<string, string>>((resolve, reject) => {
    let stdout = Buffer.alloc(0)
    let settled = false
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

    let child: ChildProcess
    try {
      child = spawn(config.command, config.args ?? [], {
        env: { ...process.env, ...(config.env ?? {}) },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch (err: unknown) {
      reject(new Error(`HTTP request headers command failed to start: ${err instanceof Error ? err.message : String(err)}`))
      return
    }

    const timer = setTimeout(() => {
      finish(new Error(`HTTP request headers command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const onAbort = () => {
      finish(new Error('HTTP request headers command aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    const finish = (error?: Error, headers?: Record<string, string>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      killCommandProcess(child)
      if (error) reject(error)
      else resolve(headers ?? {})
    }

    child.on('error', (err) => finish(new Error(`HTTP request headers command error: ${err.message}`)))

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled) return
      stdout = Buffer.concat([stdout, Buffer.from(chunk)])
      if (stdout.byteLength > MAX_OUTPUT_BYTES) {
        finish(new Error('HTTP request headers command output exceeded 64 KiB'))
      }
    })

    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) {
        finish(new Error(`HTTP request headers command exited with code ${code ?? 'unknown'}`))
        return
      }
      try {
        const text = stdout.toString('utf8').trim()
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish(new Error('HTTP request headers command must return a JSON object'))
          return
        }
        const headers: Record<string, string> = {}
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val !== 'string') {
            finish(new Error('HTTP request headers command header values must be strings'))
            return
          }
          headers[key] = val
        }
        finish(undefined, headers)
      } catch (err: unknown) {
        finish(new Error(`HTTP request headers command returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`))
      }
    })

    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(envelope))
  })
}

/** Wrap fetch so a trusted command can derive headers from the exact request. */
export function createRequestHeadersCommandFetch(
  config: HttpRequestHeadersCommand,
  delegate: FetchLike = globalThis.fetch,
): FetchLike {
  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const signal = init?.signal === null
      ? request.signal
      : (init?.signal ?? (input instanceof Request ? input.signal : request.signal))

    const bodyBuffer = request.body ? Buffer.from(await request.clone().arrayBuffer()) : Buffer.alloc(0)
    const derived = await invokeHeadersCommand(
      config,
      {
        version: 1,
        method: request.method.toUpperCase(),
        url: request.url,
        bodyBase64: bodyBuffer.toString('base64'),
      },
      signal ?? undefined,
    )

    const headers = new Headers(request.headers)
    for (const [key, val] of Object.entries(derived)) {
      headers.set(key, val)
    }

    return delegate(new URL(request.url), {
      method: request.method,
      headers,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: bodyBuffer }),
      signal,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    })
  }
}
