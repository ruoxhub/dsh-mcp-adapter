import { describe, expect, it, vi } from 'vitest'
import { sanitizeConfig } from '../src/index.ts'
import { DEFAULT_SETTINGS } from '../src/config.ts'

describe('sanitizeConfig projectServers', () => {
  it('takes the adapter default when the key is absent', () => {
    expect(sanitizeConfig({}).projectServers).toBe(DEFAULT_SETTINGS.projectServers)
    expect(sanitizeConfig({}).projectServers).toBe('allow')
  })

  it('honours each of the three literals', () => {
    expect(sanitizeConfig({ projectServers: 'allow' }).projectServers).toBe('allow')
    expect(sanitizeConfig({ projectServers: 'ask' }).projectServers).toBe('ask')
    expect(sanitizeConfig({ projectServers: 'deny' }).projectServers).toBe('deny')
  })

  it('fails closed on a value it cannot read, and says so', () => {
    // A misspelt "permit" must not be read as "run this repository's servers".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(sanitizeConfig({ projectServers: 'Allow' }).projectServers).toBe('ask')
      expect(sanitizeConfig({ projectServers: true }).projectServers).toBe('ask')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
