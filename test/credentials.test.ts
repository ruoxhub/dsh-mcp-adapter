import { describe, expect, it, vi } from 'vitest'
import { resolveServerToken } from '../src/credentials.ts'

describe('resolveServerToken', () => {
  it('resolves token from readRecord with mcp-adapter/<server> key', async () => {
    const creds = {
      readRecord: vi.fn(async (key: string) => {
        if (key === 'mcp-adapter/github') {
          return { kind: 'grant', payload: { token: 'ghp_secret_from_record' } }
        }
        return undefined
      }),
    }

    const token = await resolveServerToken('github', creds, 'static_fallback')
    expect(token).toBe('ghp_secret_from_record')
    expect(creds.readRecord).toHaveBeenCalledWith('mcp-adapter/github')
  })

  it('supports apiKey or accessToken in record payload', async () => {
    const creds = {
      readRecord: vi.fn(async (key: string) => {
        if (key === 'mcp-adapter/weather') {
          return { kind: 'key', payload: { apiKey: 'weather_api_key_456' } }
        }
        return undefined
      }),
    }

    const token = await resolveServerToken('weather', creds)
    expect(token).toBe('weather_api_key_456')
  })

  it('falls back to creds.resolve if readRecord is absent or returns empty', async () => {
    const creds = {
      resolve: vi.fn(async (ref: string) => {
        if (ref === 'mcp-adapter/slack') {
          return { value: 'xoxb-resolved-token' }
        }
        return undefined
      }),
    }

    const token = await resolveServerToken('slack', creds)
    expect(token).toBe('xoxb-resolved-token')
  })

  it('falls back to static fallbackToken when credentials service throws or misses', async () => {
    const brokenCreds = {
      readRecord: vi.fn(async () => {
        throw new Error('keychain locked')
      }),
    }

    const token = await resolveServerToken('my-server', brokenCreds, 'static_token_xyz')
    expect(token).toBe('static_token_xyz')
  })

  it('returns fallbackToken when credentials service is undefined or null', async () => {
    const token = await resolveServerToken('my-server', undefined, 'static_token_xyz')
    expect(token).toBe('static_token_xyz')
  })
})
