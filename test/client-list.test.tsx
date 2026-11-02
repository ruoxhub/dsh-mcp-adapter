import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServersApiClient } from '../src/client/api.ts'
import { McpPanelController } from '../src/client/controller.ts'
import { ServersListTab } from '../src/client/panel/ServersListTab.tsx'
import { McpServersPage } from '../src/client/panel/McpServersPage.tsx'
import type { McpServerDetail, ProbeResult } from '../src/types.ts'

let container: HTMLDivElement | undefined
let root: Root | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  container = undefined
  root = undefined
})

function renderComponent(element: React.ReactElement): void {
  act(() => {
    root?.render(element)
  })
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  descriptor?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function createMockApi(initialServers: McpServerDetail[] = []): McpServersApiClient {
  let servers = [...initialServers]
  return {
    getServers: vi.fn().mockImplementation(async (params?: { cwd?: string; scope?: string }) => {
      const filtered = params?.scope
        ? servers.filter((s) => s.scope === params.scope)
        : servers
      return {
        servers: filtered,
        workspaceRoot: '/mock/workspace',
        workspaces: [{ path: '/mock/workspace', title: 'default' }],
      }
    }),
    saveServer: vi.fn().mockResolvedValue({ ok: true }),
    deleteServer: vi.fn().mockImplementation(async (payload: { scope: string; name: string }) => {
      servers = servers.filter((s) => s.name !== payload.name)
      return { ok: true }
    }),
    approveServer: vi.fn().mockResolvedValue({ ok: true }),
    probeServer: vi.fn().mockResolvedValue({ ok: true, latencyMs: 38 } satisfies ProbeResult),
    getPresets: vi.fn().mockResolvedValue({ presets: [] }),
    installPreset: vi.fn().mockResolvedValue({ ok: true, path: '/mock/workspace/.mcp.json', serverName: 'Preset' }),
  } as unknown as McpServersApiClient
}

const sampleServers: McpServerDetail[] = [
  {
    name: 'browser_tools',
    scope: 'user',
    category: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'browser-server'],
    status: 'ready',
    description: 'Browser automation tools for web navigation',
  },
  {
    name: 'computer_control',
    scope: 'user',
    category: 'system',
    transport: 'stdio',
    command: 'node',
    args: ['dist/system.js'],
    status: 'idle',
    description: 'Computer use and screen capture control',
  },
  {
    name: 'doc_reader',
    scope: 'workspace',
    category: 'document',
    transport: 'stdio',
    command: 'python',
    args: ['-m', 'doc_reader'],
    status: 'blocked',
    description: 'Document extraction and parsing',
  },
]

describe('McpServersPage', () => {
  it('renders ServersListTab when controller viewMode is list', async () => {
    const controller = new McpPanelController({ viewMode: 'list' })
    const api = createMockApi(sampleServers)

    renderComponent(createElement(McpServersPage, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const title = container?.querySelector('[data-page-title]')
    expect(title?.textContent).toBe('MCP 服务器')
    expect(container?.querySelector('[data-view="list"]')).toBeTruthy()
    expect(container?.querySelector('[data-view="editor"]')).toBeFalsy()
  })

  it('renders ServerEditorTab when controller viewMode is editor', async () => {
    const controller = new McpPanelController({ viewMode: 'editor' })
    const api = createMockApi(sampleServers)

    renderComponent(createElement(McpServersPage, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    // The sheet floats over the list it was opened from rather than replacing it.
    expect(container?.querySelector('[role="dialog"]')).toBeTruthy()
    expect(container?.querySelector('[data-view="list"]')).toBeTruthy()
  })
})

describe('ServersListTab', () => {
  it('renders header with title, scope selector button and count badge', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const title = container?.querySelector('[data-page-title]')
    expect(title?.textContent).toBe('MCP 服务器')

    const scopeButton = container?.querySelector('[data-scope-dropdown-trigger]')
    expect(scopeButton?.textContent).toContain('电脑 用户')

    const badge = container?.querySelector('[data-badge-count]')
    expect(badge?.textContent).toMatch(/MCP\s+2/)
  })

  it('opens scope popover when clicking scope button, and switches scope to workspace', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const scopeButton = container?.querySelector('[data-scope-dropdown-trigger]') as HTMLButtonElement
    expect(scopeButton).toBeTruthy()

    act(() => {
      scopeButton.click()
    })

    const popover = container?.querySelector('[data-scope-popover]')
    expect(popover).toBeTruthy()

    const workspaceItem = container?.querySelector('[data-scope-item="workspace"]') as HTMLElement
    expect(workspaceItem).toBeTruthy()
    expect(workspaceItem.textContent).toContain('default')

    await act(async () => {
      workspaceItem.click()
    })

    expect(controller.getSnapshot().scope).toBe('workspace')
    expect(container?.querySelector('[data-scope-popover]')).toBeFalsy()
  })

  it('filters servers by search query and updates controller.searchQuery', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const searchInput = container?.querySelector('input[data-search-input]') as HTMLInputElement
    expect(searchInput).toBeTruthy()
    expect(searchInput.placeholder).toContain('搜索 MCP 服务器')

    act(() => {
      setInputValue(searchInput, 'browser')
    })

    expect(controller.getSnapshot().searchQuery).toBe('browser')

    const cardNames = Array.from(container?.querySelectorAll('[data-server-name]') || []).map(
      (el) => el.textContent?.trim(),
    )
    expect(cardNames).toContain('browser_tools')
    expect(cardNames).not.toContain('computer_control')
  })

  it('refresh button reloads server list from api', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.getServers).toHaveBeenCalledTimes(1)

    const refreshButton = container?.querySelector('[data-action="refresh"]') as HTMLButtonElement
    expect(refreshButton).toBeTruthy()

    await act(async () => {
      refreshButton.click()
    })

    expect(api.getServers).toHaveBeenCalledTimes(2)
  })

  it('add button calls controller.openCreate', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)
    vi.spyOn(controller, 'openCreate')

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const createButton = container?.querySelector('[data-action="create"]') as HTMLButtonElement
    expect(createButton).toBeTruthy()
    expect(createButton.textContent).toContain('新建')

    act(() => {
      createButton.click()
    })

    expect(controller.openCreate).toHaveBeenCalledWith('user')
  })

  it('renders dashed empty state card when there are no servers', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi([]) // no servers

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const emptyCard = container?.querySelector('[data-empty-guide-card]')
    expect(emptyCard).toBeTruthy()
    expect(emptyCard?.textContent).toContain('尚未安装 MCP 服务器')
    expect(emptyCard?.textContent).toContain('手动新建服务器，或导入已有配置。')

    const createBtn = container?.querySelector('[data-empty-action="create"]') as HTMLButtonElement
    expect(createBtn).toBeTruthy()
    expect(createBtn.textContent).toContain('新建 MCP 服务器')

    const importBtn = container?.querySelector('[data-empty-action="import"]') as HTMLButtonElement
    expect(importBtn).toBeTruthy()
    expect(importBtn.textContent).toContain('导入')

    act(() => {
      importBtn.click()
    })

    const snap = controller.getSnapshot()
    expect(snap.viewMode).toBe('editor')
    expect(snap.editorMode).toBe('json')
  })

  it('groups servers by category with headers and counts', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const groupHeaders = Array.from(container?.querySelectorAll('[data-group-header]') || []).map(
      (el) => el.textContent?.trim(),
    )
    expect(groupHeaders).toContain('浏览器操作 1')
    expect(groupHeaders).toContain('电脑控制 1')
  })

  it('renders server card details with status indicator dot and description', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const browserCard = container?.querySelector('[data-server-card="browser_tools"]')
    expect(browserCard).toBeTruthy()

    const statusDot = browserCard?.querySelector('[data-status-dot]')
    expect(statusDot).toBeTruthy()
    expect(statusDot?.getAttribute('data-status')).toBe('ready')

    const desc = browserCard?.querySelector('[data-server-desc]')
    expect(desc?.textContent).toContain('Browser automation tools')
  })

  it('edit action button opens controller.openEdit with the server', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)
    vi.spyOn(controller, 'openEdit')

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const editBtn = container?.querySelector(
      '[data-server-card="browser_tools"] [data-action="edit"]',
    ) as HTMLButtonElement
    expect(editBtn).toBeTruthy()

    act(() => {
      editBtn.click()
    })

    expect(controller.openEdit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'browser_tools' }),
    )
  })

  it('probe action tests connection and shows probe result', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const probeBtn = container?.querySelector(
      '[data-server-card="browser_tools"] [data-action="probe"]',
    ) as HTMLButtonElement
    expect(probeBtn).toBeTruthy()

    await act(async () => {
      probeBtn.click()
    })

    expect(api.probeServer).toHaveBeenCalled()

    const probeFeedback = container?.querySelector(
      '[data-server-card="browser_tools"] [data-probe-result]',
    )
    expect(probeFeedback).toBeTruthy()
    expect(probeFeedback?.textContent).toContain('38ms')
  })

  it('delete action calls api.deleteServer and removes server', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const deleteBtn = container?.querySelector(
      '[data-server-card="browser_tools"] [data-action="delete"]',
    ) as HTMLButtonElement
    expect(deleteBtn).toBeTruthy()

    await act(async () => {
      deleteBtn.click()
    })

    expect(api.deleteServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'browser_tools', scope: 'user' }),
    )
  })

  it('blocked server shows approve button and calls api.approveServer', async () => {
    const controller = new McpPanelController({ scope: 'workspace' })
    const api = createMockApi(sampleServers)

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const docCard = container?.querySelector('[data-server-card="doc_reader"]')
    expect(docCard).toBeTruthy()

    const statusDot = docCard?.querySelector('[data-status-dot]')
    expect(statusDot?.getAttribute('data-status')).toBe('blocked')

    const approveBtn = docCard?.querySelector('[data-action="approve"]') as HTMLButtonElement
    expect(approveBtn).toBeTruthy()
    expect(approveBtn.textContent).toContain('批准')

    await act(async () => {
      approveBtn.click()
    })

    expect(api.approveServer).toHaveBeenCalledWith({
      cwd: '/mock/workspace',
      name: 'doc_reader',
    })
  })
})

describe('ServersListTab workspace sync', () => {
  /** Two projects, each with its own .mcp.json, served the way the real route does. */
  function createWorkspaceApi(): McpServersApiClient {
    const byName: Record<string, McpServerDetail[]> = {
      '/ws/alpha': [
        { name: 'alpha_tool', scope: 'workspace', category: 'custom', transport: 'stdio', command: 'node', status: 'ready' },
      ],
      '/ws/beta': [
        { name: 'beta_tool', scope: 'workspace', category: 'custom', transport: 'stdio', command: 'node', status: 'ready' },
      ],
    }
    return {
      getServers: vi.fn().mockImplementation(async (params?: { cwd?: string; scope?: string }) => {
        const cwd = params?.cwd ?? '/ws/alpha'
        return {
          servers: byName[cwd] ?? [],
          workspaceRoot: cwd,
          workspaces: [
            { path: '/ws/alpha', title: 'alpha' },
            { path: '/ws/beta', title: 'beta' },
          ],
        }
      }),
      saveServer: vi.fn().mockResolvedValue({ ok: true }),
      deleteServer: vi.fn().mockResolvedValue({ ok: true }),
      approveServer: vi.fn().mockResolvedValue({ ok: true }),
      probeServer: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 } satisfies ProbeResult),
    } as unknown as McpServersApiClient
  }

  it('lists every registered workspace in the scope menu', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createWorkspaceApi()

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/ws/alpha' }))
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      ;(container?.querySelector('[data-scope-dropdown-trigger]') as HTMLButtonElement).click()
    })

    const items = Array.from(container?.querySelectorAll('[data-scope-item="workspace"]') ?? [])
    expect(items.map((el) => el.getAttribute('data-scope-path'))).toEqual(['/ws/alpha', '/ws/beta'])
  })

  it('reads the .mcp.json of the workspace picked in the menu', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createWorkspaceApi()

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/ws/alpha' }))
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      ;(container?.querySelector('[data-scope-dropdown-trigger]') as HTMLButtonElement).click()
    })
    const beta = container?.querySelector('[data-scope-path="/ws/beta"]') as HTMLElement
    await act(async () => {
      beta.click()
      await Promise.resolve()
    })

    expect(controller.getSnapshot().workspacePath).toBe('/ws/beta')
    expect(controller.getSnapshot().scope).toBe('workspace')
    expect(api.getServers).toHaveBeenLastCalledWith({ cwd: '/ws/beta', scope: 'workspace' })
    expect(container?.querySelector('[data-server-name]')?.textContent).toBe('beta_tool')
    expect(container?.querySelector('[data-scope-dropdown-trigger]')?.textContent).toContain('beta')
  })

  it('opens presets drawer and installs preset when clicked', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi(sampleServers)
    api.getPresets = vi.fn().mockResolvedValue({
      presets: [
        { id: 'github', name: 'GitHub', summary: 'GitHub MCP', category: 'system' },
      ],
    })
    api.installPreset = vi.fn().mockResolvedValue({ ok: true, serverName: 'GitHub' })

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const presetsBtn = container?.querySelector('[data-action="presets"]') as HTMLButtonElement
    expect(presetsBtn).not.toBeNull()

    await act(async () => {
      presetsBtn.click()
      await Promise.resolve()
    })

    expect(api.getPresets).toHaveBeenCalled()
    expect(container?.querySelector('[data-presets-section]')).not.toBeNull()
    expect(container?.querySelector('[data-preset-card="github"]')).not.toBeNull()

    const installBtn = container?.querySelector('[data-install-preset="github"]') as HTMLButtonElement
    await act(async () => {
      installBtn.click()
      await Promise.resolve()
    })

    expect(api.installPreset).toHaveBeenCalledWith({
      presetId: 'github',
      scope: 'user',
      cwd: '/mock/workspace',
    })
  })
})
