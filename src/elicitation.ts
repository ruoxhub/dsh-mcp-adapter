import type { Client } from '@modelcontextprotocol/client'
import { combinedSignal } from './util.ts'

export type ElicitationAction = 'accept' | 'decline' | 'cancel'

export interface ElicitResult {
  action: ElicitationAction
  content?: Record<string, unknown>
}

export interface ElicitationRequestParams {
  mode?: 'form' | 'url'
  message?: string
  url?: string
  requestedSchema?: {
    type?: string
    properties?: Record<string, {
      type?: string
      title?: string
      description?: string
      enum?: Array<string | number | boolean>
      default?: unknown
    }>
    required?: string[]
  }
}

export interface UserQuestionsLike {
  ask(request: {
    questions: Array<{
      id: string
      question: string
      detail?: string
      header?: string
      options?: Array<{ label: string; description?: string }>
      multiSelect?: boolean
    }>
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{
    answers: Array<{
      id: string
      selected?: string[]
      custom?: string
    }>
  }>
}

export interface ElicitationHandlerOptions {
  serverName: string
  userQuestions?: UserQuestionsLike
  agent?: unknown
}

interface PromptPause {
  open: number
  deadlines: Set<{ pause(): void; resume(): void }>
}

const promptPauses = new WeakMap<Client, PromptPause>()

async function whilePromptOpen<T>(state: PromptPause, run: () => Promise<T>): Promise<T> {
  if (state.open++ === 0) {
    for (const deadline of state.deadlines) deadline.pause()
  }
  try {
    return await run()
  } finally {
    if (--state.open === 0) {
      for (const deadline of state.deadlines) deadline.resume()
    }
  }
}

/**
 * Handle elicitation/create requests from MCP servers.
 * Converts form schemas to host `ctx.userQuestions` requests, or safely declines
 * when no question provider exists to prevent deadlocks in headless/sub-agent turns.
 */
export async function handleElicitationRequest(
  options: ElicitationHandlerOptions,
  params?: ElicitationRequestParams,
  signal?: AbortSignal,
): Promise<ElicitResult> {
  if (signal?.aborted) return { action: 'cancel' }

  // Fallback: If URL mode, missing params, or no userQuestions capability is present,
  // decline immediately to prevent hanging headless or automated workflows.
  if (!params || params.mode === 'url' || !options.userQuestions) {
    return { action: 'decline' }
  }

  const schema = params.requestedSchema
  const properties = schema?.properties ?? {}
  const propEntries = Object.entries(properties)

  // If schema has no properties, ask for a simple confirmation
  if (propEntries.length === 0) {
    const questionItem = {
      id: 'confirm',
      header: `[${options.serverName}]`,
      question: params.message ?? `Allow action from MCP server ${options.serverName}?`,
      options: [
        { label: 'Continue', description: 'Allow server request' },
        { label: 'Decline', description: 'Decline server request' },
      ],
    }

    try {
      const res = await options.userQuestions.ask({
        questions: [questionItem],
        agent: options.agent,
        signal,
      })
      const answer = res.answers?.[0]
      const chosen = answer?.selected?.[0] ?? answer?.custom
      if (chosen === 'Continue' || chosen === 'yes') {
        return { action: 'accept', content: {} }
      }
      return { action: 'decline' }
    } catch {
      return { action: 'decline' }
    }
  }

  // Convert schema fields into structured AskUserQuestionItem questions
  const questions = propEntries.map(([name, prop]) => {
    const required = schema?.required?.includes(name)
    const title = prop.title ?? name
    const qText = `${params.message ? `${params.message}\n` : ''}${title}${required ? ' (required)' : ''}`

    let optionsList: Array<{ label: string; description?: string }> | undefined
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      optionsList = prop.enum.map((val) => ({ label: String(val) }))
    } else if (prop.type === 'boolean') {
      optionsList = [{ label: 'true' }, { label: 'false' }]
    }

    return {
      id: name,
      header: `[${options.serverName}]`,
      question: qText,
      detail: prop.description,
      options: optionsList,
      multiSelect: prop.type === 'array',
    }
  })

  try {
    const result = await options.userQuestions.ask({
      questions,
      agent: options.agent,
      signal,
    })

    const content: Record<string, unknown> = {}
    for (const ans of result.answers ?? []) {
      const prop = properties[ans.id]
      const rawValue = (ans.selected && ans.selected.length > 0)
        ? (prop?.type === 'array' ? ans.selected : ans.selected[0])
        : ans.custom

      if (rawValue !== undefined) {
        if (prop?.type === 'boolean') {
          content[ans.id] = rawValue === 'true' || (rawValue as unknown) === true
        } else if (prop?.type === 'number' || prop?.type === 'integer') {
          const num = Number(rawValue)
          content[ans.id] = Number.isFinite(num) ? num : rawValue
        } else {
          content[ans.id] = rawValue
        }
      } else if (prop?.default !== undefined) {
        content[ans.id] = prop.default
      }
    }

    return { action: 'accept', content }
  } catch {
    return { action: 'decline' }
  }
}

/**
 * Register elicitation request handler on an MCP Client.
 */
export function registerElicitationHandler(client: Client, options: ElicitationHandlerOptions): void {
  const state: PromptPause = { open: 0, deadlines: new Set() }
  promptPauses.set(client, state)

  // Use any cast for generic SDK request handler binding
  ;(client as any).setRequestHandler('elicitation/create', async (request: any) => {
    return await whilePromptOpen(state, async () => {
      return await handleElicitationRequest(options, request?.params)
    })
  })
}

const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Invokes client.callTool, pausing the request timeout while an elicitation prompt
 * is waiting for user response on this client.
 */
export async function callToolPausingForElicitation(
  client: Client,
  params: Parameters<Client['callTool']>[0],
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<unknown> {
  const state = promptPauses.get(client)
  if (!state) {
    return await client.callTool(params, options)
  }

  const timeout = Math.min(options?.timeout ?? 30000, MAX_TIMER_MS)
  const expired = new AbortController()
  let remaining = timeout
  let startedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const deadline = {
    pause() {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
      remaining -= Date.now() - startedAt
    },
    resume() {
      startedAt = Date.now()
      timer = setTimeout(() => {
        expired.abort(new Error(`MCP tool call timed out after ${timeout}ms`))
      }, Math.max(remaining, 0))
    },
  }

  state.deadlines.add(deadline)
  if (state.open === 0) deadline.resume()

  try {
    return await client.callTool(params, {
      ...options,
      timeout: MAX_TIMER_MS,
      signal: combinedSignal(options?.signal, expired.signal) ?? expired.signal,
    })
  } finally {
    state.deadlines.delete(deadline)
    deadline.pause()
  }
}
