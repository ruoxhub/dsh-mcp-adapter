import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { McpServersApiClient } from '../api.ts'
import { parseArgsString, type McpPanelController, type ServerDraft } from '../controller.ts'
import { tt } from '../locales.ts'
import { ServerFormView } from './ServerFormView.tsx'
import { ServerJsonView } from './ServerJsonView.tsx'
import css from './panel.module.css'

export interface ServerEditorTabProps {
  controller: McpPanelController
  api: McpServersApiClient
  cwd?: string
  onSaved?: () => void
}

export function ServerEditorTab({
  controller,
  api,
  cwd,
  onSaved,
}: ServerEditorTabProps): ReactElement {
  const snapshot = useSyncExternalStore(
    controller.subscribe.bind(controller),
    controller.getSnapshot.bind(controller),
    controller.getSnapshot.bind(controller),
  )

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [validationMsg, setValidationMsg] = useState<string | null>(null)

  // Writes go to the workspace the panel is showing, not the caller's root: the scope menu can
  // have switched away from it, and saving into the wrong directory would be silent data loss.
  const activeCwd = snapshot.workspacePath ?? cwd

  const isEditing = Boolean(snapshot.editingServer)
  const originalName = snapshot.editingServer?.name
  const originalScope = snapshot.editingServer?.scope
  const titleText = isEditing ? tt('editor.title_edit') : tt('editor.title_create')

  // A sheet that traps the pointer also has to answer the key everyone reaches for. Not while a
  // save is in flight: the write is already on its way and closing would hide its outcome.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) controller.closeEditor()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saving, controller])

  const handleFormChange = (patch: Partial<ServerDraft>): void => {
    setValidationMsg(null)
    setSaveError(null)
    controller.updateDraft(() => patch)
  }

  const handleJsonChange = (newJson: string): void => {
    setValidationMsg(null)
    setSaveError(null)
    controller.updateDraft(() => ({ rawJson: newJson }))
    controller.syncJsonToDraft()
  }

  const handleScopeChange = (scope: 'user' | 'workspace'): void => {
    controller.updateDraft(() => ({ scope }))
    controller.setScope(scope)
  }

  const handleSave = async (): Promise<void> => {
    setValidationMsg(null)
    setSaveError(null)

    let draft = snapshot.draft
    if (snapshot.editorMode === 'json') {
      const syncRes = controller.syncJsonToDraft()
      if (!syncRes.ok) {
        setValidationMsg(syncRes.error || tt('validation.json_invalid'))
        return
      }
      draft = controller.getSnapshot().draft
    }

    let name = draft.name ? draft.name.trim() : ''

    if (snapshot.editorMode === 'form') {
      if (!name) {
        setValidationMsg(tt('validation.name_required'))
        return
      }
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
        setValidationMsg(tt('validation.name_invalid'))
        return
      }
      if (draft.transport === 'stdio') {
        if (!draft.command || !draft.command.trim()) {
          setValidationMsg(tt('validation.command_required'))
          return
        }
      } else if (draft.transport === 'http' || draft.transport === 'sse') {
        if (!draft.url || !draft.url.trim()) {
          setValidationMsg(tt('validation.url_required'))
          return
        }
      }
    }

    let serverToSave: Record<string, unknown>
    if (snapshot.editorMode === 'json' && draft.rawJson?.trim()) {
      try {
        const parsed = JSON.parse(draft.rawJson)
        let target: Record<string, unknown> = parsed
        if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
          const keys = Object.keys(parsed.mcpServers)
          const match = name && parsed.mcpServers[name] ? name : keys[0]
          if (match && typeof parsed.mcpServers[match] === 'object' && !Array.isArray(parsed.mcpServers[match])) {
            target = parsed.mcpServers[match]
            if (!name) name = match
          }
        } else if (parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)) {
          const keys = Object.keys(parsed.servers)
          const match = name && parsed.servers[name] ? name : keys[0]
          if (match && typeof parsed.servers[match] === 'object' && !Array.isArray(parsed.servers[match])) {
            target = parsed.servers[match]
            if (!name) name = match
          }
        } else {
          const keys = Object.keys(parsed)
          if (keys.length === 1 && !('command' in parsed) && !('url' in parsed) && !('transport' in parsed)) {
            const singleKey = keys[0]
            const val = parsed[singleKey]
            if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
              target = val as Record<string, unknown>
              if (!name) name = singleKey
            }
          }
        }
        serverToSave = target
      } catch {
        setValidationMsg(tt('validation.json_invalid'))
        return
      }

      if (!name) {
        setValidationMsg(tt('validation.name_required'))
        return
      }
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
        setValidationMsg(tt('validation.name_invalid'))
        return
      }
    } else {
      const { name: _n, scope: _s, status: _st, ...baseProps } = (snapshot.editingServer ?? {}) as Record<string, unknown>
      serverToSave = { ...baseProps }
      if (draft.transport === 'stdio') {
        delete serverToSave.transport
        delete serverToSave.httpTransport
        delete serverToSave.url
        delete serverToSave.headers
        serverToSave.command = draft.command.trim()
        const args = parseArgsString(draft.args)
        if (args.length > 0) serverToSave.args = args
        else delete serverToSave.args
      } else {
        delete serverToSave.command
        delete serverToSave.args
        // `httpTransport` is the key the normalizer reads; `transport` is not, so writing it only
        // produced a dead field. A streamable-HTTP server (the default) omits it entirely.
        delete serverToSave.transport
        if (draft.transport === 'sse') serverToSave.httpTransport = 'sse'
        else delete serverToSave.httpTransport
        if (draft.url?.trim()) serverToSave.url = draft.url.trim()
        if (draft.headers && draft.headers.length > 0) {
          const headersRecord: Record<string, string> = {}
          for (const h of draft.headers) {
            if (h.key && h.key.trim()) headersRecord[h.key.trim()] = h.value
          }
          if (Object.keys(headersRecord).length > 0) serverToSave.headers = headersRecord
          else delete serverToSave.headers
        } else {
          delete serverToSave.headers
        }
      }

      if (draft.env && draft.env.length > 0) {
        const envRecord: Record<string, string> = {}
        for (const e of draft.env) {
          if (e.key && e.key.trim()) envRecord[e.key.trim()] = e.value
        }
        if (Object.keys(envRecord).length > 0) serverToSave.env = envRecord
        else delete serverToSave.env
      } else {
        delete serverToSave.env
      }

      // `requestTimeoutMs` is the key the normalizer reads; `timeoutMs` is only accepted on read.
      delete serverToSave.timeoutMs
      if (typeof draft.timeoutMs === 'number' && draft.timeoutMs > 0 && draft.timeoutMs !== 30000) {
        serverToSave.requestTimeoutMs = draft.timeoutMs
      } else {
        delete serverToSave.requestTimeoutMs
      }
      if (draft.protocolVersion && draft.protocolVersion.trim()) {
        serverToSave.protocolVersion = draft.protocolVersion.trim()
      } else {
        delete serverToSave.protocolVersion
      }
    }

    setSaving(true)
    try {
      await api.saveServer({
        scope: draft.scope,
        cwd: draft.scope === 'workspace' ? activeCwd : undefined,
        name,
        originalName: isEditing ? originalName : undefined,
        originalScope: isEditing ? originalScope : undefined,
        server: serverToSave,
      })
      onSaved?.()
      controller.closeEditor()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setSaveError(msg || tt('error.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const displayedError = validationMsg || saveError

  return (
    <div
      className={css.sheetOverlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) controller.closeEditor()
      }}
    >
      <div className={css.sheet} role="dialog" aria-modal="true" aria-labelledby="dsh-mcp-sheet-title">
        <div className={css.sheetHead}>
          <div className={css.sheetHeadCopy}>
            <h2 id="dsh-mcp-sheet-title" className={css.sheetTitle}>{titleText}</h2>
            <p className={css.sheetSub}>{tt('editor.subtitle')}</p>
          </div>
          <button
            type="button"
            data-sheet-close
            className={css.sheetClose}
            aria-label={tt('action.close')}
            title={tt('action.close')}
            onClick={() => controller.closeEditor()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className={css.sheetToolbar}>
          <div className={css.scopeSelector}>
            <span className={css.scopeLabel}>{tt('scope.label')}</span>
            <select
              data-field="scope"
              className={css.select}
              value={snapshot.draft.scope}
              onChange={(e) => handleScopeChange(e.target.value as 'user' | 'workspace')}
            >
              <option value="user">{tt('scope.user')}</option>
              <option value="workspace">{tt('scope.workspace_current')}</option>
            </select>
          </div>

          {/* JSON stays reachable for the configs a three-field form cannot express. */}
          <div className={css.segmentedControl} role="tablist">
            <button
              type="button"
              role="tab"
              data-mode-tab="form"
              data-active={snapshot.editorMode === 'form'}
              className={css.segmentedTab}
              onClick={() => controller.setEditorMode('form')}
            >
              {tt('editor.mode_form')}
            </button>
            <button
              type="button"
              role="tab"
              data-mode-tab="json"
              data-active={snapshot.editorMode === 'json'}
              className={css.segmentedTab}
              onClick={() => controller.setEditorMode('json')}
            >
              {tt('editor.mode_json')}
            </button>
          </div>
        </div>

        <div className={css.sheetBody}>
          {snapshot.editorMode === 'form' ? (
            <ServerFormView draft={snapshot.draft} onChange={handleFormChange} isEditing={isEditing} />
          ) : (
            <ServerJsonView
              rawJson={snapshot.draft.rawJson ?? ''}
              error={snapshot.jsonError}
              onChange={handleJsonChange}
            />
          )}
        </div>

        {displayedError && (
          <div className={css.sheetError} role="alert">
            {displayedError}
          </div>
        )}

        <div className={css.sheetActions}>
          {/* A brand-new server has no endpoint to test yet, so the note names the step instead. */}
          {!isEditing && <span className={css.sheetNote}>{tt('editor.test_after_save')}</span>}
          <div className={css.sheetActionsEnd}>
            <button
              type="button"
              data-action="cancel"
              className={css.secondaryButton}
              onClick={() => controller.closeEditor()}
              disabled={saving}
            >
              {tt('action.cancel')}
            </button>
            <button
              type="button"
              data-action="save"
              className={css.primaryButton}
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? tt('action.saving') : tt('action.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
