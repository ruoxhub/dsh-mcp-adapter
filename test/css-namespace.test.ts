import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transform } from 'lightningcss'
import { describe, expect, it } from 'vitest'

/**
 * Scoped class names must be namespaced per plugin.
 *
 * lightningcss's `[hash]` placeholder mixes ONLY the `filename` string into the
 * scoped name, never the CSS content. Every plugin in the family ships a
 * stylesheet at `src/client/panel/panel.module.css`, and plugins are built and
 * published from their own repositories, so passing the bare repo-relative path
 * made two different plugins emit the *same* class names into one document. The
 * later <style> tag wins, so one plugin's rules silently restyled the other's
 * DOM: dsh-skill-manager's `.cardActions { opacity: 0; pointer-events: none }`
 * landed on dsh-mcp-adapter's action group, rendering the edit / more / toggle
 * controls invisible and unclickable.
 *
 * The build now prefixes the plugin id. This test pins the invariant that keeps
 * the collision from returning: two plugins sharing a stylesheet path must get
 * disjoint scoped names, and a global (unscoped) hash is never emitted.
 */

const PRESET = resolve(process.cwd(), 'shared/tsdown.client.ts')
const STYLESHEET = 'src/client/panel/panel.module.css'
const PROBE_CSS = Buffer.from('.cardActions{opacity:0}')

/** The `filename:` expression the preset feeds lightningcss. */
function scopedFilename(id: string, fileId: string): string {
  const source = readFileSync(PRESET, 'utf8')
  // Guard the wiring itself: the test must fail if the preset reverts to the
  // bare file id, not just if the hash happens to differ.
  expect(source).toContain('filename: `${id}/${fileId}`')
  return `${id}/${fileId}`
}

function scopedName(filename: string): string {
  const { exports } = transform({
    filename,
    code: PROBE_CSS,
    cssModules: { pattern: '[hash]_[local]' },
    minify: true,
  })
  // `exports` is typed void|CSSModuleExports; CSS Modules always populate it.
  const scoped = exports?.cardActions?.name
  expect(scoped).toBeTypeOf('string')
  return scoped as string
}

describe('client CSS module namespace', () => {
  it('gives two plugins that share a stylesheet path distinct class names', () => {
    const adapter = scopedName(scopedFilename('dsh-mcp-adapter', STYLESHEET))
    const skillManager = scopedName(scopedFilename('@moruoxing/dsh-skill-manager', STYLESHEET))
    const connectors = scopedName(scopedFilename('@linxin666/dsh-connectors', STYLESHEET))

    expect(adapter).toMatch(/^[A-Za-z0-9_-]+_cardActions$/)
    expect(new Set([adapter, skillManager, connectors]).size).toBe(3)
  })

  it('keeps scoped names stable for a given plugin and stylesheet', () => {
    const first = scopedName(scopedFilename('dsh-mcp-adapter', STYLESHEET))
    const second = scopedName(scopedFilename('dsh-mcp-adapter', STYLESHEET))
    expect(first).toBe(second)
  })
})
