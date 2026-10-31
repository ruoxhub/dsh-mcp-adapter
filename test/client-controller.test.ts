import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServersApiClient } from '../src/client/api.ts'
import { McpPanelController, type ServerDraft } from '../src/client/controller.ts'
import type { McpServerDetail, ProbeResult } from '../src/types.ts'

describe('McpServersApiClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let client: McpServersApiClient

  beforeEach(() => {
    mockFetch = vi.fn()
    client = new McpServersApiClient(mockFetch as unknown as typeof fetch)
  })

  it('fetches server list with default and custom query parameters', async () => {
    const mockData = {
      servers: [
        {
          name: 'test-server',
          scope: 'user' as const,
          category: 'custom',
          transport: 'stdio' as const,
          command: 'npx',
        },
      ],
      workspaceRoot: '/test/workspace',
    }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    })

    const res = await client.getServers({ cwd: '/test/workspace', scope: 'user' })
    expect(res).toEqual(mockData)
    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-mcp-adapter/servers?cwd=%2Ftest%2Fworkspace&scope=user',
      expect.objectContaining({ method: 'GET' }),
    )

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    })
    await client.getServers()
    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-mcp-adapter/servers',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('saves server configuration via POST', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    })

    const payload = {
      scope: 'workspace',
      cwd: '/my/repo',
      name: 'fetch-server',
      server: { command: 'node', args: ['server.js'] },
    }
    const res = await client.saveServer(payload)
    expect(res).toEqual({ ok: true })
    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-mcp-adapter/save',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
  })

  it('approves server via POST', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    })

    const payload = { cwd: '/my/repo', name: 'fetch-server' }
    const res = await client.approveServer(payload)
    expect(res).toEqual({ ok: true })
    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-mcp-adapter/approve',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
  })

  it('deletes server via POST', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    })

    const payload = { scope: 'user', name: 'old-server' }
    const res = await client.deleteServer(payload)
    expect(res).toEqual({ ok: true })
    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-mcp-adapter/delete',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
  })

  it('probes server via POST', async () => {
    const probeResult: ProbeResult = { ok: true, latencyMs: 42 }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => probeResult,
    })

    const server = { command: 'npx', args: ['-y', 'echo'] }
    const res = await client.probeServer(server)
    expect(res).toEqual(probeResult)
    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-mcp-adapter/probe',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server }),
      }),
    )
  })

  it('throws informative Error with API message when response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'Server name is invalid' }),
    })

    await expect(client.deleteServer({ scope: 'user', name: 'bad name' })).rejects.toThrow(
      'Server name is invalid',
    )
  })

  it('falls back to HTTP status when error body cannot be parsed as JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new Error('Not JSON')
      },
    })

    await expect(client.getServers()).rejects.toThrow(/502.*Bad Gateway/)
  })
})

describe('McpPanelController', () => {
  it('initializes with default snapshot state', () => {
    const controller = new McpPanelController()
    const snapshot = controller.getSnapshot()

    expect(snapshot.scope).toBe('user')
    expect(snapshot.searchQuery).toBe('')
    expect(snapshot.viewMode).toBe('list')
    expect(snapshot.editorMode).toBe('form')
    expect(snapshot.editingServer).toBeNull()
    expect(snapshot.jsonError).toBeNull()
    expect(snapshot.draft).toMatchObject({
      name: '',
      scope: 'user',
      transport: 'stdio',
      command: '',
      args: '',
      timeoutMs: 30000,
      protocolVersion: '',
      env: [],
    })
  })

  it('supports subscription notifications and unsubscribe', () => {
    const controller = new McpPanelController()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)

    controller.setScope('workspace')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().scope).toBe('workspace')

    controller.setSearchQuery('git')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().searchQuery).toBe('git')

    unsubscribe()
    controller.setSearchQuery('other')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps getSnapshot referentially stable when state does not change', () => {
    const controller = new McpPanelController()
    const s1 = controller.getSnapshot()
    const s2 = controller.getSnapshot()
    expect(s1).toBe(s2)

    controller.setSearchQuery('test')
    const s3 = controller.getSnapshot()
    expect(s3).not.toBe(s1)
  })

  it('opens create mode with fresh draft and editor viewMode', () => {
    const controller = new McpPanelController()
    controller.openCreate('workspace')

    const snapshot = controller.getSnapshot()
    expect(snapshot.viewMode).toBe('editor')
    expect(snapshot.editorMode).toBe('form')
    expect(snapshot.editingServer).toBeNull()
    expect(snapshot.draft.scope).toBe('workspace')
    expect(snapshot.draft.name).toBe('')
    expect(snapshot.draft.rawJson).toBeDefined()
  })

  it('opens edit mode prefilled from McpServerDetail', () => {
    const controller = new McpPanelController()
    const server: McpServerDetail = {
      name: 'filesystem',
      scope: 'workspace',
      category: 'system',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/repo'],
      env: { KEY: 'val1', OTHER: 'val2' },
      timeoutMs: 15000,
      protocolVersion: '2024-11-05',
    }

    controller.openEdit(server)
    const snapshot = controller.getSnapshot()
    expect(snapshot.viewMode).toBe('editor')
    expect(snapshot.editingServer).toBe(server)
    expect(snapshot.draft.name).toBe('filesystem')
    expect(snapshot.draft.scope).toBe('workspace')
    expect(snapshot.draft.command).toBe('npx')
    expect(snapshot.draft.args).toBe('-y @modelcontextprotocol/server-filesystem /tmp/repo')
    expect(snapshot.draft.timeoutMs).toBe(15000)
    expect(snapshot.draft.protocolVersion).toBe('2024-11-05')
    expect(snapshot.draft.env).toEqual([
      { key: 'KEY', value: 'val1' },
      { key: 'OTHER', value: 'val2' },
    ])
    expect(snapshot.draft.rawJson).toContain('"command": "npx"')
  })

  it('closes editor and resets to list viewMode', () => {
    const controller = new McpPanelController()
    controller.openCreate()
    expect(controller.getSnapshot().viewMode).toBe('editor')

    controller.closeEditor()
    const snapshot = controller.getSnapshot()
    expect(snapshot.viewMode).toBe('list')
    expect(snapshot.editingServer).toBeNull()
  })

  it('updates draft via updateDraft updater', () => {
    const controller = new McpPanelController()
    controller.openCreate()

    controller.updateDraft((draft) => ({
      name: 'custom-tool',
      command: 'node',
      args: 'app.js',
    }))

    const snapshot = controller.getSnapshot()
    expect(snapshot.draft.name).toBe('custom-tool')
    expect(snapshot.draft.command).toBe('node')
    expect(snapshot.draft.args).toBe('app.js')
  })

  it('toggles editor mode between form and json with automatic sync', () => {
    const controller = new McpPanelController()
    controller.openCreate()

    controller.updateDraft(() => ({
      name: 'test-sync',
      command: 'python',
      args: '-m server',
    }))

    controller.setEditorMode('json')
    expect(controller.getSnapshot().editorMode).toBe('json')
    expect(controller.getSnapshot().draft.rawJson).toContain('"command": "python"')

    // Edit rawJson in JSON mode and toggle back to form
    controller.updateDraft(() => ({
      rawJson: JSON.stringify({
        command: 'python3',
        args: ['-m', 'server_v2'],
      }),
    }))

    controller.setEditorMode('form')
    expect(controller.getSnapshot().editorMode).toBe('form')
    expect(controller.getSnapshot().draft.command).toBe('python3')
    expect(controller.getSnapshot().draft.args).toBe('-m server_v2')
  })
})

describe('Dual-mode Draft Sync', () => {
  let controller: McpPanelController

  beforeEach(() => {
    controller = new McpPanelController()
    controller.openCreate()
  })

  it('syncs draft form fields to clean formatted JSON string in rawJson', () => {
    controller.updateDraft(() => ({
      name: 'my-service',
      transport: 'stdio',
      command: 'uvx',
      args: '--from git+https://example.com/repo tool "arg with spaces"',
      env: [
        { key: 'API_TOKEN', value: 'secret123' },
        { key: '', value: 'ignored' },
      ],
      timeoutMs: 20000,
      protocolVersion: '2024-11-05',
    }))

    controller.syncDraftToJson()
    const rawJson = controller.getSnapshot().draft.rawJson
    expect(rawJson).toBeDefined()
    const parsed = JSON.parse(rawJson!)

    expect(parsed.command).toBe('uvx')
    expect(parsed.args).toEqual([
      '--from',
      'git+https://example.com/repo',
      'tool',
      'arg with spaces',
    ])
    expect(parsed.env).toEqual({ API_TOKEN: 'secret123' })
    // The canonical key: `timeoutMs` is accepted on read but never written, so a saved file cannot
    // drift away from what `normalizeEntry` consumes.
    expect(parsed.requestTimeoutMs).toBe(20000)
    expect(parsed.timeoutMs).toBeUndefined()
    expect(parsed.protocolVersion).toBe('2024-11-05')
  })

  it('syncs http transport draft to rawJson', () => {
    controller.updateDraft(() => ({
      name: 'remote-mcp',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: [
        { key: 'Authorization', value: 'Bearer token123' },
        { key: '', value: '' },
      ],
    }))

    controller.syncDraftToJson()
    const parsed = JSON.parse(controller.getSnapshot().draft.rawJson!)
    expect(parsed.url).toBe('https://example.com/mcp')
    // Streamable HTTP is the default, so the transport key is absent rather than spelled out.
    expect(parsed.transport).toBeUndefined()
    expect(parsed.httpTransport).toBeUndefined()
    expect(parsed.headers).toEqual({ Authorization: 'Bearer token123' })
  })

  it('writes httpTransport for an SSE server instead of the dead transport key', () => {
    controller.updateDraft(() => ({
      name: 'legacy-sse',
      transport: 'sse',
      url: 'https://example.com/sse',
    }))

    controller.syncDraftToJson()
    const parsed = JSON.parse(controller.getSnapshot().draft.rawJson!)
    expect(parsed.httpTransport).toBe('sse')
    expect(parsed.transport).toBeUndefined()
  })

  it('syncs single server JSON to draft successfully', () => {
    controller.updateDraft(() => ({
      rawJson: JSON.stringify(
        {
          command: 'node',
          args: ['run.js', '--port', '8080'],
          env: { NODE_ENV: 'production' },
          timeoutMs: 45000,
        },
        null,
        2,
      ),
    }))

    const result = controller.syncJsonToDraft()
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()

    const snapshot = controller.getSnapshot()
    expect(snapshot.jsonError).toBeNull()
    expect(snapshot.draft.command).toBe('node')
    expect(snapshot.draft.args).toBe('run.js --port 8080')
    expect(snapshot.draft.env).toEqual([{ key: 'NODE_ENV', value: 'production' }])
    expect(snapshot.draft.timeoutMs).toBe(45000)
  })

  it('syncs mcpServers wrapper JSON to draft and updates server name', () => {
    controller.updateDraft(() => ({
      rawJson: JSON.stringify({
        mcpServers: {
          'postgres-db': {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/db'],
            env: { DB_MAX_CONN: '10' },
          },
        },
      }),
    }))

    const result = controller.syncJsonToDraft()
    expect(result.ok).toBe(true)

    const snapshot = controller.getSnapshot()
    expect(snapshot.draft.name).toBe('postgres-db')
    expect(snapshot.draft.command).toBe('npx')
    expect(snapshot.draft.args).toBe(
      '-y @modelcontextprotocol/server-postgres postgresql://localhost/db',
    )
    expect(snapshot.draft.env).toEqual([{ key: 'DB_MAX_CONN', value: '10' }])
  })

  it('handles invalid JSON syntax by setting jsonError and returning error', () => {
    controller.updateDraft(() => ({
      rawJson: '{ command: "broken json without closing',
    }))

    const result = controller.syncJsonToDraft()
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()

    const snapshot = controller.getSnapshot()
    expect(snapshot.jsonError).toBe(result.error)
  })

  it('handles non-object JSON values by setting jsonError', () => {
    controller.updateDraft(() => ({
      rawJson: JSON.stringify([1, 2, 3]),
    }))

    const result = controller.syncJsonToDraft()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/object/i)
    expect(controller.getSnapshot().jsonError).toMatch(/object/i)
  })

  it('blocks switching to form mode when JSON has syntax errors', () => {
    controller.setEditorMode('json')
    controller.updateDraft(() => ({
      rawJson: '{ invalid json: [',
    }))

    const switched = controller.setEditorMode('form')
    expect(switched).toBe(false)
    expect(controller.getSnapshot().editorMode).toBe('json')
    expect(controller.getSnapshot().jsonError).toBeTruthy()
  })

  it('resets omitted fields when JSON removes them so deleted properties do not ghost', () => {
    // Start with a draft containing env, url, headers
    controller.updateDraft(() => ({
      name: 'test-server',
      command: 'node',
      args: 'app.js',
      env: [{ key: 'OLD', value: '1' }],
      url: 'http://old.local',
      headers: [{ key: 'Authorization', value: 'old-token' }],
    }))

    // Now user replaces JSON with minimal stdio without env/url/headers
    controller.updateDraft(() => ({
      rawJson: JSON.stringify({
        command: 'python',
        args: ['main.py'],
      }),
    }))

    const res = controller.syncJsonToDraft()
    expect(res.ok).toBe(true)
    const snapshot = controller.getSnapshot()
    expect(snapshot.draft.command).toBe('python')
    expect(snapshot.draft.args).toBe('main.py')
    expect(snapshot.draft.url).toBe('')
    expect(snapshot.draft.env).toEqual([])
    expect(snapshot.draft.headers).toEqual([])

    // Syncing back to JSON should not contain any deleted fields
    controller.syncDraftToJson()
    const jsonParsed = JSON.parse(controller.getSnapshot().draft.rawJson!)
    expect(jsonParsed.command).toBe('python')
    expect(jsonParsed.args).toEqual(['main.py'])
    expect(jsonParsed.url).toBeUndefined()
    expect(jsonParsed.env).toBeUndefined()
    expect(jsonParsed.headers).toBeUndefined()
  })
})
