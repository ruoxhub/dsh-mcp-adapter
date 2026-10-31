/**
 * The MCP panel: one conversation-header action that opens the adapter's whole status.
 *
 * Data path: the Host publishes one Session projection (`mcpAdapter`, see `src/projection.ts`) and
 * the slot framework hands this component the standard `useProjection` seat, which is key-addressed:
 * the key comes first, the selector second. It is NOT part of the registration's `inject` face —
 * the renderer rewrites `inject` members into `use*` props, so a hook declared there would arrive as
 * a prop that does not exist.
 *
 * The panel cannot approve a server by itself: a Client package outside the shipped Remote assembly
 * has no callable Host namespace. It therefore offers the two paths the Host does expose — ask the
 * model to call `mcp_approve` in the conversation, or copy the slash command for an operator.
 *
 * Styling lives in `McpPanel.module.css`; every colour, radius and shadow there is a `--dsw-*` token.
 *
 * @module dsh-mcp-adapter/McpPanel
 */

import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionIdOf, SessionStandardProps, Translate } from '@deepseek-ai/dsh-client-ui-slots'
// Declaration-merge import only: `ui-session` merges the session standard kit (`sessionId` and
// `useProjection`) into `SessionStandardProps`. Without this module in the program the slot table is
// the empty base and `Pick<SessionStandardProps, ...>` collapses to `never`.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCopyOutlineRegular,
  IconDataOutlineRegular,
  StateDot,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { StatusSnapshot } from '../projection.ts'
import css from './McpPanel.module.css'
import type { McpAdapterLocaleKey } from './locales.ts'

/** One server row of the published snapshot. */
type PanelServer = StatusSnapshot['servers'][number]

/** The panel's translate seat: namespace-bound, with `{name}` template params. */
type PanelTranslate = Translate<McpAdapterLocaleKey>

/**
 * What `prompt` resolves: the Remote acceptance, or the Remote failure's message.
 *
 * The real signature is `Promise<RemoteResult<{ accepted: true }>>` from
 * `@deepseek-ai/dsh-api-session-controller`; `RemoteResult` is declared on the `ok` discriminator and
 * its failure is a `RemoteError`, so this states the two fields the panel reads and nothing more.
 */
type PromptOutcome = { readonly ok: true } | { readonly ok: false; readonly error: { readonly message: string } }

/**
 * The Session face the approval prompt needs.
 *
 * Declared here, like `ClientContext` in `./index.ts`, because the Session store's own types are built
 * from `@deepseek-ai/dsh-client-store`, which is not a dependency of this package: without a
 * structural declaration `SessionFace` collapses to `any` and this panel's only approval path goes
 * unchecked. The installed `@deepseek-ai/dsh-api-session-controller` declares the real shapes —
 * `ISessions.binding(id)` yields a `SessionBinding` whose `session.prompt(content, mode, signal?,
 * requestId?)` has exactly this signature — so this is the slice, not a guess.
 */
interface SessionFaceLike {
  prompt: (content: PromptContentPart[], mode: 'queue') => Promise<PromptOutcome>
}

/** The store slice {@link SessionFaceLike} is reached through. */
interface SessionsLike {
  binding?: (sessionId: SessionIdOf) => { readonly session?: SessionFaceLike } | undefined
}

/**
 * Props the panel receives: the slot's session standard kit plus its own injected face and copy.
 *
 * `sessionId` and `useProjection` are picked from `SessionStandardProps` rather than re-declared, so
 * this component stays bound to whatever the slot framework actually delivers.
 */
export interface McpPanelProps extends Pick<SessionStandardProps, 'sessionId' | 'useProjection'> {
  /** The Session store: `binding()` yields the face whose `prompt` sends the approval turn. */
  readonly sessions: SessionsLike
  /** The framework-synthesized translate for this entry's locale namespace. */
  readonly t: PanelTranslate
}

/** Map a server state onto the shared dot vocabulary. */
function dotState(state: PanelServer['state']): StateDotState {
  switch (state) {
    case 'ready': return 'done'
    case 'starting': return 'ongoing'
    case 'error': return 'error'
    case 'blocked': return 'warning'
    default: return 'idle'
  }
}

/** Translation key for a server state. */
function stateKey(state: PanelServer['state']): McpAdapterLocaleKey {
  switch (state) {
    case 'ready': return 'stateReady'
    case 'starting': return 'stateStarting'
    case 'error': return 'stateError'
    case 'blocked': return 'stateBlocked'
    default: return 'stateStopped'
  }
}

/**
 * One mounted server: name, state, counts, and (on request) its tool names.
 * @param props.server - the snapshot row.
 * @param props.t - namespace-bound translate.
 * @returns the row element.
 */
function ServerRow({ server, t }: { readonly server: PanelServer; readonly t: PanelTranslate }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const hasTools = server.toolNames.length > 0
  return (
    <div className={css.row}>
      <div className={css.rowHead}>
        <span className={css.memberDot}>
          <StateDot state={dotState(server.state)} />
        </span>
        <span className={css.name} title={server.name}>{server.name}</span>
        <span className={css.count}>{t(stateKey(server.state))}</span>
        <span className={css.count}>{String(server.tools)} {t('tools')}</span>
      </div>
      <div className={css.meta}>
        {server.transport.length > 0 && <span>{t('transport')}: {server.transport}</span>}
        {server.lifecycle.length > 0 && <span>{t('lifecycle')}: {server.lifecycle}</span>}
      </div>
      {server.lastError.length > 0 && <div className={css.error} role="alert">{server.lastError}</div>}
      {hasTools && (
        <button
          type="button"
          className={css.toggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <IconChevronDownOutlineRegular size={12} className={expanded ? css.toggleOpen : undefined} />
          {t(expanded ? 'hideTools' : 'showTools', { count: server.toolNames.length })}
        </button>
      )}
      {hasTools && expanded && (
        <ul className={css.tools}>
          {server.toolNames.map((name) => <li key={name}>{name}</li>)}
        </ul>
      )}
    </div>
  )
}

/**
 * One held-back server: its name, why it is held back, and the two approval paths.
 * @param props.server - the snapshot row (its `blockedReason` is shown as the meta line).
 * @param props.busy - whether this row's approval request is in flight.
 * @param props.onAsk - send the approval as a normal user turn.
 * @param props.onCopy - copy the equivalent slash command.
 * @param props.copied - the name whose command was just copied, for the button label.
 * @param props.t - namespace-bound translate.
 * @returns the row element.
 */
function BlockedRow({ server, busy, onAsk, onCopy, copied, t }: {
  readonly server: PanelServer
  readonly busy: boolean
  readonly onAsk: (name: string) => void
  readonly onCopy: (name: string) => void
  readonly copied: string
  readonly t: PanelTranslate
}): ReactElement {
  return (
    <div className={css.row}>
      <div className={css.rowHead}>
        <span className={css.memberDot}>
          <StateDot state="warning" />
        </span>
        <span className={css.name} title={server.name}>{server.name}</span>
        <span className={css.actions}>
          <button
            type="button"
            className={`${css.action} ${css.actionPrimary}`}
            disabled={busy}
            title={t('askApprove', { name: server.name })}
            onClick={() => onAsk(server.name)}
          >
            <IconCheckOutlineRegular size={12} />
            {t('approve')}
          </button>
          <button type="button" className={css.action} onClick={() => onCopy(server.name)}>
            <IconCopyOutlineRegular size={12} />
            {t(copied === server.name ? 'copied' : 'copyCommand')}
          </button>
        </span>
      </div>
      <div className={css.meta}>{server.blockedReason}</div>
    </div>
  )
}

/**
 * The panel: reads the `mcpAdapter` projection and offers the two approval paths.
 * @param props - the slot's session standard kit, the injected `sessions`, and the translate seat.
 * @returns the header action plus, while open, the portaled dialog.
 */
export function McpPanel({ sessionId, useProjection, sessions, t }: McpPanelProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16, align: 'end' })
  // Key-first, as the installed `UseProjection` declares: the key selects the projection, the
  // selector narrows it. The shipped artefact passed a state selector alone, which resolves the key
  // to `undefined` and throws on `undefined.mcpAdapter`.
  const snapshot: StatusSnapshot | undefined = useProjection('mcpAdapter', (value) => value)

  // Switching Session must not carry a copied label, a stuck spinner, or another Session's error.
  useEffect(() => {
    setOpen(false)
    setCopied('')
    setBusy('')
    setError(null)
  }, [sessionId])

  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
    }
    document.addEventListener('keydown', dismiss)
    return () => document.removeEventListener('keydown', dismiss)
  }, [open])

  /** Send the approval request as a normal user turn; the model calls `mcp_approve`. */
  const ask = async (name: string): Promise<void> => {
    const face = sessions?.binding?.(sessionId)?.session
    if (face === undefined || typeof face.prompt !== 'function') {
      setError(t('unavailable'))
      return
    }
    setBusy(name)
    setError(null)
    try {
      // `queue` appends a turn instead of interrupting one: approving a server is never urgent
      // enough to cut the running turn off.
      const content: PromptContentPart[] = [{ type: 'text', text: `Approve the MCP server "${name}" (use mcp_approve).` }]
      const result = await face.prompt(content, 'queue')
      if (!result.ok) setError(result.error.message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  /** Copy the slash command for an operator who would rather not spend a turn. */
  const copy = async (name: string): Promise<void> => {
    const command = `/mcp-adapter approve ${name}`
    try {
      await navigator.clipboard.writeText(command)
      setCopied(name)
    } catch {
      setError(command)
    }
  }

  const blocked = snapshot === undefined ? [] : snapshot.servers.filter((server) => server.blockedReason.length > 0)
  const mounted = snapshot === undefined ? [] : snapshot.servers.filter((server) => server.blockedReason.length === 0)
  const triggerCount = snapshot === undefined || snapshot.counts.servers === 0
    ? ''
    : snapshot.counts.blocked > 0
      ? `${snapshot.counts.running}/${snapshot.counts.servers}`
      : String(snapshot.counts.servers)

  return (
    <div ref={rootRef} className={css.root} data-mcp-adapter-action>
      <button
        type="button"
        ref={triggerRef}
        className={css.trigger}
        aria-label={t('title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <IconDataOutlineRegular size={14} />
        <span className={css.triggerLabel}>{t('trigger')}</span>
        {triggerCount.length > 0 && <span className={css.count}>{triggerCount}</span>}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={t('title')}
          data-mcp-adapter-panel
        >
          <div className={css.body}>
            {error !== null && (
              <div className={css.notice} role="alert">
                <StateDot state="error" />
                {error}
              </div>
            )}
            {snapshot === undefined && (
              <div className={css.notice} role="status">
                <StateDot state="warning" />
                {t('unavailable')}
              </div>
            )}
            {snapshot !== undefined && (
              <>
                <h3>{t('title')}</h3>
                {snapshot.projectRoot.length > 0 && (
                  <p className={css.rootPath}>{t('projectRoot')}: {snapshot.projectRoot}</p>
                )}
                {blocked.length > 0 && (
                  <>
                    <h3>
                      {t('blockedTitle')}
                      <span className={css.count}>{blocked.length}</span>
                    </h3>
                    <div className={css.rows}>
                      {blocked.map((server) => (
                        <BlockedRow
                          key={server.name}
                          server={server}
                          busy={busy === server.name}
                          onAsk={ask}
                          onCopy={copy}
                          copied={copied}
                          t={t}
                        />
                      ))}
                    </div>
                  </>
                )}
                <h3>
                  {t('servers')}
                  {mounted.length > 0 && <span className={css.count}>{mounted.length}</span>}
                </h3>
                {mounted.length === 0
                  ? <p className={css.emptyNotice}>{t('empty')}</p>
                  : (
                    <div className={css.rows}>
                      {mounted.map((server) => <ServerRow key={server.name} server={server} t={t} />)}
                    </div>
                  )}
                {snapshot.problems.length > 0 && (
                  <>
                    <h3>{t('problems')}</h3>
                    {snapshot.problems.map((problem) => (
                      <div key={problem} className={css.error} role="alert">{problem}</div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
