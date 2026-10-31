import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function parseSemver(v: string) {
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/)
  if (!match) throw new Error(`Invalid version: ${v}`)
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || '',
  }
}

function compareVersions(aStr: string, bStr: string): number {
  const a = parseSemver(aStr)
  const b = parseSemver(bStr)
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (!a.prerelease && b.prerelease) return 1
  if (a.prerelease && !b.prerelease) return -1
  if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true })
  return 0
}

function satisfies(runtimeVersion: string, range: string): boolean {
  // Simple check for >=A <B
  const match = range.match(/^>=([^\s]+)\s+<([^\s]+)$/)
  if (match) {
    const min = match[1]
    const max = match[2]
    return compareVersions(runtimeVersion, min) >= 0 && compareVersions(runtimeVersion, max) < 0
  }
  return false
}

describe('manifest compatibility', () => {
  const manifestPath = join(__dirname, '..', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  it('declares engines.dsh and peerDependencies matching DSH 0.2.1-rc.2 and 0.2.1-rc.5', () => {
    expect(manifest.engines?.dsh).toBeDefined()
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-session']).toBeDefined()

    const targetVersions = ['0.2.1-rc.2', '0.2.1-rc.5', '0.2.1', '0.2.2-alpha.2']
    for (const v of targetVersions) {
      expect(satisfies(v, manifest.engines.dsh)).toBe(true)
      expect(satisfies(v, manifest.peerDependencies['@deepseek-ai/dsh-session'])).toBe(true)
    }
  })

  it('rejects versions outside the 0.2.x series', () => {
    expect(satisfies('0.1.0', manifest.engines.dsh)).toBe(false)
    expect(satisfies('0.3.0', manifest.engines.dsh)).toBe(false)
  })
})
