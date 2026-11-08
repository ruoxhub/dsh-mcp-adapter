/**
 * Host credentials integration (ctx.credentials).
 *
 * Implements ADR-0002 & ADR-0007: Reads server credentials from host's `ctx.credentials`
 * using the owner-scoped key `mcp-adapter/<server>`. Falls back smoothly to static
 * `bearerToken` / `bearerTokenEnv` if credentials service is absent or fails.
 */

export interface CredentialRecordLike {
  kind?: string
  payload?: Record<string, unknown>
}

export interface CredentialServiceLike {
  readRecord?: (key: string) => Promise<CredentialRecordLike | undefined>
  resolve?: (ref: string) => Promise<{ value?: string; source?: string } | undefined>
}

/**
 * Resolve an authorization token for a given server name.
 *
 * 1. Checks `ctx.credentials.readRecord('mcp-adapter/<server>')` for a payload containing
 *    `token`, `apiKey`, `value`, or `accessToken`.
 * 2. Checks `ctx.credentials.resolve('mcp-adapter/<server>')`.
 * 3. Falls back to `fallbackToken`.
 */
export async function resolveServerToken(
  serverName: string,
  credentialsService?: unknown,
  fallbackToken?: string,
): Promise<string | undefined> {
  if (credentialsService && typeof credentialsService === 'object') {
    const creds = credentialsService as CredentialServiceLike
    // 1. Owner-scoped record: mcp-adapter/<server>
    if (typeof creds.readRecord === 'function') {
      try {
        const record = await creds.readRecord(`mcp-adapter/${serverName}`)
        if (record && record.payload && typeof record.payload === 'object') {
          const payload = record.payload
          const candidate = payload.token ?? payload.apiKey ?? payload.value ?? payload.accessToken
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim()
          }
        }
      } catch {
        // Fall through on error or refusal
      }
    }

    // 2. Reference resolver: mcp-adapter/<server>
    if (typeof creds.resolve === 'function') {
      try {
        const hit = await creds.resolve(`mcp-adapter/${serverName}`)
        if (hit && typeof hit.value === 'string' && hit.value.trim().length > 0) {
          return hit.value.trim()
        }
      } catch {
        // Fall through
      }
    }
  }

  return fallbackToken && fallbackToken.trim().length > 0 ? fallbackToken.trim() : undefined
}
