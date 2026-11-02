import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServersApiClient } from '../src/client/api.ts'
import { McpPanelController } from '../src/client/controller.ts'
import { McpMarketPanel } from '../src/client/panel/McpMarketPanel.tsx'
import { ServersListTab } from '../src/client/panel/ServersListTab.tsx'
import type { ExternalMcpScanResult, McpCatalogEntry, McpServerDetail } from '../src/types.ts'

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

const mockCatalog: McpCatalogEntry[] = [
  {
    id: 'memory',
    name: 'Memory',
    description: 'Knowledge graph for memory',
    categories: ['productivity'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation via Playwright',
    categories: ['web'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub repositories and issues',
    categories: ['devtools'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnv: [
      {
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        description: 'GitHub token',
      },
    ],
  },
]

const sampleServers: McpServerDetail[] = [
  {
    name: 'memory',
    scope: 'user',
    category: 'productivity',
    transport: 'stdio',
    status: 'ready',
    description: 'Existing memory server',
  },
  {
    name: 'tavily',
    scope: 'user',
    category: 'web',
    transport: 'http',
    url: 'https://mcp.tavily.com/mcp',
    status: 'ready',
    description: 'Tavily search',
  },
]

const mockScanResult: ExternalMcpScanResult = {
  candidates: [
    {
      source: 'cursor-global',
      sourcePath: '/path/cursor/mcp.json',
      id: 'scanned_tool',
      rawKey: 'scanned_tool',
      transport: 'stdio',
      command: 'node',
      args: ['run.js'],
    },
    {
      source: 'claude-desktop',
      sourcePath: '/path/claude/config.json',
      id: 'memory', // duplicate
      rawKey: 'memory',
      transport: 'stdio',
    },
  ],
  sources: [
    { kind: 'cursor-global', path: '/path/cursor/mcp.json', exists: true, count: 1 },
  ],
}

function createMockApi(): McpServersApiClient {
  return {
    getServers: vi.fn().mockResolvedValue({
      servers: sampleServers,
      workspaceRoot: '/mock/workspace',
      workspaces: [{ path: '/mock/workspace', title: 'default' }],
    }),
    getCatalog: vi.fn().mockResolvedValue({ catalog: mockCatalog }),
    installPreset: vi.fn().mockResolvedValue({ ok: true, serverName: 'Test' }),
    toggleServer: vi.fn().mockResolvedValue({ ok: true, enabled: false }),
    scanExternal: vi.fn().mockResolvedValue(mockScanResult),
    importExternal: vi.fn().mockResolvedValue({ ok: true, importedCount: 1, errors: [] }),
    probeServer: vi.fn().mockResolvedValue({ ok: true, latencyMs: 20 }),
    deleteServer: vi.fn().mockResolvedValue({ ok: true }),
    migrateScope: vi.fn().mockResolvedValue({ ok: true }),
    saveServer: vi.fn().mockResolvedValue({ ok: true }),
    approveServer: vi.fn().mockResolvedValue({ ok: true }),
    getPresets: vi.fn().mockResolvedValue({ presets: [] }),
  } as unknown as McpServersApiClient
}

describe('McpMarketPanel', () => {
  it('renders catalog items and filters by category', async () => {
    const controller = new McpPanelController()
    const api = createMockApi()

    renderComponent(createElement(McpMarketPanel, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.getCatalog).toHaveBeenCalled()

    // 3 cards initially
    const cards = container?.querySelectorAll('[data-market-card]')
    expect(cards?.length).toBe(3)

    // Category click: web
    const webBtn = container?.querySelector('[data-category="web"]') as HTMLButtonElement
    expect(webBtn).toBeTruthy()
    act(() => {
      webBtn.click()
    })

    const filteredCards = container?.querySelectorAll('[data-market-card]')
    expect(filteredCards?.length).toBe(1)
    expect(container?.querySelector('[data-market-card="playwright"]')).toBeTruthy()
  })

  it('performs zero-config direct installation for memory server', async () => {
    const controller = new McpPanelController()
    const api = createMockApi()

    renderComponent(createElement(McpMarketPanel, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    // Click install on playwright
    const installBtn = container?.querySelector('[data-market-install="playwright"]') as HTMLButtonElement
    expect(installBtn).toBeTruthy()

    await act(async () => {
      installBtn.click()
      await Promise.resolve()
    })

    expect(api.installPreset).toHaveBeenCalledWith({
      presetId: 'playwright',
      scope: 'user',
      cwd: undefined,
      envOverrides: undefined,
    })
  })

  it('opens interactive parameter dialog when server requires environment variables', async () => {
    const controller = new McpPanelController()
    const api = createMockApi()

    renderComponent(createElement(McpMarketPanel, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    // Click install on GitHub
    const installBtn = container?.querySelector('[data-market-install="github"]') as HTMLButtonElement
    act(() => {
      installBtn.click()
    })

    // Dialog should appear
    const confirmBtn = container?.querySelector('[data-confirm-install]') as HTMLButtonElement
    expect(confirmBtn).toBeTruthy()

    await act(async () => {
      confirmBtn.click()
      await Promise.resolve()
    })

    expect(api.installPreset).toHaveBeenCalledWith({
      presetId: 'github',
      scope: 'user',
      cwd: undefined,
      envOverrides: expect.any(Object),
    })
  })
})

describe('ServersListTab - Toggle and Scan Workbench', () => {
  it('triggers optimistic toggle and calls api.toggleServer', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi()

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const toggle = container?.querySelector('[data-server-toggle="memory"] input') as HTMLInputElement
    expect(toggle).toBeTruthy()
    expect(toggle.checked).toBe(true)

    await act(async () => {
      toggle.click()
      await Promise.resolve()
    })

    expect(api.toggleServer).toHaveBeenCalledWith({
      name: 'memory',
      scope: 'user',
      cwd: undefined,
      enabled: false,
    })
  })

  it('opens scan workbench, lists candidates and batch imports selected', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi()

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const scanBtn = container?.querySelector('[data-action="scan"]') as HTMLButtonElement
    expect(scanBtn).toBeTruthy()

    await act(async () => {
      scanBtn.click()
      await Promise.resolve()
    })

    expect(api.scanExternal).toHaveBeenCalled()
    expect(container?.querySelector('[data-scan-workbench]')).toBeTruthy()

    const importBatchBtn = container?.querySelector('[data-action="batch-import"]') as HTMLButtonElement
    expect(importBatchBtn).toBeTruthy()

    await act(async () => {
      importBatchBtn.click()
      await Promise.resolve()
    })

    expect(api.importExternal).toHaveBeenCalledWith({
      items: expect.arrayContaining([expect.objectContaining({ id: 'scanned_tool' })]),
      scope: 'user',
      cwd: undefined,
    })
  })

  it('renders card glyph, monospace endpoint code, and handles scan 404 with friendly restart hint', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi()
    ;(api.scanExternal as any).mockRejectedValueOnce(new Error('Request failed with status 404: Not Found'))

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    // Check glyph box
    const card = container?.querySelector('[data-server-card="memory"]')
    expect(card).toBeTruthy()
    const glyphSvg = card?.querySelector('svg')
    expect(glyphSvg).toBeTruthy()

    // Check action controls exist
    expect(card?.querySelector('[data-action="edit"]')).toBeTruthy()
    expect(card?.querySelector('[data-action="more"]')).toBeTruthy()
    expect(card?.querySelector('[data-server-toggle="memory"]')).toBeTruthy()

    // Click scan to trigger 404
    const scanBtn = container?.querySelector('[data-action="scan"]') as HTMLButtonElement
    await act(async () => {
      scanBtn.click()
      await Promise.resolve()
    })

    // Check friendly restart hint is rendered in banner
    const banner = container?.querySelector('[class*="bannerError"]')
    expect(banner?.textContent).toContain('重启 DSH')
  })

  // The bug this pins shipped because every test used `.click()`. A browser fires `mousedown`
  // first, and the panel's outside-press handler used to unmount the menu on it, so the following
  // `click` never reached the item and all five menu actions were silently dead.
  //
  // The two events must be flushed in separate `act` calls: batched together, React renders once
  // at the end and the detached button still runs its handler, which hides the bug.
  it('runs a menu item when a real mousedown precedes the click', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi()

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const moreBtn = container?.querySelector('[data-server-card="memory"] [data-action="more"]') as HTMLButtonElement
    await act(async () => {
      moreBtn.click()
    })

    const probeBtn = container?.querySelector('[data-action="menu-probe"]') as HTMLButtonElement
    expect(probeBtn).toBeTruthy()

    await act(async () => {
      probeBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    // A press inside the menu must leave it mounted; otherwise the next click lands on nothing.
    expect(container?.querySelector('[data-action="menu-probe"]')).toBeTruthy()

    const stillThere = container?.querySelector('[data-action="menu-probe"]') as HTMLButtonElement
    await act(async () => {
      stillThere.click()
      await Promise.resolve()
    })

    expect(api.probeServer).toHaveBeenCalled()
  })

  it('disarms the delete item after the arming window closes', async () => {
    vi.useFakeTimers()
    try {
      const controller = new McpPanelController({ scope: 'user' })
      const api = createMockApi()

      renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
      await act(async () => {
        await Promise.resolve()
      })

      const moreBtn = container?.querySelector('[data-server-card="memory"] [data-action="more"]') as HTMLButtonElement
      await act(async () => {
        moreBtn.click()
      })

      const removeBtn = container?.querySelector('[data-action="menu-remove"]') as HTMLButtonElement
      act(() => {
        removeBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        removeBtn.click()
      })
      expect(removeBtn.textContent).toContain('确认移除？')

      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(removeBtn.textContent).toContain('移除')
      expect(api.deleteServer).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('implements two-step arming for deletion in more options menu', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi()

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    // Open more menu on memory card
    const moreBtn = container?.querySelector('[data-server-card="memory"] [data-action="more"]') as HTMLButtonElement
    expect(moreBtn).toBeTruthy()
    await act(async () => {
      moreBtn.click()
      await Promise.resolve()
    })

    const removeBtn = container?.querySelector('[data-action="menu-remove"]') as HTMLButtonElement
    expect(removeBtn).toBeTruthy()
    expect(removeBtn.textContent).toContain('移除')

    // Step 1: First click arms the button
    await act(async () => {
      removeBtn.click()
      await Promise.resolve()
    })

    expect(removeBtn.textContent).toContain('确认移除？')
    expect(api.deleteServer).not.toHaveBeenCalled()

    // Step 2: Second click executes deletion
    await act(async () => {
      removeBtn.click()
      await Promise.resolve()
    })

    expect(api.deleteServer).toHaveBeenCalledWith({
      scope: 'user',
      cwd: undefined,
      name: 'memory',
    })
  })

  it('triggers scope migration from more options menu', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi()

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    const moreBtn = container?.querySelector('[data-server-card="memory"] [data-action="more"]') as HTMLButtonElement
    await act(async () => {
      moreBtn.click()
      await Promise.resolve()
    })

    const migrateBtn = container?.querySelector('[data-action="menu-migrate"]') as HTMLButtonElement
    expect(migrateBtn).toBeTruthy()

    await act(async () => {
      migrateBtn.click()
      await Promise.resolve()
    })

    expect(api.migrateScope).toHaveBeenCalledWith({
      name: 'memory',
      fromScope: 'user',
      toScope: 'workspace',
      cwd: '/mock/workspace',
    })
  })

  it('opens HTTP quick authorization dialog, saves token and probes connection', async () => {
    const controller = new McpPanelController({ scope: 'user' })
    const api = createMockApi()

    renderComponent(createElement(ServersListTab, { controller, api, cwd: '/mock/workspace' }))
    await act(async () => {
      await Promise.resolve()
    })

    // Open more menu on tavily (HTTP server)
    const moreBtn = container?.querySelector('[data-server-card="tavily"] [data-action="more"]') as HTMLButtonElement
    expect(moreBtn).toBeTruthy()
    await act(async () => {
      moreBtn.click()
      await Promise.resolve()
    })

    const authBtn = container?.querySelector('[data-action="menu-auth"]') as HTMLButtonElement
    expect(authBtn).toBeTruthy()
    await act(async () => {
      authBtn.click()
      await Promise.resolve()
    })

    // Dialog opens
    const tokenInput = container?.querySelector('input[type="password"]') as HTMLInputElement
    expect(tokenInput).toBeTruthy()

    await act(async () => {
      setInputValue(tokenInput, 'tvly-secret-key')
      await Promise.resolve()
    })

    const saveBtn = container?.querySelector('[class*="dialogFooter"] button[class*="primaryButton"]') as HTMLButtonElement
    expect(saveBtn).toBeTruthy()

    await act(async () => {
      saveBtn.click()
      await Promise.resolve()
    })

    expect(api.saveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'tavily',
        server: expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer tvly-secret-key',
          }),
        }),
      }),
    )
    expect(api.probeServer).toHaveBeenCalled()
  })
})
