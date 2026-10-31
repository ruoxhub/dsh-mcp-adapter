/**
 * Native panel registration for MCP servers management center.
 *
 * Contributes:
 * 1. An icon entry into the sidebar's global panel list (`sidebar.panellist`)
 * 2. A keyed page into the layout's `main` slot (`mcp-servers`)
 *
 * @module dsh-mcp-adapter/client/native-panel
 */

import React, { type ReactElement } from 'react'
import type { McpServersApiClient } from './api.ts'
import type { McpPanelController } from './controller.ts'
import { tt } from './locales.ts'
import { McpServersPage } from './panel/McpServersPage.tsx'

/** The panel id shared by the sidebar entry and the main slot. */
export const MCP_SERVERS_PANEL_ID = 'mcp-servers'

/** Row order among the shell's global panel rows. */
export const PANEL_ORDER = 22

/**
 * The sidebar entry icon.
 *
 * Carries `data-dsh-panel-entry` for shell & skin styling hooks.
 */
export function McpServersPanelIcon({ size = 16 }: { size?: number; active?: boolean }): ReactElement {
  return (
    <svg
      data-dsh-panel-entry={MCP_SERVERS_PANEL_ID}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="4" r="1.75" />
      <circle cx="4" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <path d="M8 5.75v3.5m0 0L5.25 10.75M8 9.25l2.75 1.5" />
    </svg>
  )
}

export interface McpServersPanelPageProps {
  controller: McpPanelController
  api: McpServersApiClient
  cwd?: string
  /** Framework global seat: reactive view over the Client Session list. */
  useSessions?: UseSessionsSeat
}

/**
 * The main-slot page component.
 *
 * The live Session directory wins over the static `cwd` the registration captured at mount: the
 * user can switch conversations while the panel is open, and the panel's scope menu must follow.
 * Both reads happen unconditionally so the hook order never depends on which seat exists.
 */
export function McpServersPanelPage({
  controller,
  api,
  cwd,
  useSessions,
}: McpServersPanelPageProps): ReactElement {
  const hook: UseSessionsSeat = useSessions ?? useNoSessions
  const liveCwd = hook(mainSessionCwd)
  const activeCwd = liveCwd || cwd
  return (
    <div
      style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}
      data-dsh-mcp-servers-view=""
      data-dsh-plugin="mcp-adapter"
    >
      <McpServersPage controller={controller} api={api} cwd={activeCwd} />
    </div>
  )
}

/** The slice of the Client Session list this panel reads: identity plus each row's directory. */
interface SessionListShape {
  ids?: readonly string[]
  byId?: Record<string, { cwd?: string; retainedBy?: Readonly<Partial<Record<string, number>>> } | undefined>
}

/** The directory of the Session the main view currently shows; `''` when none is selected. */
function mainSessionCwd(state: SessionListShape): string {
  for (const id of state.ids ?? []) {
    const row = state.byId?.[id]
    if (row === undefined) continue
    if ((row.retainedBy?.mainView ?? 0) <= 0) continue
    if (typeof row.cwd === 'string' && row.cwd !== '') return row.cwd
  }
  return ''
}

/** Stable no-op selector used when the shell supplies no Session hook, so the call order holds. */
const EMPTY_SESSION_LIST: SessionListShape = { ids: [], byId: {} }
function useNoSessions<T>(selector: (state: SessionListShape) => T): T {
  return selector(EMPTY_SESSION_LIST)
}

/** The selector-hook seat the `main` slot's global standard props carry. */
type UseSessionsSeat = <T>(selector: (state: SessionListShape) => T) => T

/**
 * Resolve the active workspace directory from the client context.
 *
 * `useSessions` is the authoritative and reactive source (the shell hands it to every root-scoped
 * slot). This fallback covers a composition that renders the page without that seat: it reads the
 * two service names DSH actually registers — `sessions` and `workspaces` — never the `workspace`
 * service the first version invented, which does not exist and always yielded `''`.
 */
export function resolveClientCwd(ctx: unknown): string {
  try {
    const c = ctx as {
      get?: (name: string, required?: boolean) => unknown
    }
    const sessions = c.get?.('sessions', false) as
      | { list?: { getSnapshot?: () => SessionListShape } }
      | undefined
    const fromSessions = mainSessionCwd(sessions?.list?.getSnapshot?.() ?? EMPTY_SESSION_LIST)
    if (fromSessions !== '') return fromSessions

    const workspaces = c.get?.('workspaces', false) as
      | { list?: { getSnapshot?: () => { items?: ReadonlyArray<{ path?: string }> } } }
      | undefined
    const first = workspaces?.list?.getSnapshot?.().items?.[0]?.path
    if (typeof first === 'string' && first !== '') return first
    return ''
  } catch {
    return ''
  }
}

/**
 * Register MCP servers panel into sidebar.panellist and main slots.
 */
export function registerMcpServersPanel(
  ctx: unknown,
  controller: McpPanelController,
  api: McpServersApiClient,
): () => void {
  const slots = (ctx as {
    slots?: {
      inject: (key: string, callback: () => () => void) => () => void
      register: (options: Record<string, unknown>, component: unknown) => () => void
    }
  })?.slots

  if (!slots?.inject) {
    return () => {}
  }

  const disposers: Array<() => void> = []

  try {
    // 1. Sidebar entry icon
    disposers.push(
      slots.inject('sidebar.panellist', () =>
        slots.register(
          {
            name: 'sidebar.panellist',
            id: MCP_SERVERS_PANEL_ID,
            order: PANEL_ORDER,
            label: () => tt('entry.label'),
            tooltip: () => tt('entry.tooltip'),
          },
          McpServersPanelIcon,
        ),
      ),
    )

    // 2. Main slot page
    disposers.push(
      slots.inject('main', () =>
        slots.register(
          {
            name: 'main',
            key: MCP_SERVERS_PANEL_ID,
            inject: (): McpServersPanelPageProps => ({
              controller,
              api,
              cwd: resolveClientCwd(ctx),
            }),
          },
          McpServersPanelPage as never,
        ),
      ),
    )
  } catch (error) {
    console.warn('[dsh-mcp-adapter] panel registration failed:', error)
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Ignore individual dispose failure
      }
    }
  }
}
