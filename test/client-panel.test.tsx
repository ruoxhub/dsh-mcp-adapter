// Self-check for the rebuilt panel: the projection read, the two row kinds, the dictionaries, and the
// source-level guard on the key-first `useProjection` call.
//
// What this would catch: a panel that throws on mount because it read the projection as
// `useProjection((state) => state.x)` (the shipped artefact's form, which resolves `key = undefined`),
// a held-back server that stops being listed under the approval section, an approve affordance that
// disappears, and the two dictionaries drifting apart.
//
// `@deepseek-ai/dsh-client-ui-primitives` is a host-served platform module: its own runtime deps
// (clsx, shiki, katex, ...) are NOT installed in this package, so importing the real bundle would fail
// to resolve in Node. The four icons and the two hooks are therefore stubbed below; everything this
// file actually tests — the projection read, the render tree, the state, the portal, the Escape
// handler — is the real component.

import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ReactNode } from 'react'
import type { StatusSnapshot } from '../src/projection.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpPanel, type McpPanelProps } from '../src/client/McpPanel.tsx'
import { en, NS, zh, type McpAdapterLocaleKey } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const icon = (name: string) => function MockIcon(): ReactNode {
    return createElement('span', { 'data-icon': name })
  }
  return {
    StateDot: function MockStateDot(): ReactNode {
      return createElement('span', { 'data-state-dot': true })
    },
    useAnchoredPosition: () => null,
    useDismissOnOutsidePointer: () => {},
    IconDataOutlineRegular: icon('data'),
    IconChevronDownOutlineRegular: icon('chevron'),
    IconCheckOutlineRegular: icon('check'),
    IconCopyOutlineRegular: icon('copy'),
  }
})

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
})

/** The panel's translate seat over the Chinese dictionary, with `{name}` template substitution. */
function translate(key: McpAdapterLocaleKey, params?: Record<string, unknown>): string {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

/** A Session store whose `binding` is absent: enough for the render paths this file drives. */
const sessions = { binding: () => undefined } as unknown as ISessions

/**
 * Mount the panel into a fresh container.
 * @param projection - the value the fake `useProjection` answers for the `mcpAdapter` key.
 * @returns the trigger host container (the open dialog portals into `document.body`).
 */
function mount(projection: StatusSnapshot | undefined): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const mounted = createRoot(host)
  const useProjection = ((key: string) => (key === 'mcpAdapter' ? projection : undefined)) as unknown as McpPanelProps['useProjection']
  const t = translate as unknown as McpPanelProps['t']
  act(() => {
    mounted.render(createElement(McpPanel, { sessionId: 's1' as McpPanelProps['sessionId'], sessions, useProjection, t }))
  })
  root = mounted
  container = host
  return host
}

/** The open dialog's text; it portals into `document.body`, so it is not under the trigger's host. */
function panelText(): string {
  return document.querySelector('[data-mcp-adapter-panel]')?.textContent ?? ''
}

/** Open the panel by clicking its trigger. */
function open(): void {
  act(() => {
    container?.querySelector('button')?.click()
  })
}

/** One snapshot row, defaulted to a mounted server so a case states only what it changes. */
function server(overrides: Partial<StatusSnapshot['servers'][number]> = {}): StatusSnapshot['servers'][number] {
  return {
    name: 'local',
    state: 'ready',
    transport: 'stdio',
    lifecycle: 'lazy',
    tools: 0,
    toolNames: [],
    lastError: '',
    blockedReason: '',
    ...overrides,
  }
}

/** A snapshot with its counts derived from its rows, so a case cannot state them inconsistently. */
function snapshot(rows: StatusSnapshot['servers'][number][], overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    available: true,
    projectRoot: '/repo',
    error: '',
    servers: rows,
    problems: [],
    counts: {
      servers: rows.length,
      running: rows.filter((row) => row.state === 'ready').length,
      tools: rows.reduce((total, row) => total + row.tools, 0),
      blocked: rows.filter((row) => row.blockedReason.length > 0).length,
    },
    ...overrides,
  }
}

describe('MCP panel', () => {
  it('renders the unavailable notice when no projection is published', () => {
    mount(undefined)
    open()
    expect(panelText()).toContain(zh.unavailable)
  })

  it('lists a held-back server under the approval section with its reason', () => {
    mount(snapshot([server({ state: 'blocked', blockedReason: 'not approved' })]))
    open()
    const text = panelText()
    expect(text).toContain(zh.blockedTitle)
    expect(text).toContain('not approved')
    expect(text).toContain(zh.approve)
  })

  it('keeps both dictionaries on the same key set', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(NS).toBe('mcp-adapter-panel')
  })

  it('reads the projection through the key-first form the API declares', () => {
    const source = readFileSync(join(process.cwd(), 'src/client/McpPanel.tsx'), 'utf8')
    expect(source).toContain("useProjection('mcpAdapter'")
    expect(source).not.toMatch(/useProjection\(\s*\(/)
  })

  it('mounts a populated projection and shows the server, its tool count, and the blocked reason', () => {
    mount(snapshot([
      server({ name: 'alpha', tools: 2, toolNames: ['read', 'write'] }),
      server({ name: 'beta', state: 'blocked', blockedReason: 'needs approval' }),
    ]))
    open()
    const text = panelText()
    expect(text).toContain('alpha')
    expect(text).toContain(`2 ${zh.tools}`)
    expect(text).toContain('needs approval')
    // The trigger counts mounted servers against all of them while anything is held back.
    expect(container?.textContent).toContain('1/2')
  })

  it('toggles a server tool list open and shut', () => {
    mount(snapshot([server({ name: 'alpha', tools: 2, toolNames: ['read', 'write'] })]))
    open()
    expect(panelText()).not.toContain('write')
    act(() => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('查看 2 个工具'))
        ?.click()
    })
    expect(panelText()).toContain('read')
    expect(panelText()).toContain('write')
    expect(panelText()).toContain(zh.hideTools)
  })

  it('closes on Escape', () => {
    mount(snapshot([server()]))
    open()
    expect(panelText()).not.toBe('')
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[data-mcp-adapter-panel]')).toBeNull()
  })
})
