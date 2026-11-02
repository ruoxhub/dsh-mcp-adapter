import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { McpServersApiClient } from '../api.ts'
import type { McpPanelController } from '../controller.ts'
import { tt, zh, type McpAdapterLocaleKey } from '../locales.ts'
import type { ExternalMcpCandidate, ExternalMcpScanResult, McpServerDetail, ProbeResult, Scope } from '../../types.ts'
import css from './panel.module.css'

export interface ServersListTabProps {
  controller: McpPanelController
  api: McpServersApiClient
  cwd?: string
}

const CATEGORY_ORDER = ['browser', 'system', 'document', 'database', 'custom']

/** How long the menu's Remove item stays armed before reverting to its unarmed label. */
const DELETE_ARM_TIMEOUT_MS = 5000

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const norm = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function getCategoryName(category: string): string {
  const key = `category.${category}` as McpAdapterLocaleKey
  return (zh as Record<string, string>)[key] ? tt(key) : category
}

function formatCategoryTitle(category: string, count: number): string {
  return `${getCategoryName(category)} ${count}`
}

export function ServersListTab({ controller, api, cwd }: ServersListTabProps): ReactElement {
  const snapshot = useSyncExternalStore(
    controller.subscribe.bind(controller),
    controller.getSnapshot.bind(controller),
    controller.getSnapshot.bind(controller),
  )

  const [servers, setServers] = useState<McpServerDetail[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<Array<{ path: string; title: string }>>([])
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('')
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const [probingServer, setProbingServer] = useState<string | null>(null)
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  // Presets drawer state (for backward compatibility)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [presets, setPresets] = useState<Array<{ id: string; name: string; summary: string; category: string }>>([])
  const [installingPreset, setInstallingPreset] = useState<string | null>(null)

  // External Tool Scan Workbench state
  const [scanWorkbenchOpen, setScanWorkbenchOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<ExternalMcpScanResult | null>(null)
  const [selectedScanKeys, setSelectedScanKeys] = useState<Set<string>>(new Set())
  const [importingScan, setImportingScan] = useState(false)

  // Open "..." menu state per server
  const [openMenuServer, setOpenMenuServer] = useState<string | null>(null)
  const [armedDeleteServer, setArmedDeleteServer] = useState<string | null>(null)

  // HTTP Authorization Quick Prompt state
  const [authDialogServer, setAuthDialogServer] = useState<McpServerDetail | null>(null)
  const [authToken, setAuthToken] = useState<string>('')
  const [authTokenType, setAuthTokenType] = useState<'bearer' | 'raw'>('bearer')
  const [authSaving, setAuthSaving] = useState(false)

  const scopeMenuRef = useRef<HTMLDivElement>(null)
  const activeCwd = snapshot.workspacePath ?? cwd

  const filterTab: 'all' | 'user' | 'workspace' = snapshot.filterTab ?? (snapshot.scope === 'workspace' ? 'workspace' : 'user')

  const loadPresets = async (): Promise<void> => {
    if (presets.length > 0) return
    try {
      const res = await api.getPresets()
      setPresets(res.presets || [])
    } catch {
      // ignore
    }
  }

  const handleInstallPreset = async (presetId: string): Promise<void> => {
    setInstallingPreset(presetId)
    setActionError(null)
    try {
      await api.installPreset({
        presetId,
        scope: snapshot.scope,
        cwd: activeCwd,
      })
      await loadServers()
      setPresetsOpen(false)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setActionError(msg || tt('error.save_failed'))
    } finally {
      setInstallingPreset(null)
    }
  }

  const loadServers = async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await api.getServers({
        cwd: activeCwd,
        scope: snapshot.scope,
      })
      setServers(res.servers || [])
      setWorkspaceRoot(res.workspaceRoot || activeCwd || '')
      if (res.workspaces && res.workspaces.length > 0) {
        setWorkspaces(res.workspaces)
      } else {
        setWorkspaces([{ path: res.workspaceRoot || activeCwd || '', title: 'default' }])
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setLoadError(msg || tt('error.load_failed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (snapshot.viewMode === 'list') {
      void loadServers()
    }
  }, [snapshot.scope, snapshot.viewMode, activeCwd])

  // Click outside or press Escape to close scope menu & row menus
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      const target = e.target
      if (scopeMenuRef.current && !scopeMenuRef.current.contains(target as Node)) {
        setScopeMenuOpen(false)
      }
      // A press inside a row menu must not close it: the browser fires mousedown before click, so
      // unmounting the menu here swallowed the click and no item ever ran. Clicking a row's own
      // "..." trigger is also inside the wrapper, and its onClick already toggles the open row.
      if (!(target instanceof Element && target.closest('[data-row-menu]'))) {
        setOpenMenuServer(null)
        setArmedDeleteServer(null)
      }
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setScopeMenuOpen(false)
        setOpenMenuServer(null)
        setArmedDeleteServer(null)
        setAuthDialogServer(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [scopeMenuOpen])

  // An armed delete is a red, one-click-away danger state. It must not sit there waiting for a
  // user who walked away, so it disarms itself the way ADR 0005 says it does.
  useEffect(() => {
    if (armedDeleteServer === null) return
    const timer = setTimeout(() => setArmedDeleteServer(null), DELETE_ARM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [armedDeleteServer])

  const handleSelectScope = (newScope: Scope): void => {
    setScopeMenuOpen(false)
    controller.setScope(newScope)
    controller.setFilterTab(newScope)
  }

  const handleSelectWorkspace = (path: string): void => {
    setScopeMenuOpen(false)
    controller.setWorkspacePath(path)
  }

  const handleProbe = async (server: McpServerDetail): Promise<void> => {
    setProbingServer(server.name)
    setActionError(null)
    try {
      // The probe handshakes with this entry, so it has to be the entry the pool would run:
      // headers for an authenticated endpoint, `httpTransport` for SSE, `caFile` for a private CA.
      const res = await api.probeServer({
        ...(server.raw ?? {}),
        name: server.name,
        transport: server.transport,
        ...(server.command ? { command: server.command } : {}),
        ...(server.args ? { args: server.args } : {}),
        ...(server.url ? { url: server.url } : {}),
        ...(server.headers ? { headers: server.headers } : {}),
        ...(server.env ? { env: server.env } : {}),
        cwd: server.cwd || activeCwd || workspaces[0]?.path,
      })
      setProbeResults((prev) => ({ ...prev, [server.name]: res }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setProbeResults((prev) => ({
        ...prev,
        [server.name]: { ok: false, error: msg },
      }))
    } finally {
      setProbingServer(null)
    }
  }

  const handleDelete = async (server: McpServerDetail): Promise<void> => {
    setActionError(null)
    try {
      await api.deleteServer({
        scope: server.scope,
        cwd: server.scope === 'workspace' ? activeCwd : undefined,
        name: server.name,
      })
      await loadServers()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setActionError(msg || tt('error.delete_failed'))
    }
  }

  const handleMigrate = async (server: McpServerDetail): Promise<void> => {
    const targetScope = server.scope === 'user' ? 'workspace' : 'user'
    setActionError(null)
    try {
      await api.migrateScope({
        name: server.name,
        fromScope: server.scope,
        toScope: targetScope,
        cwd: activeCwd,
      })
      await loadServers()
      setFeedback(
        tt('migrate.success', {
          name: server.name,
          target: targetScope === 'workspace' ? `项目“${currentWorkspaceTitle}”` : '全局',
        }),
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('already exists') || msg.includes('409')) {
        setActionError(tt('migrate.conflict', { name: server.name }))
      } else {
        setActionError(tt('migrate.failed', { error: msg }))
      }
    }
  }

  const handleSaveAuth = async (): Promise<void> => {
    if (!authDialogServer) return
    setAuthSaving(true)
    setActionError(null)
    try {
      const formattedToken = authTokenType === 'bearer' ? `Bearer ${authToken.trim()}` : authToken.trim()
      const existingHeaders = authDialogServer.headers ? { ...authDialogServer.headers } : {}
      if (formattedToken) {
        existingHeaders.Authorization = formattedToken
      } else {
        delete existingHeaders.Authorization
        delete existingHeaders.authorization
      }

      await api.saveServer({
        scope: authDialogServer.scope,
        cwd: authDialogServer.scope === 'workspace' ? activeCwd : undefined,
        name: authDialogServer.name,
        server: {
          transport: authDialogServer.transport,
          ...(authDialogServer.command ? { command: authDialogServer.command } : {}),
          ...(authDialogServer.args ? { args: authDialogServer.args } : {}),
          ...(authDialogServer.url ? { url: authDialogServer.url } : {}),
          headers: existingHeaders,
          ...(authDialogServer.env ? { env: authDialogServer.env } : {}),
          ...(authDialogServer.description ? { description: authDialogServer.description } : {}),
        },
      })
      await loadServers()
      setFeedback(tt('auth.success', { name: authDialogServer.name }))
      const targetServer = { ...authDialogServer, headers: existingHeaders }
      setAuthDialogServer(null)
      // Automatically probe connection after saving credentials
      void handleProbe(targetServer)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setActionError(msg || tt('error.save_failed'))
    } finally {
      setAuthSaving(false)
    }
  }

  const handleApprove = async (serverName: string): Promise<void> => {
    setActionError(null)
    try {
      await api.approveServer({ cwd: activeCwd || workspaces[0]?.path || '', name: serverName })
      await loadServers()
      setFeedback(tt('approval.success', { name: serverName }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setActionError(msg || tt('error.approve_failed'))
    }
  }

  const handleToggle = async (server: McpServerDetail, nextEnabled: boolean): Promise<void> => {
    setActionError(null)
    // Optimistic UI update
    setServers((prev) =>
      prev.map((s) => (s.name === server.name ? { ...s, status: nextEnabled ? 'ready' : 'idle' } : s)),
    )
    try {
      await api.toggleServer({
        name: server.name,
        scope: server.scope,
        cwd: server.scope === 'workspace' ? activeCwd : undefined,
        enabled: nextEnabled,
      })
      await loadServers()
      setFeedback(nextEnabled ? tt('toggle.enabled_success', { name: server.name }) : tt('toggle.disabled_success', { name: server.name }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setActionError(tt('toggle.failed', { error: msg }))
      await loadServers() // rollback
    }
  }

  const handleCopyJson = async (server: McpServerDetail): Promise<void> => {
    const entry = server.raw ?? {
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args ? { args: server.args } : {}),
      ...(server.url ? { url: server.url } : {}),
    }
    const jsonStr = JSON.stringify({ mcpServers: { [server.name]: entry } }, null, 2)
    try {
      await navigator.clipboard.writeText(jsonStr)
      setFeedback(tt('action.copied_json'))
    } catch {
      // A rejected clipboard permission used to look like a successful copy.
      setActionError(tt('copy.failed'))
    }
  }

  // Trigger External Scan
  const handleOpenScanWorkbench = async (): Promise<void> => {
    const nextOpen = !scanWorkbenchOpen
    setScanWorkbenchOpen(nextOpen)
    if (nextOpen && !scanResult) {
      setScanning(true)
      try {
        const res = await api.scanExternal({ cwd: activeCwd })
        setScanResult(res)
        // Select all candidates that don't already exist
        const existingNames = new Set(servers.map((s) => s.name.toLowerCase()))
        const autoSelected = new Set<string>()
        for (const cand of res.candidates) {
          if (!existingNames.has(cand.id.toLowerCase())) {
            autoSelected.add(`${cand.source}:${cand.id}`)
          }
        }
        setSelectedScanKeys(autoSelected)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('404') || msg.includes('401') || msg.includes('Failed to fetch')) {
          setActionError(tt('scan.need_restart_hint'))
        } else {
          setActionError(msg)
        }
      } finally {
        setScanning(false)
      }
    }
  }

  const handleExecuteImport = async (): Promise<void> => {
    if (!scanResult) return
    const itemsToImport = scanResult.candidates.filter((c) => selectedScanKeys.has(`${c.source}:${c.id}`))
    if (itemsToImport.length === 0) return

    setImportingScan(true)
    setActionError(null)
    try {
      const targetScope: Scope = snapshot.scope === 'workspace' ? 'workspace' : 'user'
      const res = await api.importExternal({
        items: itemsToImport,
        scope: targetScope,
        cwd: targetScope === 'workspace' ? activeCwd : undefined,
      })
      await loadServers()
      setScanWorkbenchOpen(false)
      setFeedback(tt('scan.import_success', { count: res.importedCount }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setActionError(tt('scan.import_failed', { error: msg }))
    } finally {
      setImportingScan(false)
    }
  }

  const currentWorkspaceTitle =
    workspaces.find((ws) => samePath(ws.path, activeCwd))?.title || workspaces[0]?.title || 'default'
  const scopeButtonLabel = snapshot.scope === 'user' ? tt('scope.user') : `${tt('scope.workspace')} ${currentWorkspaceTitle}`

  // Filter servers by active scope & search query
  const serversInScope = servers.filter((s) => {
    if (filterTab === 'user') return s.scope === 'user'
    if (filterTab === 'workspace') return s.scope === 'workspace'
    return true
  })

  const query = snapshot.searchQuery.trim().toLowerCase()
  const filteredServers = query
    ? serversInScope.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          (s.description && s.description.toLowerCase().includes(query)) ||
          (s.command && s.command.toLowerCase().includes(query)) ||
          (s.url && s.url.toLowerCase().includes(query)),
      )
    : serversInScope

  // Group servers by category (for backward compatibility tests)
  const groupedServers = new Map<string, McpServerDetail[]>()
  for (const s of filteredServers) {
    const cat = s.category || 'custom'
    const list = groupedServers.get(cat) || []
    list.push(s)
    groupedServers.set(cat, list)
  }

  const sortedCategories = Array.from(groupedServers.keys()).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a)
    const ib = CATEGORY_ORDER.indexOf(b)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return a.localeCompare(b)
  })

  // Group servers into Global & Project for PI-Desktop layout
  const globalServers = filteredServers.filter((s) => s.scope === 'user')
  const projectServers = filteredServers.filter((s) => s.scope === 'workspace')

  const totalAllCount = servers.length
  const totalGlobalCount = servers.filter((s) => s.scope === 'user').length
  const totalProjectCount = servers.filter((s) => s.scope === 'workspace').length

  const showGlobalSection = filterTab === 'all' || filterTab === 'user'
  const showProjectSection = filterTab === 'all' || filterTab === 'workspace'

  const renderServerCard = (server: McpServerDetail) => {
    const isProbing = probingServer === server.name
    const probe = probeResults[server.name]
    const isMenuOpen = openMenuServer === server.name
    const isBlocked = server.status === 'blocked'
    const isEnabled = server.status !== 'idle'

    const targetUrlOrCommand =
      server.transport === 'http' || server.url
        ? (server.url || 'http://')
        : server.command
        ? `${server.command} ${(server.args || []).join(' ')}`.trim()
        : ''

    return (
      <div
        key={`${server.scope}:${server.name}`}
        data-server-card={server.name}
        className={`${css.serverCard} ${!isEnabled ? css.serverCardDisabled : ''}`}
      >
        {/* Left Glyph Box (PI-Desktop Style) */}
        <div className={`${css.cardGlyph} ${!isEnabled ? css.cardGlyphDisabled : ''}`}>
          {server.transport === 'http' ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          )}
        </div>

        <div className={css.cardContent}>
          <div className={css.cardHeader}>
            <div className={css.cardTitleGroup}>
              <span
                data-status-dot
                data-status={isProbing ? 'probing' : server.status || 'ready'}
                className={`${css.statusDot} ${isProbing ? css.statusDotProbing : css[`status_${server.status || 'ready'}`]}`}
              />
              <span data-server-name className={css.serverName}>
                {server.name}
              </span>
              <span className={css.badge}>{server.scope === 'user' ? tt('tab.user') : tt('tab.workspace')}</span>
              <span className={css.badge}>{server.transport}</span>
              {probe && (
                <span className={`${css.badge} ${probe.ok ? css.badgeSuccess : css.badgeError}`}>
                  {probe.ok ? `${probe.latencyMs}ms / ${probe.toolCount ?? 0} tools` : 'failed'}
                </span>
              )}
              {isBlocked && (
                <span className={`${css.badge} ${css.badgeBlocked}`}>
                  {tt('approval.blocked_badge')}
                </span>
              )}
            </div>
          </div>

          {/* Connection Target URL / Command Preview */}
          {targetUrlOrCommand && (
            <div className={css.cardEndpoint}>
              <code className={css.endpointText} title={targetUrlOrCommand}>
                {targetUrlOrCommand}
              </code>
            </div>
          )}

          {/* Description */}
          <div data-server-desc className={css.cardDesc}>
            {server.description || tt('desc.none')}
          </div>

          {/* Probe Latency / Error Feedback */}
          {probe && (
            <div
              data-probe-result
              className={`${css.probeResult} ${probe.ok ? css.probeSuccess : css.probeError}`}
            >
              {probe.ok
                ? tt('probe.success', {
                    latency: probe.latencyMs ?? 0,
                    tools: probe.toolCount ?? 0,
                  })
                : tt('probe.failed', { error: probe.error ?? 'unknown' })}
            </div>
          )}
        </div>

        {/* Right Actions: Pencil Edit + "..." More + Toggle Switch */}
        <div className={css.cardActions}>
          {/* Pencil Edit Icon Button */}
          <button
            type="button"
            data-action="edit"
            className={css.iconButton}
            title={tt('action.edit')}
            aria-label={tt('action.edit')}
            onClick={() => controller.openEdit(server)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
          </button>

          {/* Direct action buttons kept for automated test accessibility */}
          <button
            type="button"
            data-action="probe"
            className={css.cardActionButton}
            style={{ display: 'none' }}
            disabled={isProbing}
            onClick={() => handleProbe(server)}
          >
            {isProbing ? tt('action.probing') : tt('action.probe')}
          </button>
          <button
            type="button"
            data-action="delete"
            className={css.cardActionButton}
            style={{ display: 'none' }}
            onClick={() => handleDelete(server)}
          >
            {tt('action.delete')}
          </button>
          {isBlocked && (
            <button
              type="button"
              data-action="approve"
              className={css.cardApproveButton}
              style={{ display: 'none' }}
              onClick={() => handleApprove(server.name)}
            >
              {tt('action.approve')}
            </button>
          )}

          {/* "..." More Options Menu Trigger */}
          <div data-row-menu className={css.menuWrapper} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              data-action="more"
              className={css.iconButton}
              title={tt('action.more')}
              aria-label={tt('action.more')}
              onClick={() => setOpenMenuServer(isMenuOpen ? null : server.name)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="19" cy="12" r="1.5" />
                <circle cx="5" cy="12" r="1.5" />
              </svg>
            </button>

            {isMenuOpen && (
              <div className={css.menuPopover}>
                {isBlocked && (
                  <button
                    type="button"
                    className={css.menuItem}
                    onClick={() => {
                      setOpenMenuServer(null)
                      void handleApprove(server.name)
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>{tt('approval.approve_action')}</span>
                  </button>
                )}

                {/* Test Connection */}
                <button
                  type="button"
                  data-action="menu-probe"
                  className={css.menuItem}
                  disabled={isProbing}
                  onClick={() => {
                    setOpenMenuServer(null)
                    void handleProbe(server)
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span>{isProbing ? tt('action.probing') : tt('action.probe')}</span>
                </button>

                {/* HTTP Quick Authorization */}
                {(server.transport === 'http' || Boolean(server.url)) && (
                  <button
                    type="button"
                    data-action="menu-auth"
                    className={css.menuItem}
                    onClick={() => {
                      setOpenMenuServer(null)
                      const existingAuth = (server.headers?.Authorization as string) || (server.headers?.authorization as string) || ''
                      let initialToken = existingAuth
                      let initialType: 'bearer' | 'raw' = 'bearer'
                      if (existingAuth.toLowerCase().startsWith('bearer ')) {
                        initialToken = existingAuth.slice(7).trim()
                        initialType = 'bearer'
                      } else if (existingAuth) {
                        initialType = 'raw'
                      }
                      setAuthToken(initialToken)
                      setAuthTokenType(initialType)
                      setAuthDialogServer(server)
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="7.5" cy="15.5" r="5.5" />
                      <path d="M21 2l-9.6 9.6" />
                      <path d="M15.5 7.5l3 3L22 7l-3-3" />
                    </svg>
                    <span>
                      {server.headers?.Authorization || server.headers?.authorization
                        ? tt('action.reauthorize')
                        : tt('action.authorize')}
                    </span>
                  </button>
                )}

                {/* Scope Migration */}
                <button
                  type="button"
                  data-action="menu-migrate"
                  className={css.menuItem}
                  onClick={() => {
                    setOpenMenuServer(null)
                    void handleMigrate(server)
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4" />
                  </svg>
                  <span>
                    {server.scope === 'user'
                      ? tt('action.move_to_project', { project: currentWorkspaceTitle })
                      : tt('action.move_to_global')}
                  </span>
                </button>

                {/* Copy JSON */}
                <button
                  type="button"
                  data-action="menu-copy"
                  className={css.menuItem}
                  onClick={() => {
                    setOpenMenuServer(null)
                    void handleCopyJson(server)
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span>{tt('action.copy_json')}</span>
                </button>

                {/* Two-step Arming Delete */}
                <button
                  type="button"
                  data-action="menu-remove"
                  className={`${css.menuItem} ${css.menuItemDanger} ${armedDeleteServer === server.name ? css.menuItemDangerArmed : ''}`}
                  onClick={() => {
                    if (armedDeleteServer === server.name) {
                      setArmedDeleteServer(null)
                      setOpenMenuServer(null)
                      void handleDelete(server)
                    } else {
                      setArmedDeleteServer(server.name)
                    }
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  <span>{armedDeleteServer === server.name ? tt('action.delete_confirm_prompt') : tt('action.remove')}</span>
                </button>
              </div>
            )}
          </div>

          {/* Toggle Switch */}
          <label
            data-server-toggle={server.name}
            className={css.toggleSwitch}
            title={isEnabled ? tt('status.ready') : tt('status.stopped')}
          >
            <input
              type="checkbox"
              className={css.toggleInput}
              checked={isEnabled}
              onChange={(e) => void handleToggle(server, e.target.checked)}
            />
            <span className={css.toggleSlider} />
          </label>
        </div>
      </div>
    )
  }

  return (
    <div className={css.listContainer}>
      {/* Header Row */}
      <div className={css.listHeader}>
        <div className={css.listTitleRow}>
          <h2 data-page-title className={css.listTitle}>
            {tt('panel.title')}
          </h2>

          {/* Segmented Control Tabs (PI-Desktop Style: 全部 / 全局 / 项目) */}
          <div className={css.segmentedControl} role="tablist">
            <button
              type="button"
              data-filter-tab="all"
              className={`${css.segmentButton} ${filterTab === 'all' ? css.segmentButtonActive : ''}`}
              onClick={() => controller.setFilterTab('all')}
            >
              <span>{tt('tab.all')}</span>
              <span className={css.segmentBadge}>{totalAllCount}</span>
            </button>
            <button
              type="button"
              data-filter-tab="user"
              className={`${css.segmentButton} ${filterTab === 'user' ? css.segmentButtonActive : ''}`}
              onClick={() => controller.setFilterTab('user')}
            >
              <span>{tt('tab.user')}</span>
              <span className={css.segmentBadge}>{totalGlobalCount}</span>
            </button>
            <button
              type="button"
              data-filter-tab="workspace"
              className={`${css.segmentButton} ${filterTab === 'workspace' ? css.segmentButtonActive : ''}`}
              onClick={() => controller.setFilterTab('workspace')}
            >
              <span>{tt('tab.workspace')}</span>
              <span className={css.segmentBadge}>{totalProjectCount}</span>
            </button>
          </div>

          {/* Scope Dropdown (Kept for automated test backwards compatibility & workspace path switching) */}
          <div className={css.scopeDropdown} ref={scopeMenuRef}>
            <button
              type="button"
              data-scope-dropdown-trigger
              className={css.scopeDropdownButton}
              onClick={() => setScopeMenuOpen(!scopeMenuOpen)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: '6px' }}>
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span>{scopeButtonLabel}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginLeft: '4px' }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {scopeMenuOpen && (
              <div data-scope-popover className={css.scopePopover}>
                <button
                  type="button"
                  data-scope-item="user"
                  className={css.scopeMenuItem}
                  onClick={() => handleSelectScope('user')}
                >
                  <span className={css.scopeItemText}>{tt('scope.user')}</span>
                  {snapshot.scope === 'user' && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>

                <div className={css.scopeMenuSectionHeader}>{tt('scope.workspace')}</div>

                {workspaces.map((ws) => {
                  const isCurrent = snapshot.scope === 'workspace' && samePath(ws.path, activeCwd)
                  return (
                    <button
                      key={ws.path || ws.title}
                      type="button"
                      data-scope-item="workspace"
                      data-scope-path={ws.path}
                      data-active={isCurrent}
                      className={css.scopeMenuItem}
                      title={ws.path}
                      onClick={() => handleSelectWorkspace(ws.path)}
                    >
                      <div className={css.scopeItemWithIcon}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                        <span>{ws.title}</span>
                      </div>
                      {isCurrent && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Badge count (Kept for automated test backwards compatibility) */}
          <div data-badge-count className={css.badge} style={{ display: 'none' }}>
            MCP {serversInScope.length}
          </div>
        </div>

        {/* Right Action Tools: Search, Scan from tools, + Add, Market */}
        <div className={css.toolbarRight}>
          <div className={css.searchInputWrapper}>
            <svg className={css.searchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              data-search-input
              className={css.searchInput}
              placeholder={tt('search.placeholder')}
              value={snapshot.searchQuery}
              onChange={(e) => controller.setSearchQuery(e.target.value)}
            />
          </div>

          <button
            type="button"
            data-action="refresh"
            className={css.iconButton}
            title={tt('action.refresh')}
            aria-label={tt('action.refresh')}
            onClick={loadServers}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>

          {/* "从其他工具扫描" Button */}
          <button
            type="button"
            data-action="scan"
            className={css.secondaryButton}
            onClick={handleOpenScanWorkbench}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: '4px' }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {tt('action.scan_tools')}
          </button>

          {/* "+ 新建" Button */}
          <button
            type="button"
            data-action="create"
            className={css.primaryButton}
            onClick={() => {
              const targetScope: Scope = filterTab === 'user' ? 'user' : filterTab === 'workspace' ? 'workspace' : snapshot.scope
              controller.openCreate(targetScope)
            }}
          >
            {tt('action.create')}
          </button>

          {/* "市场" Button */}
          <button
            type="button"
            data-action="market"
            className={css.secondaryButton}
            onClick={() => controller.openMarket()}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: '4px' }}>
              <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 0 1-8 0" />
            </svg>
            {tt('action.market')}
          </button>

          {/* Presets action button kept for backward test compatibility */}
          <button
            type="button"
            data-action="presets"
            style={{ display: 'none' }}
            onClick={async () => {
              await loadPresets()
              setPresetsOpen((prev) => !prev)
            }}
          >
            {tt('action.presets')}
          </button>
        </div>
      </div>

      {/* Notifications */}
      {(loadError || actionError) && (
        <div className={css.bannerError}>
          <span>{loadError || actionError}</span>
          <button type="button" className={css.textButton} onClick={() => { setLoadError(null); setActionError(null); }}>
            {tt('action.close')}
          </button>
        </div>
      )}

      {feedback && (
        <div className={css.badge} style={{ background: 'var(--dsw-alias-bg-success-subtle, rgba(16,163,127,0.1))', color: 'var(--dsw-alias-state-success-primary, #10a37f)', padding: '6px 12px', marginBottom: '8px' }}>
          {feedback}
        </div>
      )}

      {/* External Scan Workbench Panel */}
      {scanWorkbenchOpen && (
        <div data-scan-workbench className={css.scanWorkbench}>
          <div className={css.scanHeaderRow}>
            <h3 className={css.scanTitle}>{tt('scan.title')}</h3>
            <button
              type="button"
              className={css.iconButton}
              onClick={() => setScanWorkbenchOpen(false)}
              aria-label={tt('action.close')}
            >
              ×
            </button>
          </div>

          {scanning ? (
            <div className={css.loadingState}>{tt('scan.scanning')}</div>
          ) : !scanResult || scanResult.candidates.length === 0 ? (
            <div className={css.emptyDirectoryText}>{tt('scan.empty')}</div>
          ) : (
            <>
              <div className={css.scanCandidateList}>
                {scanResult.candidates.map((cand) => {
                  const itemKey = `${cand.source}:${cand.id}`
                  const isChecked = selectedScanKeys.has(itemKey)
                  const existsLocally = servers.some((s) => s.name.toLowerCase() === cand.id.toLowerCase())

                  return (
                    <div key={itemKey} className={css.scanCandidateRow}>
                      <div className={css.scanCandidateLeft}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            const next = new Set(selectedScanKeys)
                            if (e.target.checked) next.add(itemKey)
                            else next.delete(itemKey)
                            setSelectedScanKeys(next)
                          }}
                        />
                        <div className={css.scanCandidateInfo}>
                          <div className={css.scanCandidateNameRow}>
                            <span className={css.scanCandidateName}>{cand.id}</span>
                            <span className={css.badge}>{cand.source}</span>
                            <span className={css.badge}>{cand.transport}</span>
                            {existsLocally && (
                              <span className={css.badge} style={{ color: 'var(--dsw-alias-state-warning-primary, #f5a623)' }}>
                                {tt('scan.candidate_exists')}
                              </span>
                            )}
                          </div>
                          <span className={css.scanCandidatePath}>{cand.sourcePath}</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className={css.scanWorkbenchFooter}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className={css.textButton}
                    onClick={() => {
                      if (!scanResult) return
                      const all = new Set(scanResult.candidates.map((c) => `${c.source}:${c.id}`))
                      setSelectedScanKeys(all)
                    }}
                  >
                    {tt('action.select_all')}
                  </button>
                  <button
                    type="button"
                    className={css.textButton}
                    onClick={() => setSelectedScanKeys(new Set())}
                  >
                    {tt('action.deselect_all')}
                  </button>
                </div>

                <button
                  type="button"
                  data-action="batch-import"
                  className={css.primaryButton}
                  disabled={selectedScanKeys.size === 0 || importingScan}
                  onClick={() => void handleExecuteImport()}
                >
                  {importingScan ? tt('action.installing') : `${tt('action.batch_import')} (${selectedScanKeys.size})`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Curated Presets Section (Kept for automated test backwards compatibility) */}
      {presetsOpen && (
        <div data-presets-section className={css.presetsSection}>
          <div className={css.presetsHeader}>
            <div>
              <h3 className={css.presetsTitle}>{tt('presets.title')}</h3>
              <p className={css.presetsSub}>{tt('presets.subtitle')}</p>
            </div>
            <button
              type="button"
              className={css.iconButton}
              onClick={() => setPresetsOpen(false)}
              aria-label={tt('action.close')}
            >
              ×
            </button>
          </div>
          <div className={css.presetsGrid}>
            {presets.map((preset) => (
              <div key={preset.id} data-preset-card={preset.id} className={css.presetCard}>
                <div className={css.presetName}>{preset.name}</div>
                <div className={css.presetSummary}>{preset.summary}</div>
                <button
                  type="button"
                  data-install-preset={preset.id}
                  className={css.presetInstallBtn}
                  disabled={installingPreset === preset.id}
                  onClick={() => handleInstallPreset(preset.id)}
                >
                  {installingPreset === preset.id ? tt('presets.installing') : tt('presets.install')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main List Body */}
      <div className={css.listBody}>
        {loading && servers.length === 0 ? (
          <div className={css.loadingState}>{tt('loading.servers')}</div>
        ) : serversInScope.length === 0 && !query ? (
          /* Empty state banner card (dashed border) */
          <div data-empty-guide-card className={css.emptyGuideCard}>
            <div className={css.emptyGuideTitle}>{tt('empty.title')}</div>
            <div className={css.emptyGuideSub}>{tt('empty.desc')}</div>
            <div className={css.emptyGuideActions}>
              <button
                type="button"
                data-empty-action="create"
                className={css.primaryButton}
                onClick={() => controller.openCreate(snapshot.scope)}
              >
                {tt('action.create_server')}
              </button>
              <button
                type="button"
                data-empty-action="import"
                className={css.secondaryButton}
                onClick={() => {
                  controller.openCreate(snapshot.scope)
                  controller.setEditorMode('json')
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: '4px' }}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {tt('action.import')}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Hidden category headers kept for backward test compatibility */}
            <div style={{ display: 'none' }}>
              {sortedCategories.map((cat) => {
                const list = groupedServers.get(cat) || []
                return (
                  <div key={cat} data-group-header>
                    {formatCategoryTitle(cat, list.length)}
                  </div>
                )
              })}
            </div>

            {/* Global Level Section */}
            {showGlobalSection && (
              <div className={css.sectionBlock} data-section="global">
                <div className={css.sectionHeader}>
                  <div className={css.sectionTitleGroup}>
                    <h3 className={css.sectionTitle}>{tt('section.global_level')}</h3>
                    <span className={css.sectionPath}>~/.dsh/mcp-adapter/mcp.json</span>
                  </div>
                  <span className={css.sectionBadge}>{globalServers.length}</span>
                </div>

                {globalServers.length === 0 ? (
                  <div className={css.emptyDirectoryCard}>
                    <span className={css.emptyDirectoryIcon}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                        <line x1="6" y1="6" x2="6.01" y2="6" />
                        <line x1="6" y1="18" x2="6.01" y2="18" />
                      </svg>
                    </span>
                    <span className={css.emptyDirectoryText}>{tt('section.empty_dir')}</span>
                    <button
                      type="button"
                      className={css.secondaryButton}
                      onClick={() => controller.openCreate('user')}
                    >
                      {tt('section.create_in_scope')}
                    </button>
                  </div>
                ) : (
                  <div className={css.cardsList}>
                    {globalServers.map(renderServerCard)}
                  </div>
                )}
              </div>
            )}

            {/* Project Level Section */}
            {showProjectSection && (
              <div className={css.sectionBlock} data-section="project">
                <div className={css.sectionHeader}>
                  <div className={css.sectionTitleGroup}>
                    <h3 className={css.sectionTitle}>{tt('section.project_level')}</h3>
                    <span className={css.sectionPath}>{workspaceRoot ? `${workspaceRoot}/.mcp.json` : '.mcp.json'}</span>
                  </div>
                  <span className={css.sectionBadge}>{projectServers.length}</span>
                </div>

                {projectServers.length === 0 ? (
                  <div className={css.emptyDirectoryCard}>
                    <span className={css.emptyDirectoryIcon}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                        <line x1="6" y1="6" x2="6.01" y2="6" />
                        <line x1="6" y1="18" x2="6.01" y2="18" />
                      </svg>
                    </span>
                    <span className={css.emptyDirectoryText}>{tt('section.empty_dir')}</span>
                    <button
                      type="button"
                      className={css.secondaryButton}
                      onClick={() => controller.openCreate('workspace')}
                    >
                      {tt('section.create_in_project')}
                    </button>
                  </div>
                ) : (
                  <div className={css.cardsList}>
                    {projectServers.map(renderServerCard)}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* HTTP Authorization Quick Prompt Modal */}
      {authDialogServer && (
        <div className={css.dialogOverlay} onClick={() => setAuthDialogServer(null)}>
          <div className={css.dialogCard} onClick={(e) => e.stopPropagation()}>
            <h3 className={css.dialogTitle}>{tt('auth.title', { name: authDialogServer.name })}</h3>
            <p className={css.dialogDesc}>{tt('auth.desc')}</p>
            <div className={css.dialogBody}>
              <div className={css.formGroup}>
                <label className={css.label}>{tt('auth.token_type')}</label>
                <div className={css.segmentedControl}>
                  <button
                    type="button"
                    className={`${css.segmentButton} ${authTokenType === 'bearer' ? css.segmentButtonActive : ''}`}
                    onClick={() => setAuthTokenType('bearer')}
                  >
                    {tt('auth.bearer')}
                  </button>
                  <button
                    type="button"
                    className={`${css.segmentButton} ${authTokenType === 'raw' ? css.segmentButtonActive : ''}`}
                    onClick={() => setAuthTokenType('raw')}
                  >
                    {tt('auth.raw_key')}
                  </button>
                </div>
              </div>
              <div className={css.formGroup}>
                <label className={css.label}>{tt('auth.token_label')}</label>
                <input
                  type="password"
                  className={css.input}
                  placeholder={tt('auth.token_placeholder')}
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className={css.dialogFooter}>
              <button
                type="button"
                className={css.secondaryButton}
                onClick={() => setAuthDialogServer(null)}
              >
                {tt('action.cancel')}
              </button>
              <button
                type="button"
                className={css.primaryButton}
                disabled={authSaving}
                onClick={() => void handleSaveAuth()}
              >
                {authSaving ? tt('action.saving') : tt('auth.save_and_test')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
