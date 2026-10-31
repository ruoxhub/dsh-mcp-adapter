import { useState, type ReactElement } from 'react'
import type { ServerDraft } from '../controller.ts'
import { tt } from '../locales.ts'
import css from './panel.module.css'

export interface ServerFormViewProps {
  draft: ServerDraft
  onChange: (patch: Partial<ServerDraft>) => void
  isEditing?: boolean
}

export function ServerFormView({ draft, onChange, isEditing }: ServerFormViewProps): ReactElement {
  const [envOpen, setEnvOpen] = useState(false)
  const [headersOpen, setHeadersOpen] = useState(false)

  const isStdio = draft.transport === 'stdio'

  const handleEnvChange = (index: number, key: string, value: string): void => {
    const nextEnv = [...(draft.env || [])]
    nextEnv[index] = { key, value }
    onChange({ env: nextEnv })
  }

  const handleAddEnv = (): void => {
    const nextEnv = [...(draft.env || []), { key: '', value: '' }]
    onChange({ env: nextEnv })
    if (!envOpen) setEnvOpen(true)
  }

  const handleRemoveEnv = (index: number): void => {
    const nextEnv = (draft.env || []).filter((_, i) => i !== index)
    onChange({ env: nextEnv })
  }

  const handleHeaderChange = (index: number, key: string, value: string): void => {
    const nextHeaders = [...(draft.headers || [])]
    nextHeaders[index] = { key, value }
    onChange({ headers: nextHeaders })
  }

  const handleAddHeader = (): void => {
    const nextHeaders = [...(draft.headers || []), { key: '', value: '' }]
    onChange({ headers: nextHeaders })
    if (!headersOpen) setHeadersOpen(true)
  }

  const handleRemoveHeader = (index: number): void => {
    const nextHeaders = (draft.headers || []).filter((_, i) => i !== index)
    onChange({ headers: nextHeaders })
  }

  return (
    <div className={css.formContainer}>
      <div className={css.formGrid}>
        {/* Name */}
        <div className={css.formFieldFull}>
          <label className={css.fieldLabel}>
            {tt('field.name')} <span className={css.required}>*</span>
          </label>
          <input
            className={css.input}
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={tt('field.name_placeholder')}
            disabled={isEditing}
          />
        </div>

        {/* Transport Type */}
        <div className={css.formField}>
          <label className={css.fieldLabel}>{tt('field.transport')}</label>
          <select
            data-field="transport"
            className={css.select}
            value={draft.transport}
            onChange={(e) => onChange({ transport: e.target.value as ServerDraft['transport'] })}
          >
            <option value="stdio">{tt('field.transport_stdio')}</option>
            <option value="http">{tt('field.transport_http')}</option>
            <option value="sse">{tt('field.transport_sse')}</option>
          </select>
        </div>

        {/* Timeout MS */}
        <div className={css.formField}>
          <label className={css.fieldLabel}>{tt('field.timeout')}</label>
          <input
            data-field="timeoutMs"
            type="number"
            className={css.input}
            value={draft.timeoutMs ?? 30000}
            onChange={(e) => onChange({ timeoutMs: Number(e.target.value) || 0 })}
            placeholder="30000"
          />
        </div>

        {/* Protocol Version */}
        <div className={css.formFieldFull}>
          <label className={css.fieldLabel}>{tt('field.protocol_version')}</label>
          <select
            data-field="protocolVersion"
            className={css.select}
            value={draft.protocolVersion || ''}
            onChange={(e) => onChange({ protocolVersion: e.target.value })}
          >
            <option value="">{tt('field.protocol_version_auto')}</option>
            <option value="2024-11-05">2024-11-05</option>
          </select>
        </div>

        {/* Stdio Specific Fields */}
        {isStdio ? (
          <>
            <div className={css.formFieldFull}>
              <label className={css.fieldLabel}>
                {tt('field.command')} <span className={css.required}>*</span>
              </label>
              <input
                className={css.input}
                value={draft.command}
                onChange={(e) => onChange({ command: e.target.value })}
                placeholder="npx"
              />
            </div>

            <div className={css.formFieldFull}>
              <label className={css.fieldLabel}>{tt('field.args')}</label>
              <input
                className={css.input}
                value={draft.args}
                onChange={(e) => onChange({ args: e.target.value })}
                placeholder="-y @modelcontextprotocol/server-memory"
              />
              <span className={css.fieldHelp}>{tt('field.args_help')}</span>
            </div>
          </>
        ) : (
          /* HTTP / SSE Specific Fields */
          <>
            <div className={css.formFieldFull}>
              <label className={css.fieldLabel}>
                {tt('field.url')} <span className={css.required}>*</span>
              </label>
              <input
                className={css.input}
                value={draft.url ?? ''}
                onChange={(e) => onChange({ url: e.target.value })}
                placeholder="http://localhost:3000/sse"
              />
            </div>

            {/* Headers Accordion */}
            <div className={css.formFieldFull}>
              <div className={css.accordion}>
                <button
                  type="button"
                  data-headers-toggle
                  className={css.accordionHeader}
                  onClick={() => setHeadersOpen((v) => !v)}
                >
                  <span>
                    <span className={css.accordionIcon}>{headersOpen ? '▾' : '▸'}</span>
                    {tt('field.headers')}
                  </span>
                  <span className={css.fieldHelp}>
                    {draft.headers?.length ? tt('field.items_count', { count: draft.headers.length }) : tt('field.none')}
                  </span>
                </button>
                {headersOpen && (
                  <div className={css.accordionBody}>
                    {(draft.headers || []).map((header, i) => (
                      <div key={i} className={css.envRow}>
                        <input
                          data-header-key={i}
                          className={`${css.input} ${css.envKeyInput}`}
                          placeholder={tt('field.header_key_placeholder')}
                          value={header.key}
                          onChange={(e) => handleHeaderChange(i, e.target.value, header.value)}
                        />
                        <input
                          data-header-val={i}
                          className={`${css.input} ${css.envValInput}`}
                          placeholder={tt('field.header_val_placeholder')}
                          value={header.value}
                          onChange={(e) => handleHeaderChange(i, header.key, e.target.value)}
                        />
                        <button
                          type="button"
                          className={css.iconButton}
                          onClick={() => handleRemoveHeader(i)}
                          title={tt('field.remove_header')}
                          aria-label={tt('field.remove_header')}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className={css.addRowButton}
                      onClick={handleAddHeader}
                    >
                      {tt('field.add_header')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Collapsible Environment Variables Accordion */}
        <div className={css.formFieldFull}>
          <div className={css.accordion}>
            <button
              type="button"
              data-env-toggle
              className={css.accordionHeader}
              onClick={() => setEnvOpen((v) => !v)}
            >
              <span>
                <span className={css.accordionIcon}>{envOpen ? '▾' : '▸'}</span>
                {tt('field.env')}
              </span>
              <span className={css.fieldHelp}>
                {draft.env?.length ? tt('field.items_count', { count: draft.env.length }) : tt('field.none')}
              </span>
            </button>
            {envOpen && (
              <div className={css.accordionBody}>
                {(draft.env || []).map((env, i) => (
                  <div key={i} className={css.envRow}>
                    <input
                      data-env-key={i}
                      className={`${css.input} ${css.envKeyInput}`}
                      placeholder={tt('field.env_key_placeholder')}
                      value={env.key}
                      onChange={(e) => handleEnvChange(i, e.target.value, env.value)}
                    />
                    <input
                      data-env-val={i}
                      className={`${css.input} ${css.envValInput}`}
                      placeholder={tt('field.env_val_placeholder')}
                      value={env.value}
                      onChange={(e) => handleEnvChange(i, env.key, e.target.value)}
                    />
                    <button
                      type="button"
                      data-remove-env={i}
                      className={css.iconButton}
                      onClick={() => handleRemoveEnv(i)}
                      title={tt('field.remove_env')}
                      aria-label={tt('field.remove_env')}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  data-add-env
                  className={css.addRowButton}
                  onClick={handleAddEnv}
                >
                  {tt('field.add_env')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
