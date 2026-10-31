import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

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
import { McpServersApiClient } from '../src/client/api.ts'
import { McpPanelController } from '../src/client/controller.ts'
import {
  apply,
  inject,
} from '../src/client/index.ts'
import {
  en,
  getActiveDictionary,
  NS,
  setRuntimeTranslate,
  tt,
  zh,
  type McpAdapterLocaleKey,
} from '../src/client/locales.ts'
import {
  MCP_SERVERS_PANEL_ID,
  McpServersPanelIcon,
  McpServersPanelPage,
  PANEL_ORDER,
  registerMcpServersPanel,
  resolveClientCwd,
} from '../src/client/native-panel.tsx'

describe('Native Slots & Panel Registration', () => {
  describe('Constants and Icon', () => {
    it('defines panel id and order', () => {
      expect(MCP_SERVERS_PANEL_ID).toBe('mcp-servers')
      expect(PANEL_ORDER).toBe(22)
    })

    it('renders McpServersPanelIcon with data-dsh-panel-entry attribute', () => {
      const html = renderToString(createElement(McpServersPanelIcon, { size: 20 }))
      expect(html).toContain('data-dsh-panel-entry="mcp-servers"')
      expect(html).toContain('width="20"')
      expect(html).toContain('height="20"')
      expect(html).toContain('<svg')
    })
  })

  describe('McpServersPanelPage', () => {
    it('renders page container with attributes', () => {
      const controller = new McpPanelController()
      const api = new McpServersApiClient(vi.fn())
      const html = renderToString(createElement(McpServersPanelPage, { controller, api, cwd: '/test/cwd' }))
      expect(html).toContain('data-dsh-mcp-servers-view')
      expect(html).toContain('data-dsh-plugin="mcp-adapter"')
    })
  })

  describe('registerMcpServersPanel', () => {
    it('injects sidebar.panellist and main slots, and returns disposer', () => {
      const injectedSeats: string[] = []
      const registeredOptions: Array<{ options: Record<string, unknown>; component: unknown }> = []
      const disposersCalled: string[] = []

      const mockCtx = {
        slots: {
          inject: (key: string, cb: () => () => void) => {
            injectedSeats.push(key)
            const unreg = cb()
            return () => {
              disposersCalled.push(`inject:${key}`)
              unreg?.()
            }
          },
          register: (options: Record<string, unknown>, component: unknown) => {
            registeredOptions.push({ options, component })
            return () => {
              disposersCalled.push(`register:${String(options.name || options.key)}`)
            }
          },
        },
      }

      const controller = new McpPanelController()
      const api = new McpServersApiClient(vi.fn())

      const dispose = registerMcpServersPanel(mockCtx as never, controller, api)
      expect(injectedSeats).toContain('sidebar.panellist')
      expect(injectedSeats).toContain('main')

      const sidebarReg = registeredOptions.find((r) => r.options.name === 'sidebar.panellist')
      expect(sidebarReg).toBeDefined()
      expect(sidebarReg?.options.id).toBe('mcp-servers')
      expect(sidebarReg?.options.order).toBe(22)
      expect(typeof (sidebarReg?.options.label as () => string)).toBe('function')
      expect(typeof (sidebarReg?.options.tooltip as () => string)).toBe('function')
      expect((sidebarReg?.options.label as () => string)()).toBe(tt('entry.label'))
      expect((sidebarReg?.options.tooltip as () => string)()).toBe(tt('entry.tooltip'))
      expect(sidebarReg?.component).toBe(McpServersPanelIcon)

      const mainReg = registeredOptions.find((r) => r.options.name === 'main')
      expect(mainReg).toBeDefined()
      expect(mainReg?.options.key).toBe('mcp-servers')
      expect(typeof (mainReg?.options.inject as () => unknown)).toBe('function')
      const injected = (mainReg?.options.inject as () => { controller: unknown; api: unknown })()
      expect(injected.controller).toBe(controller)
      expect(injected.api).toBe(api)

      // Test disposer
      dispose()
      expect(disposersCalled).toContain('inject:sidebar.panellist')
      expect(disposersCalled).toContain('inject:main')
    })
  })

  describe('locales & tt helper', () => {
    it('zh and en dictionaries have parity across all keys', () => {
      const zhKeys = Object.keys(zh).sort()
      const enKeys = Object.keys(en).sort()
      expect(zhKeys).toEqual(enKeys)
      expect(zhKeys.length).toBeGreaterThan(25)
    })

    it('includes required entry and management keys', () => {
      const requiredKeys: McpAdapterLocaleKey[] = [
        'entry.label',
        'entry.tooltip',
        'panel.title',
        'panel.subtitle',
        'scope.user',
        'scope.workspace',
        'action.create',
        'action.refresh',
        'action.probe',
        'action.probing',
        'action.edit',
        'action.delete',
        'action.save',
        'action.cancel',
        'search.placeholder',
        'empty.title',
        'field.name',
        'field.command',
        'field.url',
        'validation.name_required',
      ]
      for (const k of requiredKeys) {
        expect(zh[k], `zh missing ${k}`).toBeDefined()
        expect(en[k], `en missing ${k}`).toBeDefined()
      }
    })

    it('interpolates template parameters in tt()', () => {
      expect(tt('dialog.delete_confirm', { name: 'my-srv' })).toContain('my-srv')
    })

    it('supports runtime translate override and active dictionary resolution', () => {
      try {
        setRuntimeTranslate((key) => `mock-${String(key)}`)
        expect(tt('entry.label')).toBe('mock-entry.label')
      } finally {
        setRuntimeTranslate(undefined)
      }
      expect(getActiveDictionary()).toBeDefined()
    })

    it('switches to English when document.documentElement.lang is en', () => {
      const prevLang = document.documentElement.lang
      try {
        document.documentElement.lang = 'en'
        expect(tt('entry.label')).toBe('MCP Servers')
        expect(tt('editor.title_create')).toBe('New MCP Server')
        expect(tt('action.save')).toBe('Save')
        expect(tt('field.name')).toBe('Name')
        expect(tt('editor.json_label')).toBe('Configuration JSON')
      } finally {
        document.documentElement.lang = prevLang
      }
    })
  })

  describe('src/client/index.ts apply', () => {
    it('declares layout in inject list', () => {
      expect(inject).toContain('sessions')
      expect(inject).toContain('slots')
      expect(inject).toContain('locale')
      expect(inject).toContain('layout')
    })

    it('registers dictionaries, native slots, and preserves header actions', () => {
      let registeredNs = ''
      let registeredDicts: unknown
      const injectedKeys: string[] = []
      const registeredPanels: Array<Record<string, unknown>> = []

      const panelInfoSubscribers: Array<() => void> = []
      let activePanelId: string | null = null

      const mockCtx = {
        effect: (fn: () => (() => void) | void) => {
          return fn()
        },
        locale: {
          register: (ns: string, dicts: unknown) => {
            registeredNs = ns
            registeredDicts = dicts
            return () => {}
          },
          bind: () => (key: string) => key,
        },
        slots: {
          inject: (key: string, cb: () => () => void) => {
            injectedKeys.push(key)
            cb()
            return () => {}
          },
          register: (opts: Record<string, unknown>, _comp: unknown) => {
            registeredPanels.push(opts)
            return () => {}
          },
        },
        sessions: {},
        get: (name: string) => {
          if (name === 'layout') {
            return {
              selectPanel: vi.fn(),
              panelInfo: {
                getSnapshot: () => ({ activePanelId }),
                subscribe: (listener: () => void) => {
                  panelInfoSubscribers.push(listener)
                  return () => {}
                },
              },
            }
          }
          return undefined
        },
      }

      apply(mockCtx as never)

      expect(registeredNs).toBe(NS)
      expect(registeredDicts).toEqual({ zh, en })
      expect(injectedKeys).toContain('conversation.session.header.actions')
      expect(injectedKeys).toContain('sidebar.panellist')
      expect(injectedKeys).toContain('main')

      // Header actions still registered
      const headerReg = registeredPanels.find((p) => p.name === 'conversation.session.header.actions')
      expect(headerReg).toBeDefined()
      expect(headerReg?.id).toBe('mcp-adapter')

      // Sidebar panel registered
      const sidebarReg = registeredPanels.find((p) => p.name === 'sidebar.panellist')
      expect(sidebarReg).toBeDefined()
      expect(sidebarReg?.id).toBe('mcp-servers')

      // Main slot registered
      const mainReg = registeredPanels.find((p) => p.name === 'main')
      expect(mainReg).toBeDefined()
      expect(mainReg?.key).toBe('mcp-servers')
    })
  })
})

describe('resolveClientCwd', () => {
  it('reads the main-view session directory from the real sessions service', () => {
    // The service DSH actually registers is `sessions`; the first version read a `workspace`
    // service that does not exist, so this returned '' in every real composition.
    const ctx = {
      get: (name: string) => {
        if (name !== 'sessions') return undefined
        return {
          list: {
            getSnapshot: () => ({
              ids: ['other', 'main'],
              byId: {
                other: { cwd: 'D:/elsewhere', retainedBy: {} },
                main: { cwd: 'D:/work/learn-llm-agent', retainedBy: { mainView: 1 } },
              },
            }),
          },
        }
      },
    }
    expect(resolveClientCwd(ctx)).toBe('D:/work/learn-llm-agent')
  })

  it('falls back to the first registered workspace, then to empty', () => {
    const withWorkspaces = {
      get: (name: string) =>
        name === 'workspaces'
          ? { list: { getSnapshot: () => ({ items: [{ path: 'D:/work/creator' }] }) } }
          : undefined,
    }
    expect(resolveClientCwd(withWorkspaces)).toBe('D:/work/creator')
    expect(resolveClientCwd({ get: () => undefined })).toBe('')
  })

  it('survives a context whose service reads throw', () => {
    expect(() => resolveClientCwd({ get: () => { throw new Error('no inject') } })).not.toThrow()
    expect(resolveClientCwd({ get: () => { throw new Error('no inject') } })).toBe('')
  })
})
