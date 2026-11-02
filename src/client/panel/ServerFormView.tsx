import { useState, type ReactElement } from 'react'
import type { ServerDraft } from '../controller.ts'
import { tt } from '../locales.ts'
import css from './panel.module.css'

/**
 * The launchers every MCP README prints. A command that is neither of them is the custom branch,
 * which is where a path or any other executable typed by hand lands.
 */
const LAUNCHERS = ['npx', 'uvx'] as const
type Launcher = (typeof LAUNCHERS)[number] | 'custom'

function launcherOf(command: string): Launcher {
  const name = command.trim().toLowerCase()
  return name === 'npx' || name === 'uvx' ? name : 'custom'
}

interface KeyValueRowsProps {
  rows: 'env' | 'header'
  pairs: Array<{ key: string; value: string }>
  onChange: (next: Array<{ key: string; value: string }>) => void
  keyPlaceholder: string
  valuePlaceholder: string
  addLabel: string
  removeLabel: string
}

/**
 * Rows keep their own identity so editing one credential never disturbs another, and the add
 * action is a pill under the rows rather than a collapsed accordion: two rows are not worth a
 * second click.
 */
function KeyValueRows({
  rows,
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  removeLabel,
}: KeyValueRowsProps): ReactElement {
  const setAt = (index: number, patch: Partial<{ key: string; value: string }>): void => {
    onChange(pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)))
  }

  return (
    <div className={css.kvRows}>
      {pairs.map((pair, index) => (
        <div key={index} className={css.kvRow}>
          <input
            {...{ [`data-${rows}-key`]: index }}
            className={`${css.input} ${css.kvKey}`}
            value={pair.key}
            placeholder={keyPlaceholder}
            spellCheck={false}
            onChange={(e) => setAt(index, { key: e.target.value })}
          />
          <input
            {...{ [`data-${rows}-val`]: index }}
            className={`${css.input} ${css.kvValue}`}
            value={pair.value}
            placeholder={valuePlaceholder}
            spellCheck={false}
            onChange={(e) => setAt(index, { value: e.target.value })}
          />
          <button
            type="button"
            {...{ [`data-remove-${rows}`]: index }}
            className={css.kvRemove}
            title={removeLabel}
            aria-label={removeLabel}
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
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
        {...{ [`data-add-${rows}`]: true }}
        className={`${css.kvAdd} ${pairs.length === 0 ? css.kvAddFirst : ''}`}
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        {addLabel}
      </button>
    </div>
  )
}

export interface ServerFormViewProps {
  draft: ServerDraft
  onChange: (patch: Partial<ServerDraft>) => void
  isEditing?: boolean
}

/**
 * The one form for creating and editing a server. Transport comes first because it decides what
 * the rest of the form means, and the two branches never both show: a form that asks for a URL
 * and a command at the same time invites a config that is half of each.
 */
export function ServerFormView({ draft, onChange, isEditing }: ServerFormViewProps): ReactElement {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const isStdio = draft.transport === 'stdio'
  const launcher = launcherOf(draft.command)

  // An SSE draft only reaches the form through a JSON round trip, and it is still an HTTP server:
  // the card shows it, and picking the card writes the streamable default that a click means.
  const isHttpCard = draft.transport === 'http' || draft.transport === 'sse'
  const cardActive = (transport: 'stdio' | 'http'): boolean =>
    transport === 'stdio' ? !isHttpCard : isHttpCard

  // The draft keeps both branches while the user flips between them; only the active one is saved,
  // so a round trip through the other card does not throw away what was already typed.
  const setTransport = (transport: 'stdio' | 'http'): void => {
    onChange({ transport })
  }

  return (
    <div className={css.formStack}>
      <div className={css.fieldGroup}>
        <div className={css.fieldLabel}>{tt('field.transport')}</div>
        <div className={css.transportPick} role="radiogroup" aria-label={tt('field.transport')}>
          {(['stdio', 'http'] as const).map((transport) => (
            <button
              key={transport}
              type="button"
              role="radio"
              aria-checked={cardActive(transport)}
              data-transport={transport}
              className={`${css.transportCard} ${cardActive(transport) ? css.transportCardActive : ''}`}
              onClick={() => setTransport(transport)}
            >
              <span className={css.transportIcon} aria-hidden="true">
                {transport === 'stdio' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="7" rx="2" />
                    <rect x="2" y="14" width="20" height="7" rx="2" />
                    <line x1="6" y1="6.5" x2="6.01" y2="6.5" />
                    <line x1="6" y1="17.5" x2="6.01" y2="17.5" />
                  </svg>
                )}
              </span>
              <span className={css.transportName}>
                {transport === 'stdio' ? tt('field.transport_stdio') : tt('field.transport_http')}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className={css.fieldGroup}>
        <label className={css.fieldLabel} htmlFor="dsh-mcp-field-name">
          {tt('field.name')} <span className={css.required}>*</span>
        </label>
        <input
          id="dsh-mcp-field-name"
          className={css.input}
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={tt('field.name_placeholder')}
          disabled={isEditing}
        />
      </div>

      {isStdio ? (
        <>
          <div className={css.fieldGroup}>
            <div className={css.fieldLabel}>
              {tt('field.command')} <span className={css.required}>*</span>
            </div>
            <div className={css.presetPick} role="radiogroup" aria-label={tt('field.command')}>
              {LAUNCHERS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={launcher === id}
                  data-launcher={id}
                  className={`${css.presetChip} ${launcher === id ? css.presetChipSelected : ''}`}
                  onClick={() => onChange({ command: id })}
                >
                  {id}
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={launcher === 'custom'}
                data-launcher="custom"
                className={`${css.presetChip} ${launcher === 'custom' ? css.presetChipSelected : ''}`}
                onClick={() => {
                  if (launcher === 'custom') return
                  onChange({ command: '' })
                }}
              >
                {tt('field.launcher_custom')}
              </button>
            </div>
            {launcher === 'custom' ? (
              <input
                data-field="command"
                className={css.input}
                value={draft.command}
                placeholder="npx 或绝对路径"
                onChange={(e) => onChange({ command: e.target.value })}
              />
            ) : null}
          </div>

          <div className={css.fieldGroup}>
            <label className={css.fieldLabel} htmlFor="dsh-mcp-field-args">
              {tt('field.args')}
            </label>
            <input
              id="dsh-mcp-field-args"
              className={css.input}
              value={draft.args}
              onChange={(e) => onChange({ args: e.target.value })}
              placeholder={launcher === 'uvx' ? 'mcp-server-git' : '-y @upstash/context7-mcp'}
            />
            <span className={css.fieldHint}>{tt('field.args_help')}</span>
          </div>

          <div className={css.fieldGroup}>
            <div className={css.fieldLabel}>{tt('field.env')}</div>
            <KeyValueRows
              rows="env"
              pairs={draft.env || []}
              onChange={(env) => onChange({ env })}
              keyPlaceholder={tt('field.env_key_placeholder')}
              valuePlaceholder={tt('field.env_val_placeholder')}
              addLabel={tt('field.add_env')}
              removeLabel={tt('field.remove_env')}
            />
          </div>
        </>
      ) : (
        <>
          <div className={css.fieldGroup}>
            <label className={css.fieldLabel} htmlFor="dsh-mcp-field-url">
              {tt('field.url')} <span className={css.required}>*</span>
            </label>
            <input
              id="dsh-mcp-field-url"
              className={css.input}
              value={draft.url ?? ''}
              onChange={(e) => onChange({ url: e.target.value })}
              placeholder="https://mcp.example.com/sse"
            />
          </div>

          <div className={css.fieldGroup}>
            <div className={css.fieldLabel}>{tt('field.headers')}</div>
            <KeyValueRows
              rows="header"
              pairs={draft.headers || []}
              onChange={(headers) => onChange({ headers })}
              keyPlaceholder={tt('field.header_key_placeholder')}
              valuePlaceholder={tt('field.header_val_placeholder')}
              addLabel={tt('field.add_header')}
              removeLabel={tt('field.remove_header')}
            />
          </div>
        </>
      )}

      {/*
        Transport, name and the command/URL branch are what a server needs to start. The two
        settings that only matter to an unusual endpoint stay one click away, so the sheet the
        user sees first is the one PI-Desktop shows.
      */}
      <div className={css.fieldGroup}>
        <button
          type="button"
          data-advanced-toggle
          aria-expanded={advancedOpen}
          className={css.advancedToggle}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          {tt('editor.advanced')}
        </button>
        {advancedOpen ? (
          <div className={css.advancedBody}>
            <div className={css.fieldGroup}>
              <label className={css.fieldLabel} htmlFor="dsh-mcp-field-timeout">
                {tt('field.timeout')}
              </label>
              <input
                id="dsh-mcp-field-timeout"
                data-field="timeoutMs"
                type="number"
                className={css.input}
                value={draft.timeoutMs ?? 30000}
                onChange={(e) => onChange({ timeoutMs: Number(e.target.value) || 0 })}
                placeholder="30000"
              />
              <span className={css.fieldHint}>{tt('field.timeout_hint')}</span>
            </div>

            <div className={css.fieldGroup}>
              <label className={css.fieldLabel} htmlFor="dsh-mcp-field-protocol">
                {tt('field.protocol_version')}
              </label>
              <select
                id="dsh-mcp-field-protocol"
                data-field="protocolVersion"
                className={css.select}
                value={draft.protocolVersion || ''}
                onChange={(e) => onChange({ protocolVersion: e.target.value })}
              >
                <option value="">{tt('field.protocol_version_auto')}</option>
                <option value="2024-11-05">2024-11-05</option>
              </select>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
