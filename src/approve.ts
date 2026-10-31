// `mcp_approve` — the model-facing form of `/mcp-adapter approve`.
//
// Why a tool and not a Remote method: the Web panel has no Remote namespace to call (its package is
// not on the shipped assembly's contribution list), so the panel drives this the way a user would —
// by asking for it in the conversation. Keeping it a real tool rather than a hidden side channel has
// a second benefit: the approval is visible in the transcript, which is what an audit trail of
// "this repository's server was trusted" should look like.

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { McpSession } from './session.ts'
import { approveProjectServer } from './status.ts'
import { projectResult } from './util.ts'

const text = (value: string): { content: Array<{ type: 'text'; text: string }> } => ({ content: [{ type: 'text', text: value }] })

export const APPROVE_TOOL_NAME = 'mcp_approve'

/** The tool's argument schema: an object root, for the same reason `PROXY_PARAMETERS` is one. */
export const APPROVE_PARAMETERS: { type: 'object'; properties: Record<string, { type: 'string'; description: string }>; additionalProperties: false } = {
  type: 'object',
  additionalProperties: false,
  properties: {
    server: { type: 'string', description: 'Name of the project MCP server to approve, exactly as the blocked list shows it' },
  },
}

export const APPROVE_DESCRIPTION = [
  'Approve one project MCP server so it may start.',
  'Use it only when the operator asked for that server by name — approval means the server\'s own command will run.',
  'Servers listed as blocked by project trust need this; global servers never do.',
].join(' ')

/**
 * The requested server name, read off an untyped argument map.
 *
 * `execute` receives `unknown` by contract, and the source's `typeof args.server === 'string'` guard
 * is kept verbatim: anything that is not an object carrying a string `server` reads as "no name
 * given", which is the same branch the source took for a missing or non-string argument.
 * @param args - the tool's arguments as the runtime handed them over.
 * @returns the trimmed name, or `''` when none was supplied.
 */
function serverArg(args: unknown): string {
  if (!isObjectLike(args)) return ''
  const raw: unknown = args.server
  return typeof raw === 'string' ? raw.trim() : ''
}

/** An object-shaped value, arrays included. */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Build the tool definition.
 * @param getSession - returns the Agent's `McpSession` or undefined.
 * @param onApproved - re-arm the Agent so the newly approved server reaches the next step.
 * @param onChanged - publish the new status for the Web panel.
 * @returns a dsh tool definition.
 */
export function approveToolDefinition(
  getSession: () => McpSession | undefined,
  onApproved?: () => void | Promise<void>,
  onChanged?: () => void | Promise<void>,
): ToolDefinition {
  return {
    name: APPROVE_TOOL_NAME,
    description: APPROVE_DESCRIPTION,
    parameters: APPROVE_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => projectResult(value),
    },
    async execute(args) {
      const session = getSession()
      if (session === undefined) return text('MCP is not initialized for this session yet.')
      const server = serverArg(args)
      if (server.length === 0) return text('usage: mcp_approve({ server: "<name>" })')
      const result = approveProjectServer(session, server)
      if (!result.ok) return text(result.error)
      await onApproved?.()
      await onChanged?.()
      return text(`Approved "${server}" for ${session.projectRoot}. Its tools are available from the next step.`)
    },
  }
}
