import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { McpServersApiClient } from '../api.ts'
import type { McpPanelController } from '../controller.ts'
import { tt, zh, type McpAdapterLocaleKey } from '../locales.ts'
import type { McpServerDetail, ProbeResult, Scope } from '../../types.ts'
import css from './panel.module.css'

export interface ServersListTabProps {
  controller: McpPanelController
  api: McpServersApiClient
  cwd?: string
}

const CATEGORY_ORDER = ['browser', 'system', 'document', 'database', 'custom']

/** Compare two directory spellings without caring about separators, case, or a trailing slash. */
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

function CategoryIcon({ category }: { category: string }): ReactElement {
  switch (category) {
    case 'browser':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      )
    case 'system':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )
    case 'document':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      )
    case 'database':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      )
    default:
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      )
  }
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
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const [probingServer, setProbingServer] = useState<string | null>(null)
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [presets, setPresets] = useState<Array<{ id: string; name: string; summary: string; category: string }>>([])
  const [installingPreset, setInstallingPreset] = useState<string | null>(null)

  const scopeMenuRef = useRef<HTMLDivElement>(null)

  // The workspace the panel acts on: an explicit pick from the scope menu, else the caller's
  // active project root. Every read and write below uses this, never `cwd` directly.
  const activeCwd = snapshot.workspacePath ?? cwd

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
      const res = await api.getServers({ cwd: activeCwd, scope: snapshot.scope })
      setServers(res.servers || [])
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

  // Click outside or press Escape to close scope menu
  useEffect(() => {
    if (!scopeMenuOpen) return
    const handleClickOutside = (e: MouseEvent): void => {
      if (scopeMenuRef.current && !scopeMenuRef.current.contains(e.target as Node)) {
        setScopeMenuOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setScopeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [scopeMenuOpen])

  const handleSelectScope = (newScope: Scope): void => {
    setScopeMenuOpen(false)
    controller.setScope(newScope)
  }

  /** Pick one workspace: the panel then reads and writes that workspace's `.mcp.json`. */
  const handleSelectWorkspace = (path: string): void => {
    setScopeMenuOpen(false)
    controller.setWorkspacePath(path)
  }

  const handleProbe = async (server: McpServerDetail): Promise<void> => {
    setProbingServer(server.name)
    setActionError(null)
    try {
      const serverConfig: Record<string, unknown> = {
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: server.url,
        env: server.env,
        cwd: server.cwd || activeCwd || workspaces[0]?.path,
      }
      const res = await api.probeServer(serverConfig)
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
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      try {
        const ok = window.confirm(tt('dialog.delete_confirm', { name: server.name }))
        if (!ok) return
      } catch {
        // Handle environments like jsdom where window.confirm throws Not implemented
      }
    }
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

  const handleApprove = async (serverName: string): Promise<void> => {
    setActionError(null)
    try {
      await api.approveServer({ cwd: activeCwd || workspaces[0]?.path || '', name: serverName })
      await loadServers()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setActionError(msg || tt('error.approve_failed'))
    }
  }

  const currentWorkspaceTitle =
    workspaces.find((ws) => samePath(ws.path, activeCwd))?.title || workspaces[0]?.title || 'default'
  const scopeButtonLabel = snapshot.scope === 'user' ? tt('scope.user') : `${tt('scope.workspace')} ${currentWorkspaceTitle}`

  // Filter servers by active scope & search query
  const serversInScope = servers.filter((s) => s.scope === snapshot.scope)
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

  // Group servers by category
  const groupedServers = new Map<string, McpServerDetail[]>()
  for (const s of filteredServers) {
    const cat = s.category || 'custom'
    const list = groupedServers.get(cat) || []
    list.push(s)
    groupedServers.set(cat, list)
  }

  // Sort categories by predefined order
  const sortedCategories = Array.from(groupedServers.keys()).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a)
    const ib = CATEGORY_ORDER.indexOf(b)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return a.localeCompare(b)
  })

  return (
    <div className={css.listContainer}>
      {/* Header Row */}
      <div className={css.listHeader}>
        <div className={css.listTitleRow}>
          <h2 data-page-title className={css.listTitle}>
            {tt('panel.title')}
          </h2>

          {/* Scope Dropdown */}
          <div className={css.scopeDropdown} ref={scopeMenuRef}>
            <button
              type="button"
              data-scope-dropdown-trigger
              className={css.scopeDropdownButton}
              onClick={() => setScopeMenuOpen(!scopeMenuOpen)}
            >
              <span>{scopeButtonLabel}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

          {/* Badge */}
          <div data-badge-count className={css.badge}>
            MCP {serversInScope.length}
          </div>
        </div>

        {/* Right Action Tools */}
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

          <button
            type="button"
            data-action="presets"
            className={css.secondaryButton}
            onClick={async () => {
              await loadPresets()
              setPresetsOpen((prev) => !prev)
            }}
          >
            {tt('action.presets')}
          </button>

          <button
            type="button"
            data-action="create"
            className={css.primaryButton}
            onClick={() => controller.openCreate(snapshot.scope)}
          >
            {tt('action.create')}
          </button>
        </div>
      </div>

      {/* Action / Load Error notification */}
      {(loadError || actionError) && (
        <div className={css.bannerError}>
          <span>{loadError || actionError}</span>
          <button type="button" className={css.textButton} onClick={() => { setLoadError(null); setActionError(null); }}>
            {tt('action.close')}
          </button>
        </div>
      )}

      {/* Curated Presets Section */}
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
        ) : serversInScope.length === 0 ? (
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
        ) : filteredServers.length === 0 ? (
          <div className={css.emptySearchState}>
            {tt('empty.search', { query: snapshot.searchQuery })}
          </div>
        ) : (
          <div className={css.serverGroupsContainer}>
            {sortedCategories.map((category) => {
              const categoryServers = groupedServers.get(category) || []
              if (categoryServers.length === 0) return null

              return (
                <div key={category} className={css.groupSection}>
                  <div data-group-header className={css.groupHeader}>
                    {formatCategoryTitle(category, categoryServers.length)}
                  </div>

                  <div className={css.cardsGrid}>
                    {categoryServers.map((server) => {
                      const isProbing = probingServer === server.name
                      const probeResult = probeResults[server.name]
                      const serverStatus = server.status || 'ready'

                      const statusTitles: Record<string, string> = {
                        ready: tt('status.ready'),
                        blocked: tt('status.blocked'),
                        starting: tt('status.starting'),
                        error: tt('status.error'),
                        stopped: tt('status.stopped'),
                      }

                      return (
                        <div
                          key={server.name}
                          data-server-card={server.name}
                          className={css.serverCard}
                        >
                          <div className={css.cardIcon}>
                            <CategoryIcon category={server.category} />
                          </div>

                          <div className={css.cardBody}>
                            <div className={css.cardHeader}>
                              <span data-server-name className={css.serverName}>
                                {server.name}
                              </span>
                              <span
                                data-status-dot
                                data-status={serverStatus}
                                className={`${css.statusDot} ${
                                  serverStatus === 'ready'
                                    ? css.statusDotReady
                                    : serverStatus === 'blocked' || serverStatus === 'starting'
                                    ? css.statusDotBlocked
                                    : serverStatus === 'error'
                                    ? css.statusDotError
                                    : css.statusDotIdle
                                }`}
                                title={statusTitles[serverStatus] || tt('status.stopped')}
                              />
                            </div>

                            <div data-server-desc className={css.serverDesc}>
                              {server.description ||
                                (server.transport === 'stdio'
                                  ? `${server.command || ''} ${(server.args || []).join(' ')}`.trim()
                                  : server.url) ||
                                tt('desc.none')}
                            </div>

                            {probeResult && (
                              <div
                                data-probe-result
                                className={`${css.probeFeedback} ${
                                  probeResult.ok ? css.probeOk : css.probeFail
                                }`}
                              >
                                {probeResult.ok
                                  ? tt('probe.success', { latency: probeResult.latencyMs ?? 0 })
                                  : tt('probe.failed', { error: probeResult.error || 'unknown' })}
                              </div>
                            )}

                            <div className={css.cardActions}>
                              {serverStatus === 'blocked' && (
                                <button
                                  type="button"
                                  data-action="approve"
                                  className={css.cardApproveButton}
                                  onClick={() => handleApprove(server.name)}
                                >
                                  {tt('action.approve')}
                                </button>
                              )}
                              <button
                                type="button"
                                data-action="probe"
                                className={css.cardActionButton}
                                disabled={isProbing}
                                onClick={() => handleProbe(server)}
                              >
                                {isProbing ? tt('action.probing') : tt('action.probe')}
                              </button>
                              <button
                                type="button"
                                data-action="edit"
                                className={css.cardActionButton}
                                onClick={() => controller.openEdit(server)}
                              >
                                {tt('action.edit')}
                              </button>
                              <button
                                type="button"
                                data-action="delete"
                                className={`${css.cardActionButton} ${css.cardDeleteButton}`}
                                title={tt('action.delete')}
                                onClick={() => handleDelete(server)}
                              >
                                {tt('action.delete')}
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
