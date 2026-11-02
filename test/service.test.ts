import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServersService } from '../src/service.ts'

describe('McpServersService', () => {
  let tmpRoot: string
  let dshHome: string
  let workspaceDir: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-service-test-'))
    dshHome = join(tmpRoot, 'dsh-home')
    workspaceDir = join(tmpRoot, 'workspace')
    mkdirSync(join(dshHome, 'mcp-adapter'), { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  describe('listServers', () => {
    it('returns empty list when no config files exist', async () => {
      const service = new McpServersService({ dshHome })
      const result = await service.listServers({ cwd: workspaceDir })

      expect(result.servers).toEqual([])
      expect(result.workspaceRoot).toBe(workspaceDir)
      expect(result.workspaces).toHaveLength(1)
      expect(result.workspaces[0].path).toBe(workspaceDir)
    })

    it('lists user and workspace servers with inferred categories', async () => {
      // User config
      writeFileSync(
        join(dshHome, 'mcp-adapter', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            'browser-tools': {
              command: 'node',
              args: ['browser.js'],
              description: 'Browser automation tool',
            },
            'sys-monitor': {
              command: 'node',
              args: ['sys.js'],
              description: 'System desktop control',
            },
          },
        }),
      )

      // Workspace config
      writeFileSync(
        join(workspaceDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'doc-reader': {
              command: 'node',
              args: ['doc.js'],
              description: 'PDF and markdown document skill',
            },
            'custom-worker': {
              url: 'http://localhost:8080/mcp',
              description: 'Custom HTTP server',
            },
          },
        }),
      )

      // `ask` is not the default any more, so the gate has to be answered for on purpose.
      const service = new McpServersService({ dshHome, projectServers: 'ask' })

      // List all
      const allResult = await service.listServers({ cwd: workspaceDir })
      expect(allResult.servers).toHaveLength(4)

      const browserServer = allResult.servers.find((s) => s.name === 'browser-tools')
      expect(browserServer).toBeDefined()
      expect(browserServer?.scope).toBe('user')
      expect(browserServer?.category).toBe('browser')
      expect(browserServer?.transport).toBe('stdio')
      expect(browserServer?.status).toBe('ready')

      const sysServer = allResult.servers.find((s) => s.name === 'sys-monitor')
      expect(sysServer?.category).toBe('system')

      const docServer = allResult.servers.find((s) => s.name === 'doc-reader')
      expect(docServer?.scope).toBe('workspace')
      expect(docServer?.category).toBe('document')
      // Under `ask`, a workspace server from file is not approved yet -> status is blocked
      expect(docServer?.status).toBe('blocked')

      const customServer = allResult.servers.find((s) => s.name === 'custom-worker')
      expect(customServer?.scope).toBe('workspace')
      expect(customServer?.transport).toBe('http')
      expect(customServer?.category).toBe('custom')
      expect(customServer?.status).toBe('blocked')
    })

    it('filters servers by scope', async () => {
      writeFileSync(
        join(dshHome, 'mcp-adapter', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            'global-one': { command: 'node' },
          },
        }),
      )
      writeFileSync(
        join(workspaceDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'project-one': { command: 'node' },
          },
        }),
      )

      const service = new McpServersService({ dshHome })

      const userOnly = await service.listServers({ cwd: workspaceDir, scope: 'user' })
      expect(userOnly.servers).toHaveLength(1)
      expect(userOnly.servers[0].name).toBe('global-one')

      const workspaceOnly = await service.listServers({ cwd: workspaceDir, scope: 'workspace' })
      expect(workspaceOnly.servers).toHaveLength(1)
      expect(workspaceOnly.servers[0].name).toBe('project-one')
    })
  })

  describe('saveServer', () => {
    it('saves a server to user scope and preserves existing fields', async () => {
      const userConfigPath = join(dshHome, 'mcp-adapter', 'mcp.json')
      writeFileSync(
        userConfigPath,
        JSON.stringify({
          settings: { idleTimeout: 15 },
          mcpServers: {
            existing: { command: 'node', args: ['existing.js'] },
          },
        }, null, 2),
      )

      const service = new McpServersService({ dshHome })
      const res = await service.saveServer({
        scope: 'user',
        name: 'new-server',
        server: {
          command: 'node',
          args: ['new.js'],
          env: { FOO: 'bar' },
        },
      })

      expect(res.ok).toBe(true)
      const content = JSON.parse(readFileSync(userConfigPath, 'utf8'))
      expect(content.settings).toEqual({ idleTimeout: 15 })
      expect(content.mcpServers.existing).toBeDefined()
      expect(content.mcpServers['new-server']).toEqual({
        command: 'node',
        args: ['new.js'],
        env: { FOO: 'bar' },
      })
    })

    it('saves a server to workspace scope, creates .mcp.json if absent, and auto-approves it', async () => {
      const workspaceConfigPath = join(workspaceDir, '.mcp.json')
      expect(existsSync(workspaceConfigPath)).toBe(false)

      const service = new McpServersService({ dshHome })
      const res = await service.saveServer({
        scope: 'workspace',
        cwd: workspaceDir,
        name: 'workspace-tool',
        server: {
          command: 'node',
          args: ['tool.js'],
        },
      })

      expect(res.ok).toBe(true)
      expect(existsSync(workspaceConfigPath)).toBe(true)

      const content = JSON.parse(readFileSync(workspaceConfigPath, 'utf8'))
      expect(content.mcpServers['workspace-tool']).toBeDefined()

      // Should be auto-approved so listServers reports status: 'ready'
      const list = await service.listServers({ cwd: workspaceDir, scope: 'workspace' })
      const s = list.servers.find((x) => x.name === 'workspace-tool')
      expect(s?.status).toBe('ready')
    })

    it('rejects invalid server names', async () => {
      const service = new McpServersService({ dshHome })
      await expect(
        service.saveServer({
          scope: 'user',
          name: 'bad name with spaces!',
          server: { command: 'node' },
        }),
      ).rejects.toThrow(/invalid server name/i)
    })

    it('performs atomic rename in the same scope, removing the old server key and evicting pool', async () => {
      const userConfigPath = join(dshHome, 'mcp-adapter', 'mcp.json')
      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: {
            'old-server': { command: 'node', args: ['old.js'] },
            'keep-me': { command: 'node', args: ['keep.js'] },
          },
        }),
      )

      const evictSpy = vi.fn()
      const service = new McpServersService({ dshHome, onEvictServer: evictSpy })
      const res = await service.saveServer({
        scope: 'user',
        name: 'renamed-server',
        originalName: 'old-server',
        server: { command: 'node', args: ['new.js'] },
      })

      expect(res.ok).toBe(true)
      const content = JSON.parse(readFileSync(userConfigPath, 'utf8'))
      expect(content.mcpServers['old-server']).toBeUndefined()
      expect(content.mcpServers['renamed-server']).toBeDefined()
      expect(content.mcpServers['keep-me']).toBeDefined()
      expect(evictSpy).toHaveBeenCalledWith('old-server')
      expect(evictSpy).toHaveBeenCalledWith('renamed-server')
    })

    it('migrates a server across scopes, cleaning up the original file and approvals', async () => {
      const userConfigPath = join(dshHome, 'mcp-adapter', 'mcp.json')
      const workspaceConfigPath = join(workspaceDir, '.mcp.json')
      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: {
            'migrating-server': { command: 'node', args: ['tool.js'] },
          },
        }),
      )

      const evictSpy = vi.fn()
      const service = new McpServersService({ dshHome, onEvictServer: evictSpy })
      const res = await service.saveServer({
        scope: 'workspace',
        cwd: workspaceDir,
        name: 'migrating-server',
        originalScope: 'user',
        server: { command: 'node', args: ['tool.js'] },
      })

      expect(res.ok).toBe(true)
      const userContent = JSON.parse(readFileSync(userConfigPath, 'utf8'))
      expect(userContent.mcpServers['migrating-server']).toBeUndefined()

      const wsContent = JSON.parse(readFileSync(workspaceConfigPath, 'utf8'))
      expect(wsContent.mcpServers['migrating-server']).toBeDefined()
      expect(evictSpy).toHaveBeenCalledWith('migrating-server')
    })
  })

  describe('deleteServer', () => {
    it('deletes server from target scope while preserving others', async () => {
      const userConfigPath = join(dshHome, 'mcp-adapter', 'mcp.json')
      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: {
            keep: { command: 'node' },
            remove: { command: 'node' },
          },
        }),
      )

      const evictSpy = vi.fn()
      const service = new McpServersService({ dshHome, onEvictServer: evictSpy })
      const res = await service.deleteServer({ scope: 'user', name: 'remove' })
      expect(res.ok).toBe(true)

      const content = JSON.parse(readFileSync(userConfigPath, 'utf8'))
      expect(content.mcpServers.keep).toBeDefined()
      expect(content.mcpServers.remove).toBeUndefined()
      expect(evictSpy).toHaveBeenCalledWith('remove')
    })

    it('returns ok: true when deleting from non-existent config file', async () => {
      const service = new McpServersService({ dshHome })
      const res = await service.deleteServer({ scope: 'workspace', cwd: workspaceDir, name: 'any' })
      expect(res.ok).toBe(true)
    })
  })

  describe('the projectServers gate on the panel rows', () => {
    const writePending = (): void => {
      writeFileSync(
        join(workspaceDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'pending-server': { command: 'node', args: ['script.js'] } } }),
      )
    }

    it('reports an unapproved workspace server as ready under allow', async () => {
      // The session mounts it without an approval record, so the row must not claim otherwise.
      writePending()
      const service = new McpServersService({ dshHome, projectServers: 'allow' })
      const result = await service.listServers({ cwd: workspaceDir, scope: 'workspace' })
      expect(result.servers[0].status).toBe('ready')
    })

    it('reports it as blocked under deny, with or without an approval record', async () => {
      writePending()
      const service = new McpServersService({ dshHome, projectServers: 'deny' })
      const result = await service.listServers({ cwd: workspaceDir, scope: 'workspace' })
      expect(result.servers[0].status).toBe('blocked')
    })

    it('follows the adapter default when the caller passes no policy', async () => {
      // A panel that guessed a different gate than the session applies is the bug this prevents.
      writePending()
      const service = new McpServersService({ dshHome })
      const result = await service.listServers({ cwd: workspaceDir, scope: 'workspace' })
      expect(result.servers[0].status).toBe('ready')
    })
  })

  describe('approveServer', () => {
    it('approves an unapproved workspace server', async () => {
      writeFileSync(
        join(workspaceDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'pending-server': { command: 'node', args: ['script.js'] },
          },
        }),
      )

      const service = new McpServersService({ dshHome, projectServers: 'ask' })
      const initial = await service.listServers({ cwd: workspaceDir, scope: 'workspace' })
      expect(initial.servers[0].status).toBe('blocked')

      const res = await service.approveServer({ cwd: workspaceDir, name: 'pending-server' })
      expect(res.ok).toBe(true)

      const updated = await service.listServers({ cwd: workspaceDir, scope: 'workspace' })
      expect(updated.servers[0].status).toBe('ready')
    })

    it('throws when server does not exist in workspace', async () => {
      const service = new McpServersService({ dshHome })
      await expect(service.approveServer({ cwd: workspaceDir, name: 'non-existent' })).rejects.toThrow(/not found/i)
    })
  })

  describe('probeServer', () => {
    it('fails a stdio command that runs but never completes the MCP handshake', async () => {
      // `node -e ""` is on PATH and exits without answering `initialize`. A probe that only
      // looked for the binary on PATH called this a success; that is the bug this test pins.
      const service = new McpServersService({ dshHome })
      const res = await service.probeServer({ command: 'node', args: ['-e', ''] })
      expect(res.ok).toBe(false)
      expect(res.toolCount).toBeUndefined()
      expect(res.error).toBeTruthy()
    })

    it('returns error for non-existent stdio command', async () => {
      const service = new McpServersService({ dshHome })
      const res = await service.probeServer({ command: 'non_existent_command_xyz_12345' })
      expect(res.ok).toBe(false)
      expect(res.error).toBeTruthy()
    })

    it('fails an HTTP URL that answers 200 but is not an MCP endpoint', async () => {
      // A bare GET returning 200 says nothing about MCP; the old probe reported this as up.
      const service = new McpServersService({ dshHome })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
      try {
        const res = await service.probeServer({ url: 'http://localhost:3000/not-mcp' })
        expect(res.ok).toBe(false)
        expect(res.error).toBeTruthy()
      } finally {
        fetchSpy.mockRestore()
      }
    })

    it('returns error when HTTP endpoint refuses the connection', async () => {
      const service = new McpServersService({ dshHome })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'))
      try {
        const res = await service.probeServer({ url: 'http://localhost:9999/mcp' })
        expect(res.ok).toBe(false)
        expect(res.error).toBeTruthy()
      } finally {
        fetchSpy.mockRestore()
      }
    })

    it('returns error when neither command nor url is given', async () => {
      const service = new McpServersService({ dshHome })
      const res = await service.probeServer({})
      expect(res.ok).toBe(false)
      expect(res.error).toBeTruthy()
    })

    it('refuses a disabled entry instead of starting it', async () => {
      const service = new McpServersService({ dshHome })
      const res = await service.probeServer({ command: 'node', args: ['-e', ''], disabled: true })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/disabled/i)
    })
  })

  describe('monorepo subdirectory resolution to workspaceRoot', () => {
    it('resolves .mcp.json at git root when cwd is a nested subdirectory', async () => {
      mkdirSync(join(workspaceDir, '.git'), { recursive: true })
      const subDir = join(workspaceDir, 'packages', 'app', 'src')
      mkdirSync(subDir, { recursive: true })

      const service = new McpServersService({ dshHome })

      await service.saveServer({
        scope: 'workspace',
        cwd: subDir,
        name: 'sub-server',
        server: { command: 'node', args: ['sub.js'] },
      })

      expect(existsSync(join(workspaceDir, '.mcp.json'))).toBe(true)
      expect(existsSync(join(subDir, '.mcp.json'))).toBe(false)

      const list = await service.listServers({ cwd: subDir, scope: 'workspace' })
      expect(list.workspaceRoot).toBe(workspaceDir)
      expect(list.servers.some((s) => s.name === 'sub-server')).toBe(true)

      await service.deleteServer({ scope: 'workspace', cwd: subDir, name: 'sub-server' })
      const listAfter = await service.listServers({ cwd: subDir, scope: 'workspace' })
      expect(listAfter.servers.some((s) => s.name === 'sub-server')).toBe(false)
    })
  })
})

describe('McpServersService workspace enumeration', () => {
  let tmpRoot: string
  let dshHome: string
  let activeDir: string
  let otherDir: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-service-ws-'))
    dshHome = join(tmpRoot, 'dsh-home')
    activeDir = join(tmpRoot, 'active')
    otherDir = join(tmpRoot, 'other')
    mkdirSync(join(dshHome, 'mcp-adapter'), { recursive: true })
    mkdirSync(activeDir, { recursive: true })
    mkdirSync(otherDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('lists every registered workspace in registry order', async () => {
    const service = new McpServersService({
      dshHome,
      workspaces: () => [
        { path: otherDir, title: 'other-project' },
        { path: activeDir, title: 'active-project' },
      ],
    })

    const result = await service.listServers({ cwd: activeDir })

    // Order must not depend on which workspace is being viewed, or the menu reshuffles under the
    // pointer every time the user picks one.
    expect(result.workspaces.map((ws) => ws.title)).toEqual(['other-project', 'active-project'])
  })

  it('appends the active root when the registry does not know it', async () => {
    const service = new McpServersService({
      dshHome,
      workspaces: () => [{ path: otherDir, title: 'other-project' }],
    })

    const result = await service.listServers({ cwd: activeDir })

    expect(result.workspaces.map((ws) => ws.path)).toEqual([otherDir, activeDir])
  })

  it('reads the workspace picked by the client, not the active root', async () => {
    writeFileSync(
      join(otherDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'other-server': { command: 'node' } } }),
    )
    const service = new McpServersService({
      dshHome,
      workspaces: () => [{ path: otherDir, title: 'other-project' }],
    })

    const result = await service.listServers({ cwd: otherDir, scope: 'workspace' })

    expect(result.workspaceRoot).toBe(otherDir)
    expect(result.servers.map((s) => s.name)).toEqual(['other-server'])
  })

  it('degrades to the active root when the registry throws or is absent', async () => {
    const throwing = new McpServersService({
      dshHome,
      workspaces: () => {
        throw new Error('registry unavailable')
      },
    })
    expect((await throwing.listServers({ cwd: activeDir })).workspaces).toEqual([
      { path: activeDir, title: 'active' },
    ])

    const absent = new McpServersService({ dshHome })
    expect((await absent.listServers({ cwd: activeDir })).workspaces).toHaveLength(1)
  })

  describe('presets', () => {
    it('lists known curated presets', () => {
      const service = new McpServersService({ dshHome })
      const presets = service.listPresets()
      expect(presets.length).toBeGreaterThanOrEqual(6)
      const ids = presets.map((p) => p.id)
      expect(ids).toContain('github')
      expect(ids).toContain('chrome-devtools')
      expect(ids).toContain('context7')
      expect(ids).toContain('parallel-search')
    })

    it('installs a preset into workspace scope with env overrides', async () => {
      const service = new McpServersService({ dshHome })
      const result = await service.installPreset({
        presetId: 'github',
        scope: 'workspace',
        cwd: activeDir,
        envOverrides: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret123' },
      })

      expect(result.ok).toBe(true)
      expect(result.serverName).toBe('GitHub')

      const savedJson = JSON.parse(readFileSync(join(activeDir, '.mcp.json'), 'utf8'))
      expect(savedJson.mcpServers.github).toBeDefined()
      expect(savedJson.mcpServers.github.command).toBe('npx')
      expect(savedJson.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_secret123')
    })

    it('rejects an unknown preset id', async () => {
      const service = new McpServersService({ dshHome })
      await expect(service.installPreset({
        presetId: 'non-existent-preset',
        scope: 'workspace',
        cwd: activeDir,
      })).rejects.toThrow('Unknown preset id')
    })
  })
})
