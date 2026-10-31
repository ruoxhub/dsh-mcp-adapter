import { useState, type ReactElement } from 'react'
import { tt } from '../locales.ts'
import css from './panel.module.css'

export interface ServerJsonViewProps {
  rawJson: string
  error: string | null
  onChange: (newJson: string) => void
  onFormat?: () => void
}

export function ServerJsonView({
  rawJson,
  error,
  onChange,
  onFormat,
}: ServerJsonViewProps): ReactElement {
  const [formatError, setFormatError] = useState<string | null>(null)

  const handleFormat = (): void => {
    if (onFormat) {
      onFormat()
      return
    }
    try {
      if (!rawJson.trim()) return
      const parsed = JSON.parse(rawJson)
      const formatted = JSON.stringify(parsed, null, 2)
      setFormatError(null)
      onChange(formatted)
    } catch (err: unknown) {
      setFormatError(err instanceof Error ? err.message : String(err))
    }
  }

  const effectiveError = error || formatError

  return (
    <div className={css.jsonContainer}>
      <div className={css.jsonToolbar}>
        <span className={css.jsonLabel}>{tt('editor.json_label')}</span>
        <button
          type="button"
          data-format-json
          className={css.formatButton}
          onClick={handleFormat}
        >
          {tt('action.format_json')}
        </button>
      </div>

      <textarea
        className={css.jsonTextarea}
        value={rawJson}
        onChange={(e) => {
          setFormatError(null)
          onChange(e.target.value)
        }}
        placeholder="{\n  &quot;command&quot;: &quot;npx&quot;,\n  &quot;args&quot;: [&quot;-y&quot;, &quot;...&quot;]\n}"
        rows={16}
        spellCheck={false}
      />

      <div className={css.jsonSubtext}>
        {tt('editor.json_hint')}
      </div>

      {effectiveError && (
        <div className={css.errorBanner} role="alert">
          {effectiveError}
        </div>
      )}
    </div>
  )
}
