/**
 * Browser-half entry for dsh-mcp-adapter — runs inside the dsh web GUI.
 *
 * It registers:
 * 1. This panel's locale dictionaries.
 * 2. The native sidebar panel list entry (`sidebar.panellist`) and main slot page (`main`).
 * 3. The conversation-header action that renders {@link McpPanel} (preserved for backwards compatibility).
 *
 * Export discipline (packages/client rule): the /client surface carries what cordis loading needs —
 * `inject` and `apply` — and types only.
 *
 * @module dsh-mcp-adapter/client
 */

import type { ReactElement } from 'react'
import { McpServersApiClient } from './api.ts'
import { McpPanelController } from './controller.ts'
import { en, NS, setRuntimeTranslate, zh, type McpAdapterLocaleKey } from './locales.ts'
import { McpPanel, type McpPanelProps } from './McpPanel.tsx'
import {
  MCP_SERVERS_PANEL_ID,
  McpServersPanelIcon,
  registerMcpServersPanel,
} from './native-panel.tsx'

export { MCP_SERVERS_PANEL_ID, McpServersPanelIcon }
export type { McpAdapterLocaleKey } from './locales.ts'
export type { McpPanelProps } from './McpPanel.tsx'

/**
 * Structural typing for the client context with injected services.
 */
interface ClientContext {
  /** Cordis effect: the returned disposer rides this plugin's fiber. */
  effect: (execute: () => (() => void) | void, label?: string) => unknown
  locale: {
    register: (ns: string, dictionaries: Record<'zh' | 'en', Record<McpAdapterLocaleKey, string>>) => () => void
    bind?: (ns: string) => (key: McpAdapterLocaleKey, values?: Record<string, string | number>) => string
  }
  slots: {
    inject: (key: string, callback: () => () => void) => () => void
    register: (
      options: Record<string, unknown>,
      component: unknown,
    ) => () => void
  }
  sessions?: McpPanelProps['sessions']
  get?: (name: string, required?: boolean) => unknown
}

/** Required browser services: the Session store, slots, localized copy, and layout. */
export const inject = ['sessions', 'slots', 'locale', 'layout']

/**
 * Register the dictionaries, native sidebar panel & main page, and conversation-header action.
 *
 * @param ctx - client root context carrying the injected services.
 */
export function apply(ctx: ClientContext): void {
  // 1. Dictionaries
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'dsh-mcp-adapter: dictionaries')

  // Wire runtime translation
  try {
    if (typeof ctx.locale?.bind === 'function') {
      setRuntimeTranslate(ctx.locale.bind(NS))
    }
  } catch {
    // fallback to document.documentElement.lang
  }

  const disposers: Array<() => void> = []

  // 2. Conversation-header action (preserved for backwards compatibility)
  try {
    const sessions = ctx.sessions
    if (ctx.slots?.inject) {
      disposers.push(
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'mcp-adapter',
              order: 20,
              locale: NS,
              inject: () => ({ sessions }),
            },
            McpPanel as (props: McpPanelProps) => ReactElement,
          ),
        ),
      )
    }
  } catch (err) {
    console.warn('[dsh-mcp-adapter] header action registration failed:', err)
  }

  // 3. Native sidebar panel and main workspace view
  try {
    const api = new McpServersApiClient()
    const controller = new McpPanelController()
    disposers.push(registerMcpServersPanel(ctx, controller, api))

    // Reconcile layout active panel into the controller
    const layoutFace = (ctx as unknown as { get?(name: string, req?: boolean): unknown }).get?.('layout', false) as
      | { panelInfo?: { subscribe(listener: () => void): () => void; getSnapshot(): { activePanelId: unknown } } }
      | undefined
    if (layoutFace?.panelInfo !== undefined) {
      const sync = (): void => {
        const active = layoutFace.panelInfo!.getSnapshot().activePanelId
        controller.syncPanelSelection(active === MCP_SERVERS_PANEL_ID ? MCP_SERVERS_PANEL_ID : null)
      }
      sync()
      disposers.push(layoutFace.panelInfo.subscribe(sync))
    }
  } catch (err) {
    console.warn('[dsh-mcp-adapter] native panel registration failed:', err)
  }

  ctx.effect(
    () => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.()
        } catch {
          // silent cleanup
        }
      }
    },
    'dsh-mcp-adapter: ui mounts',
  )
}
