import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { McpServersApiClient } from '../api.ts'
import type { McpPanelController } from '../controller.ts'
import { tt } from '../locales.ts'
import type { McpCatalogCategory, McpCatalogEntry, Scope } from '../../types.ts'
import css from './panel.module.css'

export interface McpMarketPanelProps {
  controller: McpPanelController
  api: McpServersApiClient
  cwd?: string
}

const CATEGORIES: Array<{ id: 'all' | McpCatalogCategory; labelKey: string }> = [
  { id: 'all', labelKey: 'market.category_all' },
  { id: 'devtools', labelKey: 'market.category_devtools' },
  { id: 'web', labelKey: 'market.category_web' },
  { id: 'docs', labelKey: 'market.category_docs' },
  { id: 'data', labelKey: 'market.category_data' },
  { id: 'productivity', labelKey: 'market.category_productivity' },
]

export function McpMarketPanel({ controller, api, cwd }: McpMarketPanelProps): ReactElement {
  const snapshot = useSyncExternalStore(
    controller.subscribe.bind(controller),
    controller.getSnapshot.bind(controller),
    controller.getSnapshot.bind(controller),
  )

  const activeCwd = snapshot.workspacePath ?? cwd
  const targetScope: Scope = snapshot.scope === 'workspace' ? 'workspace' : 'user'

  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<'all' | McpCatalogCategory>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set())
  const [paramPrompt, setParamPrompt] = useState<{
    entry: McpCatalogEntry
    values: Record<string, string>
  } | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [catRes, srvRes] = await Promise.all([
          api.getCatalog(),
          api.getServers({ cwd: activeCwd, scope: targetScope }),
        ])
        if (cancelled) return
        setCatalog(catRes.catalog || [])
        const existing = new Set((srvRes.servers || []).map((s) => s.name.toLowerCase()))
        setInstalledNames(existing)
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [api, activeCwd, targetScope])

  const handleInstallClick = (entry: McpCatalogEntry) => {
    if (entry.requiredEnv && entry.requiredEnv.length > 0) {
      const initial: Record<string, string> = {}
      for (const item of entry.requiredEnv) {
        const key = typeof item === 'string' ? item : item.name
        const def = typeof item === 'object' && item.defaultValue ? item.defaultValue : ''
        initial[key] = def
      }
      setParamPrompt({ entry, values: initial })
      return
    }

    void executeInstall(entry, {})
  }

  const executeInstall = async (entry: McpCatalogEntry, envOverrides: Record<string, string>) => {
    setInstallingId(entry.id)
    setError(null)
    setFeedback(null)
    try {
      await api.installPreset({
        presetId: entry.id,
        scope: targetScope,
        cwd: targetScope === 'workspace' ? activeCwd : undefined,
        envOverrides: Object.keys(envOverrides).length > 0 ? envOverrides : undefined,
      })
      setInstalledNames((prev) => new Set([...prev, entry.id.toLowerCase()]))
      setFeedback(tt('market.install_success', { name: entry.name }))
      setParamPrompt(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstallingId(null)
    }
  }

  // Filter catalog
  const q = searchQuery.trim().toLowerCase()
  const filtered = catalog.filter((item) => {
    if (selectedCategory !== 'all' && !item.categories.includes(selectedCategory)) {
      return false
    }
    if (q) {
      const matchName = item.name.toLowerCase().includes(q)
      const matchDesc = item.description.toLowerCase().includes(q)
      const matchId = item.id.toLowerCase().includes(q)
      return matchName || matchDesc || matchId
    }
    return true
  })

  return (
    <div className={css.marketContainer} data-dsh-mcp-market="">
      {/* Header */}
      <div className={css.marketHeader}>
        <button
          type="button"
          data-market-back
          className={css.marketBackBtn}
          onClick={() => controller.closeMarket()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>{tt('action.back_to_servers')}</span>
        </button>

        <div className={css.marketTitleRow}>
          <div>
            <h2 className={css.marketTitle}>{tt('market.title')}</h2>
            <p className={css.marketSub}>{tt('market.subtitle')}</p>
          </div>
          <div className={css.badge}>
            {targetScope === 'user' ? tt('tab.user') : `${tt('tab.workspace')}: ${activeCwd || 'default'}`}
          </div>
        </div>

        {/* Toolbar: Category filter + Search */}
        <div className={css.marketToolbar}>
          <div className={css.marketCategories} role="tablist">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                data-category={cat.id}
                className={`${css.marketCategoryBtn} ${selectedCategory === cat.id ? css.marketCategoryBtnActive : ''}`}
                onClick={() => setSelectedCategory(cat.id)}
              >
                {tt(cat.labelKey as any)}
              </button>
            ))}
          </div>

          <div className={css.searchInputWrapper}>
            <svg className={css.searchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              data-market-search
              className={css.searchInput}
              placeholder={tt('market.search_placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Notifications */}
      {error && (
        <div className={css.bannerError}>
          <span>{error}</span>
          <button type="button" className={css.textButton} onClick={() => setError(null)}>
            {tt('action.close')}
          </button>
        </div>
      )}

      {feedback && (
        <div className={css.badge} style={{ background: 'var(--dsw-alias-bg-success-subtle, rgba(16,163,127,0.1))', color: 'var(--dsw-alias-state-success-primary, #10a37f)', padding: '8px 12px', fontSize: '13px' }}>
          {feedback}
        </div>
      )}

      {/* Grid of Catalog Cards */}
      {loading && catalog.length === 0 ? (
        <div className={css.loadingState}>{tt('loading.servers')}</div>
      ) : filtered.length === 0 ? (
        <div className={css.emptyDirectoryCard}>
          <div className={css.emptyDirectoryText}>{tt('empty.search', { query: searchQuery || selectedCategory })}</div>
        </div>
      ) : (
        <div className={css.marketGrid}>
          {filtered.map((item) => {
            const isInstalled = installedNames.has(item.id.toLowerCase()) || installedNames.has(item.name.toLowerCase())
            const isInstalling = installingId === item.id

            return (
              <div key={item.id} data-market-card={item.id} className={css.marketCard}>
                <div className={css.marketCardTop}>
                  <div className={css.marketCardHeader}>
                    <div className={css.marketCardNameGroup}>
                      <span className={css.marketCardName}>{item.name}</span>
                      {item.verified && (
                        <span title="Verified" style={{ color: 'var(--dsw-alias-brand-primary, #0066ff)', display: 'inline-flex' }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                            <polyline points="22 4 12 14.01 9 11.01" />
                          </svg>
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <span className={css.badge}>{item.transport}</span>
                      {item.categories[0] && (
                        <span className={css.badge}>{item.categories[0]}</span>
                      )}
                    </div>
                  </div>

                  <p className={css.marketCardDesc}>{item.description}</p>
                  {item.notes && <div className={css.marketCardNotes}>{item.notes}</div>}
                </div>

                <div className={css.marketCardFooter}>
                  <span className={css.marketCardAuthor}>by {item.author || 'community'}</span>

                  <button
                    type="button"
                    data-market-install={item.id}
                    className={isInstalled ? css.cardActionButton : css.primaryButton}
                    disabled={isInstalled || isInstalling}
                    onClick={() => handleInstallClick(item)}
                  >
                    {isInstalled
                      ? tt('action.installed')
                      : isInstalling
                        ? tt('action.installing')
                        : tt('action.install')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Required Parameters Modal Dialog */}
      {paramPrompt && (
        <div className={css.dialogOverlay} onClick={() => setParamPrompt(null)}>
          <div className={css.dialogCard} onClick={(e) => e.stopPropagation()}>
            <h3 className={css.dialogTitle}>{tt('market.required_params_title', { name: paramPrompt.entry.name })}</h3>
            <p className={css.dialogDesc}>{tt('market.required_params_desc')}</p>

            <div className={css.dialogBody}>
              {paramPrompt.entry.requiredEnv?.map((item) => {
                const key = typeof item === 'string' ? item : item.name
                const desc = typeof item === 'object' ? item.description : undefined
                return (
                  <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
                      {key} {desc && <span style={{ fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>({desc})</span>}
                    </label>
                    <input
                      type="text"
                      className={css.input}
                      value={paramPrompt.values[key] || ''}
                      onChange={(e) => {
                        const val = e.target.value
                        setParamPrompt((prev) =>
                          prev
                            ? {
                                ...prev,
                                values: { ...prev.values, [key]: val },
                              }
                            : null,
                        )
                      }}
                      placeholder={`Enter ${key}...`}
                    />
                  </div>
                )
              })}
            </div>

            <div className={css.dialogFooter}>
              <button
                type="button"
                className={css.secondaryButton}
                onClick={() => setParamPrompt(null)}
              >
                {tt('action.cancel')}
              </button>
              <button
                type="button"
                data-confirm-install
                className={css.primaryButton}
                disabled={installingId === paramPrompt.entry.id}
                onClick={() => void executeInstall(paramPrompt.entry, paramPrompt.values)}
              >
                {installingId === paramPrompt.entry.id ? tt('action.installing') : tt('action.install')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
