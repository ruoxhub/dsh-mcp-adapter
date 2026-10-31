import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServersApiClient } from '../src/client/api.ts'
import { McpPanelController, type ServerDraft } from '../src/client/controller.ts'
import { ServerFormView } from '../src/client/panel/ServerFormView.tsx'
import { ServerJsonView } from '../src/client/panel/ServerJsonView.tsx'
import { ServerEditorTab } from '../src/client/panel/ServerEditorTab.tsx'

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

describe('ServerFormView', () => {
  const initialDraft: ServerDraft = {
    name: '',
    scope: 'user',
    transport: 'stdio',
    command: '',
    args: '',
    url: '',
    headers: [],
    timeoutMs: 30000,
    protocolVersion: '',
    env: [],
    rawJson: '',
  }

  it('renders stdio form fields with correct placeholders and default values', () => {
    const onChange = vi.fn()
    renderComponent(createElement(ServerFormView, { draft: initialDraft, onChange }))

    const nameInput = container?.querySelector('input[placeholder="my-mcp-server"]') as HTMLInputElement
    expect(nameInput).toBeTruthy()
    expect(nameInput.value).toBe('')

    const transportSelect = container?.querySelector('select[data-field="transport"]') as HTMLSelectElement
    expect(transportSelect).toBeTruthy()
    expect(transportSelect.value).toBe('stdio')

    const timeoutInput = container?.querySelector('input[data-field="timeoutMs"]') as HTMLInputElement
    expect(timeoutInput).toBeTruthy()
    expect(timeoutInput.value).toBe('30000')

    const protocolSelect = container?.querySelector('select[data-field="protocolVersion"]') as HTMLSelectElement
    expect(protocolSelect).toBeTruthy()

    const commandInput = container?.querySelector('input[placeholder="npx"]') as HTMLInputElement
    expect(commandInput).toBeTruthy()

    const argsInput = container?.querySelector('input[placeholder="-y @modelcontextprotocol/server-memory"]') as HTMLInputElement
    expect(argsInput).toBeTruthy()
  })

  it('fires onChange when form inputs are modified', () => {
    const onChange = vi.fn()
    renderComponent(createElement(ServerFormView, { draft: initialDraft, onChange }))

    const nameInput = container?.querySelector('input[placeholder="my-mcp-server"]') as HTMLInputElement
    act(() => {
      setInputValue(nameInput, 'test-server')
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'test-server' }))

    const commandInput = container?.querySelector('input[placeholder="npx"]') as HTMLInputElement
    act(() => {
      setInputValue(commandInput, 'node')
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ command: 'node' }))
  })

  it('switches between stdio fields and http/sse fields', () => {
    const onChange = vi.fn()
    const httpDraft: ServerDraft = {
      ...initialDraft,
      transport: 'http',
      url: 'http://localhost:3000/sse',
    }
    renderComponent(createElement(ServerFormView, { draft: httpDraft, onChange }))

    expect(container?.querySelector('input[placeholder="npx"]')).toBeNull()
    const urlInput = container?.querySelector('input[placeholder="http://localhost:3000/sse"]') as HTMLInputElement
    expect(urlInput).toBeTruthy()
    expect(urlInput.value).toBe('http://localhost:3000/sse')
  })

  it('supports adding and editing headers for http/sse transports', () => {
    const onChange = vi.fn()
    const httpDraft: ServerDraft = {
      ...initialDraft,
      transport: 'http',
      url: 'http://localhost:3000/sse',
      headers: [{ key: 'Authorization', value: 'Bearer token' }],
    }
    renderComponent(createElement(ServerFormView, { draft: httpDraft, onChange }))

    const toggleHeaders = container?.querySelector('[data-headers-toggle]') as HTMLButtonElement
    expect(toggleHeaders).toBeTruthy()
    act(() => {
      toggleHeaders.click()
    })

    const headerKeyInput = (container?.querySelector('input[data-header-key="0"]') || container?.querySelector('input[placeholder="Header Name"]')) as HTMLInputElement
    expect(headerKeyInput).toBeTruthy()
    expect(headerKeyInput.value).toBe('Authorization')

    act(() => {
      setInputValue(headerKeyInput, 'X-Custom-Auth')
    })
    expect(onChange).toHaveBeenCalledWith({
      headers: [{ key: 'X-Custom-Auth', value: 'Bearer token' }],
    })
  })

  it('toggles environment variables accordion and supports adding/removing rows', () => {
    const onChange = vi.fn()
    const draftWithEnv: ServerDraft = {
      ...initialDraft,
      env: [{ key: 'API_KEY', value: 'secret123' }],
    }
    renderComponent(createElement(ServerFormView, { draft: draftWithEnv, onChange }))

    // Expand accordion if not expanded
    const toggleButton = container?.querySelector('[data-env-toggle]') as HTMLButtonElement
    expect(toggleButton).toBeTruthy()
    act(() => {
      toggleButton.click()
    })

    const keyInput = container?.querySelector('input[data-env-key="0"]') as HTMLInputElement
    expect(keyInput?.value).toBe('API_KEY')

    // Add env row
    const addButton = container?.querySelector('[data-add-env]') as HTMLButtonElement
    expect(addButton).toBeTruthy()
    act(() => {
      addButton.click()
    })
    expect(onChange).toHaveBeenCalledWith({
      env: [
        { key: 'API_KEY', value: 'secret123' },
        { key: '', value: '' },
      ],
    })

    // Remove env row
    const removeButton = container?.querySelector('[data-remove-env="0"]') as HTMLButtonElement
    expect(removeButton).toBeTruthy()
    act(() => {
      removeButton.click()
    })
    expect(onChange).toHaveBeenCalledWith({ env: [] })
  })
})

describe('ServerJsonView', () => {
  it('renders monospaced textarea, helper text, and handles input change', () => {
    const onChange = vi.fn()
    const rawJson = '{\n  "command": "npx"\n}'
    renderComponent(createElement(ServerJsonView, { rawJson, error: null, onChange }))

    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).toBeTruthy()
    expect(textarea.value).toBe(rawJson)

    expect(container?.textContent).toContain('支持直接粘贴 {"server-name": {...}} 或 {"mcpServers": {"server-name": {...}}}。')

    act(() => {
      setInputValue(textarea, '{"command": "node"}')
    })
    expect(onChange).toHaveBeenCalledWith('{"command": "node"}')
  })

  it('renders error banner when error is provided', () => {
    const onChange = vi.fn()
    renderComponent(createElement(ServerJsonView, {
      rawJson: '{ broken',
      error: 'Unexpected end of JSON input',
      onChange,
    }))

    const errorBanner = container?.querySelector('[role="alert"]')
    expect(errorBanner).toBeTruthy()
    expect(errorBanner?.textContent).toContain('Unexpected end of JSON input')
  })

  it('formats JSON when format button is clicked', () => {
    const onChange = vi.fn()
    const rawJson = '{"command":"npx","args":["-y"]}'
    renderComponent(createElement(ServerJsonView, {
      rawJson,
      error: null,
      onChange,
    }))

    const formatBtn = container?.querySelector('button[data-format-json]') as HTMLButtonElement
    expect(formatBtn).toBeTruthy()
    act(() => {
      formatBtn.click()
    })
    expect(onChange).toHaveBeenCalledWith(JSON.stringify(JSON.parse(rawJson), null, 2))
  })
})

describe('ServerEditorTab', () => {
  let controller: McpPanelController
  let mockFetch: ReturnType<typeof vi.fn>
  let api: McpServersApiClient

  beforeEach(() => {
    controller = new McpPanelController()
    controller.openCreate('user')
    mockFetch = vi.fn()
    api = new McpServersApiClient(mockFetch as unknown as typeof fetch)
  })

  it('renders breadcrumb and navigation returns to list', () => {
    renderComponent(createElement(ServerEditorTab, { controller, api }))

    expect(container?.textContent).toContain('MCP 服务器')
    expect(container?.textContent).toContain('新建 MCP 服务器')

    const breadcrumbBack = container?.querySelector('[data-breadcrumb-back]') as HTMLElement
    expect(breadcrumbBack).toBeTruthy()
    act(() => {
      breadcrumbBack.click()
    })
    expect(controller.getSnapshot().viewMode).toBe('list')
  })

  it('switches between Form and JSON mode with segmented control', () => {
    renderComponent(createElement(ServerEditorTab, { controller, api }))

    expect(controller.getSnapshot().editorMode).toBe('form')
    expect(container?.querySelector('input[placeholder="my-mcp-server"]')).toBeTruthy()

    // Switch to JSON
    const jsonTabBtn = container?.querySelector('button[data-mode-tab="json"]') as HTMLButtonElement
    expect(jsonTabBtn).toBeTruthy()
    act(() => {
      jsonTabBtn.click()
    })

    expect(controller.getSnapshot().editorMode).toBe('json')
    expect(container?.querySelector('textarea')).toBeTruthy()

    // Switch back to Form
    const formTabBtn = container?.querySelector('button[data-mode-tab="form"]') as HTMLButtonElement
    expect(formTabBtn).toBeTruthy()
    act(() => {
      formTabBtn.click()
    })
    expect(controller.getSnapshot().editorMode).toBe('form')
  })

  it('updates scope from scope selector dropdown', () => {
    renderComponent(createElement(ServerEditorTab, { controller, api }))

    const scopeSelect = container?.querySelector('select[data-field="scope"]') as HTMLSelectElement
    expect(scopeSelect).toBeTruthy()
    expect(scopeSelect.value).toBe('user')

    act(() => {
      scopeSelect.value = 'workspace'
      scopeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(controller.getSnapshot().draft.scope).toBe('workspace')
  })

  it('validates required fields before saving', async () => {
    renderComponent(createElement(ServerEditorTab, { controller, api }))

    const saveBtn = container?.querySelector('button[data-action="save"]') as HTMLButtonElement
    expect(saveBtn).toBeTruthy()

    // Save with empty name
    await act(async () => {
      saveBtn.click()
    })
    expect(container?.textContent).toContain('请输入服务器名称')
    expect(mockFetch).not.toHaveBeenCalled()

    // Set name but no command
    act(() => {
      controller.updateDraft(() => ({ name: 'my-server', command: '' }))
    })
    await act(async () => {
      saveBtn.click()
    })
    expect(container?.textContent).toContain('请输入执行命令')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('saves server configuration and closes editor on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    })
    const onSaved = vi.fn()
    renderComponent(createElement(ServerEditorTab, { controller, api, cwd: '/workspace', onSaved }))

    act(() => {
      controller.updateDraft(() => ({
        name: 'my-server',
        transport: 'stdio',
        command: 'npx',
        args: '-y server-pkg',
      }))
    })

    const saveBtn = container?.querySelector('button[data-action="save"]') as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-mcp-adapter/save',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          scope: 'user',
          name: 'my-server',
          server: {
            command: 'npx',
            args: ['-y', 'server-pkg'],
          },
        }),
      }),
    )

    expect(onSaved).toHaveBeenCalled()
    expect(controller.getSnapshot().viewMode).toBe('list')
  })

  it('displays error message if save fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Disk full' }),
    })
    renderComponent(createElement(ServerEditorTab, { controller, api }))

    act(() => {
      controller.updateDraft(() => ({
        name: 'my-server',
        command: 'npx',
      }))
    })

    const saveBtn = container?.querySelector('button[data-action="save"]') as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
    })

    expect(container?.textContent).toContain('Disk full')
    expect(controller.getSnapshot().viewMode).toBe('editor')
  })

  it('cancel button returns to list', () => {
    renderComponent(createElement(ServerEditorTab, { controller, api }))

    const cancelBtn = container?.querySelector('button[data-action="cancel"]') as HTMLButtonElement
    expect(cancelBtn).toBeTruthy()
    act(() => {
      cancelBtn.click()
    })
    expect(controller.getSnapshot().viewMode).toBe('list')
  })

  it('renders editing mode properly when openEdit was called', () => {
    act(() => {
      controller.openEdit({
        name: 'existing-server',
        scope: 'workspace',
        category: 'custom',
        transport: 'stdio',
        command: 'uvx',
        args: ['run', 'pkg'],
        timeoutMs: 45000,
        protocolVersion: '2024-11-05',
      })
    })

    renderComponent(createElement(ServerEditorTab, { controller, api }))

    expect(container?.textContent).toContain('编辑 MCP 服务器')
    const nameInput = container?.querySelector('input[placeholder="my-mcp-server"]') as HTMLInputElement
    expect(nameInput.value).toBe('existing-server')
    expect(nameInput.disabled).toBe(true)
    const commandInput = container?.querySelector('input[placeholder="npx"]') as HTMLInputElement
    expect(commandInput.value).toBe('uvx')
  })

  it('validates URL in http mode before saving', async () => {
    renderComponent(createElement(ServerEditorTab, { controller, api }))

    act(() => {
      controller.updateDraft(() => ({
        name: 'http-server',
        transport: 'http',
        url: '',
      }))
    })

    const saveBtn = container?.querySelector('button[data-action="save"]') as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
    })

    expect(container?.textContent).toContain('请输入服务 URL')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('saves in JSON mode and preserves custom fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    })
    renderComponent(createElement(ServerEditorTab, { controller, api }))

    act(() => {
      controller.setEditorMode('json')
      controller.updateDraft(() => ({
        name: 'custom-mcp',
        rawJson: JSON.stringify({
          command: 'node',
          args: ['app.js'],
          customMeta: { author: 'dsh' },
        }, null, 2),
      }))
    })

    const saveBtn = container?.querySelector('button[data-action="save"]') as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-mcp-adapter/save',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          scope: 'user',
          name: 'custom-mcp',
          server: {
            command: 'node',
            args: ['app.js'],
            customMeta: { author: 'dsh' },
          },
        }),
      }),
    )
  })

  it('blocks saving and shows error when JSON mode has syntax errors', async () => {
    renderComponent(createElement(ServerEditorTab, { controller, api }))

    act(() => {
      controller.setEditorMode('json')
      controller.updateDraft(() => ({
        name: 'bad-json-server',
        rawJson: '{ invalid json syntax',
      }))
    })

    const saveBtn = container?.querySelector('button[data-action="save"]') as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
    })

    expect(mockFetch).not.toHaveBeenCalled()
    expect(container?.textContent).toContain('JSON')
  })

  it('unpacks single-key wrapped server object {"server-name": {...}} in JSON mode', async () => {
    renderComponent(createElement(ServerEditorTab, { controller, api }))

    act(() => {
      controller.setEditorMode('json')
      controller.updateDraft(() => ({
        name: '',
        rawJson: JSON.stringify({
          'pasted-server': {
            command: 'python',
            args: ['server.py'],
          },
        }),
      }))
    })

    const saveBtn = container?.querySelector('button[data-action="save"]') as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-mcp-adapter/save',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          scope: 'user',
          name: 'pasted-server',
          server: {
            command: 'python',
            args: ['server.py'],
          },
        }),
      }),
    )
  })

  it('merges form changes with existing server properties when editing in form mode', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    })
    act(() => {
      controller.openEdit({
        name: 'existing-server',
        scope: 'workspace',
        category: 'database',
        transport: 'stdio',
        command: 'sqlite3-mcp',
        args: ['data.db'],
        description: 'Persistent SQLite database server',
        cwd: '/custom/cwd',
        timeoutMs: 45000,
        protocolVersion: '2024-11-05',
        status: 'ready',
      })
      controller.updateDraft(() => ({
        command: 'sqlite3-mcp-v2',
      }))
    })

    renderComponent(createElement(ServerEditorTab, { controller, api, cwd: '/workspace' }))

    const saveBtn = container?.querySelector('button[data-action="save"]') as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-mcp-adapter/save',
      expect.objectContaining({ method: 'POST' }),
    )
    const calledBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(calledBody).toEqual({
      scope: 'workspace',
      cwd: '/workspace',
      name: 'existing-server',
      originalName: 'existing-server',
      originalScope: 'workspace',
      server: {
        category: 'database',
        description: 'Persistent SQLite database server',
        cwd: '/custom/cwd',
        command: 'sqlite3-mcp-v2',
        args: ['data.db'],
        // Saved under the canonical key the normalizer reads, not the alias it merely tolerates.
        requestTimeoutMs: 45000,
        protocolVersion: '2024-11-05',
      },
    })
  })

  it('submits originalName and originalScope when renaming and switching scope in form mode', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    })
    const api = new McpServersApiClient(mockFetch as unknown as typeof fetch)
    const controller = new McpPanelController({ scope: 'workspace' })

    act(() => {
      controller.openEdit({
        name: 'old-server',
        scope: 'workspace',
        category: 'custom',
        transport: 'stdio',
        command: 'echo',
        args: ['hello'],
        status: 'ready',
      })
      controller.updateDraft(() => ({
        name: 'new-server',
        scope: 'user',
        command: 'echo-v2',
      }))
    })

    renderComponent(createElement(ServerEditorTab, { controller, api, cwd: '/workspace' }))

    const saveBtn = container?.querySelector('button[data-action="save"]') as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
    })

    const calledBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(calledBody).toEqual({
      scope: 'user',
      cwd: undefined,
      name: 'new-server',
      originalName: 'old-server',
      originalScope: 'workspace',
      server: {
        category: 'custom',
        command: 'echo-v2',
        args: ['hello'],
      },
    })
  })
})
