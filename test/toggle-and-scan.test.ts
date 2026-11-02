import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpServersService } from '../src/service.ts'
import { scanExternalMcp, candidateFromRecord } from '../src/imports.ts'
import { listCatalogEntries, getCatalogEntry } from '../src/presets.ts'

describe('MCP Service - Toggle and Catalog', () => {
  let tempDir: string
  let dshHome: string
  let projectDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'dsh-mcp-service-test-'))
    dshHome = join(tempDir, 'dsh_home')
    projectDir = join(tempDir, 'project')
    await fs.mkdir(join(dshHome, 'mcp-adapter'), { recursive: true })
    await fs.mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('toggles a server disabled and enabled in-place in user scope', async () => {
    const userMcp = join(dshHome, 'mcp-adapter', 'mcp.json')
    await fs.writeFile(
      userMcp,
      JSON.stringify({
        mcpServers: {
          tavily: {
            url: 'https://mcp.tavily.com/mcp',
          },
        },
      }),
      'utf8',
    )

    const onEvict = vi.fn()
    const service = new McpServersService({ dshHome, onEvictServer: onEvict })

    // 1. Toggle disabled
    const res1 = await service.toggleServer({
      name: 'tavily',
      scope: 'user',
      enabled: false,
    })
    expect(res1).toEqual({ ok: true, enabled: false })
    expect(onEvict).toHaveBeenCalledWith('tavily')

    const file1 = JSON.parse(await fs.readFile(userMcp, 'utf8'))
    expect(file1.mcpServers.tavily.disabled).toBe(true)

    // 2. Toggle enabled
    const res2 = await service.toggleServer({
      name: 'tavily',
      scope: 'user',
      enabled: true,
    })
    expect(res2).toEqual({ ok: true, enabled: true })

    const file2 = JSON.parse(await fs.readFile(userMcp, 'utf8'))
    expect(file2.mcpServers.tavily.disabled).toBeUndefined()
  })

  it('lists rich curated catalog entries matching Market requirements', () => {
    const catalog = listCatalogEntries()
    expect(catalog.length).toBeGreaterThanOrEqual(10)

    const memory = getCatalogEntry('memory')
    expect(memory).toBeDefined()
    expect(memory?.categories).toContain('productivity')
    expect(memory?.transport).toBe('stdio')

    const github = getCatalogEntry('github')
    expect(github).toBeDefined()
    expect(github?.categories).toContain('devtools')
    expect(github?.requiredEnv).toBeDefined()

    const context7 = getCatalogEntry('context7')
    expect(context7?.transport).toBe('http')
  })
})

describe('External MCP Tool Scanner & Importer', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'dsh-mcp-scan-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('scans Claude Code, Cursor, and Agents configs from mock directories', async () => {
    const fakeHome = join(tempDir, 'home')
    const fakeProject = join(tempDir, 'proj')
    await fs.mkdir(join(fakeHome, '.cursor'), { recursive: true })
    await fs.mkdir(join(fakeHome, '.agents', 'servers'), { recursive: true })
    await fs.mkdir(join(fakeProject, '.cursor'), { recursive: true })

    // 1. Cursor Global config
    await fs.writeFile(
      join(fakeHome, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          cursor_srv: {
            command: 'node',
            args: ['server.js'],
          },
        },
      }),
      'utf8',
    )

    // 2. Agents / PI-Desktop single json server
    await fs.writeFile(
      join(fakeHome, '.agents', 'servers', 'agent_srv.json'),
      JSON.stringify({
        id: 'agent_srv',
        name: 'Agent Server',
        transport: 'http',
        url: 'https://agent.example.com/mcp',
      }),
      'utf8',
    )

    // 3. Cursor Project config
    await fs.writeFile(
      join(fakeProject, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          proj_tool: {
            command: 'python',
            args: ['-m', 'tool'],
          },
        },
      }),
      'utf8',
    )

    const result = scanExternalMcp({
      homeDir: fakeHome,
      projectPath: fakeProject,
    })

    expect(result.sources.length).toBeGreaterThan(0)
    const candidateIds = result.candidates.map((c) => c.id)
    expect(candidateIds).toContain('cursor_srv')
    expect(candidateIds).toContain('agent_srv')
    expect(candidateIds).toContain('proj_tool')
  })

  it('imports external candidate into target scope mcp.json', async () => {
    const dshHome = join(tempDir, 'dsh')
    const projectDir = join(tempDir, 'project')
    await fs.mkdir(join(dshHome, 'mcp-adapter'), { recursive: true })
    await fs.mkdir(projectDir, { recursive: true })

    const service = new McpServersService({ dshHome })
    const candidate = candidateFromRecord(
      'cursor-global',
      '/path/to/cursor/mcp.json',
      'imported_tool',
      {
        command: 'npx',
        args: ['-y', 'my-tool'],
        description: 'Imported from Cursor',
      },
    )

    const res = await service.importExternal({
      items: [candidate],
      scope: 'workspace',
      cwd: projectDir,
    })

    expect(res.ok).toBe(true)
    expect(res.importedCount).toBe(1)

    const wsMcp = join(projectDir, '.mcp.json')
    const content = JSON.parse(await fs.readFile(wsMcp, 'utf8'))
    expect(content.mcpServers.imported_tool).toBeDefined()
    expect(content.mcpServers.imported_tool.command).toBe('npx')
  })

  it('migrates server from user scope to workspace scope atomically', async () => {
    const dshHome = join(tempDir, 'dsh_home')
    const projectDir = join(tempDir, 'project')
    await fs.mkdir(join(dshHome, 'mcp-adapter'), { recursive: true })
    await fs.mkdir(projectDir, { recursive: true })

    const userMcp = join(dshHome, 'mcp-adapter', 'mcp.json')
    await fs.writeFile(
      userMcp,
      JSON.stringify({
        mcpServers: {
          portable_server: {
            command: 'node',
            args: ['server.js'],
          },
        },
      }),
      'utf8',
    )

    const onEvict = vi.fn()
    const service = new McpServersService({ dshHome, onEvictServer: onEvict })

    const res = await service.migrateScope({
      name: 'portable_server',
      fromScope: 'user',
      toScope: 'workspace',
      cwd: projectDir,
    })

    expect(res).toEqual({ ok: true })
    expect(onEvict).toHaveBeenCalledWith('portable_server')

    // Removed from user
    const userJson = JSON.parse(await fs.readFile(userMcp, 'utf8'))
    expect(userJson.mcpServers.portable_server).toBeUndefined()

    // Added to workspace
    const wsMcp = join(projectDir, '.mcp.json')
    const wsJson = JSON.parse(await fs.readFile(wsMcp, 'utf8'))
    expect(wsJson.mcpServers.portable_server).toBeDefined()
    expect(wsJson.mcpServers.portable_server.command).toBe('node')
  })

  it('rejects migration with 409 conflict when server name already exists in target scope', async () => {
    const dshHome = join(tempDir, 'dsh_home')
    const projectDir = join(tempDir, 'project')
    await fs.mkdir(join(dshHome, 'mcp-adapter'), { recursive: true })
    await fs.mkdir(projectDir, { recursive: true })

    const userMcp = join(dshHome, 'mcp-adapter', 'mcp.json')
    const wsMcp = join(projectDir, '.mcp.json')
    await fs.writeFile(
      userMcp,
      JSON.stringify({ mcpServers: { dupe_server: { url: 'https://global.test' } } }),
      'utf8',
    )
    await fs.writeFile(
      wsMcp,
      JSON.stringify({ mcpServers: { dupe_server: { url: 'https://project.test' } } }),
      'utf8',
    )

    const service = new McpServersService({ dshHome })
    await expect(
      service.migrateScope({
        name: 'dupe_server',
        fromScope: 'user',
        toScope: 'workspace',
        cwd: projectDir,
      }),
    ).rejects.toThrow(/already exists in workspace scope/)

    // Original configs untouched
    const userJson = JSON.parse(await fs.readFile(userMcp, 'utf8'))
    expect(userJson.mcpServers.dupe_server.url).toBe('https://global.test')
  })
})
