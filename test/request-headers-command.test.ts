import { describe, expect, it, vi } from 'vitest'
import { createRequestHeadersCommandFetch, invokeHeadersCommand } from '../src/request-headers-command.ts'

describe('invokeHeadersCommand', () => {
  it('parses valid json output from command and returns headers', async () => {
    const headers = await invokeHeadersCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({"x-auth-sig": "sig-abc", "Authorization": "Token 123"}))'],
    }, {
      version: 1,
      method: 'POST',
      url: 'https://example.com/api',
      bodyBase64: Buffer.from('test-body').toString('base64'),
    })

    expect(headers).toEqual({
      'x-auth-sig': 'sig-abc',
      Authorization: 'Token 123',
    })
  })

  it('rejects on non-zero exit code', async () => {
    await expect(
      invokeHeadersCommand({
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
      }, {
        version: 1,
        method: 'GET',
        url: 'https://example.com/api',
        bodyBase64: '',
      }),
    ).rejects.toThrow(/HTTP request headers command exited with code 1/)
  })

  it('rejects on invalid json output', async () => {
    await expect(
      invokeHeadersCommand({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("not-json")'],
      }, {
        version: 1,
        method: 'GET',
        url: 'https://example.com/api',
        bodyBase64: '',
      }),
    ).rejects.toThrow(/invalid JSON/)
  })

  it('rejects on non-string header values', async () => {
    await expect(
      invokeHeadersCommand({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(JSON.stringify({ "num": 123 }))'],
      }, {
        version: 1,
        method: 'GET',
        url: 'https://example.com/api',
        bodyBase64: '',
      }),
    ).rejects.toThrow(/header values must be strings/)
  })

  it('rejects on command timeout', async () => {
    await expect(
      invokeHeadersCommand({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        timeoutMs: 100,
      }, {
        version: 1,
        method: 'GET',
        url: 'https://example.com/api',
        bodyBase64: '',
      }),
    ).rejects.toThrow(/timed out after 100ms/)
  })
})

describe('createRequestHeadersCommandFetch', () => {
  it('passes derived headers to delegate fetch and preserves request body', async () => {
    const mockDelegate = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      return new Response('ok', {
        headers: {
          'x-echo-sig': headers.get('x-custom-sig') ?? '',
          'x-echo-orig': headers.get('x-original') ?? '',
        },
      })
    })

    const customFetch = createRequestHeadersCommandFetch({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({"x-custom-sig": "test-signature-xyz"}))'],
    }, mockDelegate)

    const response = await customFetch('https://example.com/mcp', {
      method: 'POST',
      headers: {
        'x-original': 'initial-header',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-echo-sig')).toBe('test-signature-xyz')
    expect(response.headers.get('x-echo-orig')).toBe('initial-header')
    expect(mockDelegate).toHaveBeenCalledTimes(1)
  })
})
