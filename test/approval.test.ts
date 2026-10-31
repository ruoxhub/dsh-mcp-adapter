import { describe, expect, it } from 'vitest'
import { approvalReason, needsApproval } from '../src/approval.ts'
import { flattenPromptResult, parsePromptArgs, promptCommandName } from '../src/prompts.ts'
import { requireApproval } from '../src/approval.ts'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import type { AdapterSettings } from '../src/config.ts'
import type { CatalogTool, ServerConfig } from '../src/types.ts'

const settings = { approveTools: false } as never
const tool = { name: 'demo_ping', originalName: 'ping', annotations: undefined } as never

describe('approval policy', () => {
  it('asks for nothing by default', () => {
    expect(needsApproval(undefined, tool, settings)).toBe(false)
  })

  it('treats autoApprove as an allowlist: unlisted tools ask', () => {
    const config = { autoApprove: ['other'] } as never
    expect(needsApproval(config, tool, settings)).toBe(true)
    expect(approvalReason(config, tool, settings)).toContain('autoApprove')
  })

  it('a destructive annotation asks only under approveTools: "destructive"', () => {
    const destructive = { name: 'demo_del', originalName: 'del', annotations: { destructiveHint: true } } as never
    expect(needsApproval(undefined, destructive, { approveTools: 'destructive' } as never)).toBe(true)
    expect(needsApproval(undefined, destructive, { approveTools: false } as never)).toBe(false)
  })

  it('normalizes a prompt name and parses positional plus key=value args', () => {
    expect(promptCommandName('my server', 'retry policy')).toBe('mcp__my_server__retry_policy')
    const parsed = parsePromptArgs('"retry policy" mode=strict', [{ name: 'topic', required: true }, { name: 'mode' }])
    expect(parsed.args).toEqual({ topic: 'retry policy', mode: 'strict' })
    expect(parsed.missing).toEqual([])
  })

  it('flattens prompt messages with role markers', () => {
    expect(flattenPromptResult({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] })).toBe('[user] hi')
  })
})

// The five tests above leave most of both modules unguarded. Every expectation below was checked
// against the pre-port `lib/approval.mjs` and `lib/prompts.mjs` (since removed) before it was
// written down.

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'demo',
    transport: 'stdio',
    args: [],
    env: {},
    inheritEnv: true,
    cwd: '',
    headers: {},
    lifecycle: 'lazy',
    directTools: false,
    exposeResources: true,
    appendStructuredContent: false,
    debug: false,
    ...overrides,
  }
}

function catalogTool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    name: 'demo_ping',
    server: 'demo',
    originalName: 'ping',
    description: '',
    inputSchema: undefined,
    outputSchema: undefined,
    keywords: [],
    ...overrides,
  }
}

function policy(approveTools: AdapterSettings['approveTools']): AdapterSettings {
  return { ...DEFAULT_SETTINGS, approveTools }
}

describe('autoApprove is an allowlist', () => {
  it('asks about nothing when it is true, and about every unlisted tool otherwise', () => {
    expect(needsApproval(config({ autoApprove: true }), catalogTool(), policy(false))).toBe(false)
    expect(needsApproval(config({ autoApprove: ['other'] }), catalogTool(), policy(false))).toBe(true)
  })

  it('matches either the prefixed name or the original name', () => {
    expect(needsApproval(config({ autoApprove: ['ping'] }), catalogTool(), policy(false))).toBe(false)
    expect(needsApproval(config({ autoApprove: ['demo_ping'] }), catalogTool(), policy(false))).toBe(false)
  })

  it('treats an empty list as an empty allowlist, so every tool asks', () => {
    expect(needsApproval(config({ autoApprove: [] }), catalogTool(), policy(false))).toBe(true)
  })

  it('treats a list containing "*" as the whole server', () => {
    expect(needsApproval(config({ autoApprove: ['*'] }), catalogTool(), policy(false))).toBe(false)
  })

  it('trims entries and drops empty ones', () => {
    expect(needsApproval(config({ autoApprove: ['  ping  '] }), catalogTool(), policy(false))).toBe(false)
    expect(needsApproval(config({ autoApprove: ['', '   '] }), catalogTool(), policy(false))).toBe(true)
  })

  it('is case-sensitive, so a differently cased name still asks', () => {
    expect(needsApproval(config({ autoApprove: ['PING'] }), catalogTool(), policy(false))).toBe(true)
  })

  it('lets false fall through to approveTools, and treats a non-array value as the whole server', () => {
    expect(needsApproval(config({ autoApprove: false }), catalogTool(), policy(true))).toBe(true)
    expect(needsApproval(config({ autoApprove: 'yes' }), catalogTool(), policy(true))).toBe(false)
  })

  it('wins over a per-server approveTools: true', () => {
    expect(needsApproval(config({ autoApprove: ['*'], approveTools: true }), catalogTool(), policy(true))).toBe(false)
    expect(needsApproval(config({ autoApprove: ['other'], approveTools: true }), catalogTool(), policy(true))).toBe(true)
  })

  it('explains the allowlist before the destructive annotation does', () => {
    const destructive = catalogTool({ annotations: { destructiveHint: true } })
    expect(approvalReason(config({ autoApprove: ['other'] }), destructive, policy(true))).toBe(
      'this server lists its pre-approved tools with autoApprove, and this one is not on the list',
    )
  })
})

describe('approveTools is a denylist', () => {
  it('asks for every tool when true', () => {
    expect(needsApproval(undefined, catalogTool(), policy(true))).toBe(true)
    expect(approvalReason(undefined, catalogTool(), policy(true))).toBe('this server asks before every tool call')
  })

  it('asks only for the listed names, matching the prefixed or the original name', () => {
    expect(needsApproval(undefined, catalogTool(), policy(['ping']))).toBe(true)
    expect(needsApproval(undefined, catalogTool(), policy(['demo_ping']))).toBe(true)
    expect(needsApproval(undefined, catalogTool(), policy(['other']))).toBe(false)
    expect(needsApproval(undefined, catalogTool(), policy([]))).toBe(false)
    expect(approvalReason(undefined, catalogTool(), policy(['ping']))).toBe('this MCP tool is listed in approveTools')
  })

  it('treats a list containing "*" as every tool', () => {
    expect(needsApproval(undefined, catalogTool(), policy(['*']))).toBe(true)
  })

  it('asks under "destructive" only when the tool carries destructiveHint: true', () => {
    expect(needsApproval(undefined, catalogTool({ annotations: { destructiveHint: true } }), policy('destructive'))).toBe(true)
    expect(needsApproval(undefined, catalogTool({ annotations: { destructiveHint: false } }), policy('destructive'))).toBe(false)
    expect(needsApproval(undefined, catalogTool(), policy('destructive'))).toBe(false)
    expect(approvalReason(undefined, catalogTool({ annotations: { destructiveHint: true } }), policy(false))).toBe(
      'this MCP tool is marked destructive by its server',
    )
  })

  it('lets a server-level approveTools override the settings-level one in both directions', () => {
    expect(needsApproval(config({ approveTools: false }), catalogTool(), policy(true))).toBe(false)
    expect(needsApproval(config({ approveTools: ['ping'] }), catalogTool(), policy(false))).toBe(true)
    expect(needsApproval(config({ approveTools: 'destructive' }), catalogTool(), policy(true))).toBe(false)
  })

  it('falls back to the settings when the server declares no approveTools', () => {
    expect(needsApproval(config(), catalogTool(), policy(true))).toBe(true)
    expect(needsApproval(config({ approveTools: false }), catalogTool(), policy(['ping']))).toBe(false)
  })

  it('applies the settings when there is no server config at all', () => {
    expect(needsApproval(undefined, catalogTool(), policy(['ping']))).toBe(true)
    expect(needsApproval(undefined, catalogTool(), policy(['other']))).toBe(false)
    expect(needsApproval(undefined, catalogTool(), policy('destructive'))).toBe(false)
  })
})

describe('requireApproval', () => {
  const target = catalogTool()
  const noService = 'MCP tool "demo_ping" requires approval, but no approval service is available in this composition'

  it('refuses when the composition has no approval service', async () => {
    const contexts = [
      undefined,
      {},
      { get: () => undefined },
      { get: () => ({}) },
      { get: () => ({ request: 'not a function' }) },
      { approval: {} },
    ]
    for (const ctx of contexts) {
      await expect(requireApproval('agent', ctx, target, undefined, undefined, policy(true))).rejects.toThrow(noService)
    }
  })

  it('refuses a null service with the documented refusal instead of a TypeError', async () => {
    // The source read `approval.request` off null and threw "Cannot read properties of null". Both
    // refuse, which is the guarantee this gate makes; only the sentence differs, and this one names
    // the real cause. Kept as the one deliberate deviation, pinned so it stays deliberate.
    await expect(requireApproval('agent', { get: () => null }, target, undefined, undefined, policy(true))).rejects.toThrow(noService)
  })

  it('reads the service off ctx.approval when the context has no get', async () => {
    const ctx = { approval: { request: async () => 'allowed-once' } }
    await expect(requireApproval('agent', ctx, target, undefined, undefined, policy(true))).resolves.toBeUndefined()
  })

  it('refuses every outcome other than allowed-once', async () => {
    for (const outcome of ['denied', 'rejected', undefined, null]) {
      const ctx = { get: () => ({ request: async () => outcome }) }
      await expect(requireApproval('agent', ctx, target, undefined, undefined, policy(true))).rejects.toThrow(
        `MCP tool "demo_ping" was not approved (${outcome})`,
      )
    }
  })

  it('returns on allowed-once, asking with the prefixed tool name and the reason', async () => {
    const requests: unknown[] = []
    const ctx = {
      get: () => ({
        request: async (request: unknown) => {
          requests.push(request)
          return 'allowed-once'
        },
      }),
    }
    await expect(requireApproval('agent-1', ctx, target, undefined, undefined, policy(true))).resolves.toBeUndefined()
    expect(requests).toStrictEqual([
      { agent: 'agent-1', toolName: 'mcp:demo/ping', reason: 'this server asks before every tool call', signal: undefined },
    ])
  })

  it('forwards exec.callId only when it is present', async () => {
    const requests: unknown[] = []
    const ctx = {
      get: () => ({
        request: async (request: unknown) => {
          requests.push(request)
          return 'allowed-once'
        },
      }),
    }
    const signal = new AbortController().signal
    await requireApproval('agent-1', ctx, target, { callId: 'call-9', signal }, undefined, policy(true))
    await requireApproval('agent-1', ctx, target, { signal }, undefined, policy(true))
    await requireApproval('agent-1', ctx, target, undefined, undefined, policy(true))
    expect(requests).toStrictEqual([
      { agent: 'agent-1', toolName: 'mcp:demo/ping', callId: 'call-9', reason: 'this server asks before every tool call', signal },
      { agent: 'agent-1', toolName: 'mcp:demo/ping', reason: 'this server asks before every tool call', signal },
      { agent: 'agent-1', toolName: 'mcp:demo/ping', reason: 'this server asks before every tool call', signal: undefined },
    ])
  })
})

describe('parsePromptArgs', () => {
  it('drops positional arguments past the last slot', () => {
    expect(parsePromptArgs('one two three', [{ name: 'a' }, { name: 'b' }])).toEqual({ args: { a: 'one', b: 'two' }, missing: [] })
  })

  it('assigns key=value first, so positionals fill only the slots still empty', () => {
    expect(parsePromptArgs('strict hello', [{ name: 'mode' }, { name: 'topic' }])).toEqual({ args: { mode: 'strict', topic: 'hello' }, missing: [] })
    expect(parsePromptArgs('pos mode=strict', [{ name: 'topic' }, { name: 'mode' }])).toEqual({ args: { mode: 'strict', topic: 'pos' }, missing: [] })
    // The named slot sits BEFORE the positional's index here, so an implementation that fills by
    // positional index instead of first-empty-slot overwrites `mode` with `pos` and fails.
    expect(parsePromptArgs('pos mode=strict', [{ name: 'mode' }, { name: 'topic' }])).toEqual({ args: { mode: 'strict', topic: 'pos' }, missing: [] })
  })

  it('reports a missing required argument, including an empty named value', () => {
    expect(parsePromptArgs('', [{ name: 'topic', required: true }])).toEqual({ args: {}, missing: ['topic'] })
    expect(parsePromptArgs('mode=', [{ name: 'mode', required: true }])).toEqual({ args: { mode: '' }, missing: ['mode'] })
    expect(parsePromptArgs('one', [{ name: 'a', required: true }, { name: 'b', required: true }])).toEqual({ args: { a: 'one' }, missing: ['b'] })
  })

  it('keeps quoted values together even though they contain spaces', () => {
    expect(parsePromptArgs('"retry policy"', [{ name: 'q' }])).toEqual({ args: { q: 'retry policy' }, missing: [] })
    expect(parsePromptArgs('a"b c"d', [{ name: 'x' }])).toEqual({ args: { x: 'ab cd' }, missing: [] })
  })

  it('keeps an "=" inside a key=value value', () => {
    expect(parsePromptArgs('url=a=b=c', [{ name: 'url' }])).toEqual({ args: { url: 'a=b=c' }, missing: [] })
  })
})

describe('flattenPromptResult', () => {
  it('describes a resource block by its uri and omits an image', () => {
    expect(flattenPromptResult({ messages: [{ role: 'assistant', content: { type: 'resource', resource: { uri: 'file:///a.txt' } } }] })).toBe(
      '[assistant] [resource file:///a.txt]',
    )
    expect(flattenPromptResult({ messages: [{ role: 'user', content: { type: 'image', data: 'xx', mimeType: 'image/png' } }] })).toBe('[user] [image omitted]')
  })

  it('joins a multi-message prompt with a blank line, keeping every role marker', () => {
    const result = {
      messages: [
        { role: 'user', content: { type: 'text', text: 'one' } },
        { role: 'assistant', content: { type: 'text', text: 'two' } },
      ],
    }
    expect(flattenPromptResult(result)).toBe('[user] one\n\n[assistant] two')
  })

  it('returns a placeholder for an empty or malformed result', () => {
    for (const result of [undefined, null, {}, { messages: [] }, { messages: 'nope' }]) {
      expect(flattenPromptResult(result)).toBe('(the prompt produced no text)')
    }
  })

  it('treats a text block whose body is not a string as empty, the one documented deviation', () => {
    // The source called `.length` on whatever `text` held: a body with no length property either
    // crashed (missing/null) or already produced this placeholder (5, 0, false, NaN, []). Bodies
    // with a truthy `.length` are where the two actually differ: the source coerced them
    // (`[user] a`, `[user] [object Object]`), the port drops them.
    for (const text of [undefined, null, 5, 0, false, NaN, [], ['a'], { length: 2 }]) {
      expect(flattenPromptResult({ messages: [{ role: 'user', content: { type: 'text', text } }] })).toBe('(the prompt produced no text)')
    }
  })

  it('defaults a missing role to user and skips unknown content types', () => {
    expect(flattenPromptResult({ messages: [{ content: { type: 'text', text: 'hi' } }] })).toBe('[user] hi')
    expect(flattenPromptResult({ messages: [{ role: 'user', content: { type: 'audio' } }, { role: 'user', content: { type: 'text', text: 'kept' } }] })).toBe(
      '[user] kept',
    )
  })
})

describe('promptCommandName', () => {
  it('clamps the command name to 64 characters', () => {
    const name = promptCommandName('a'.repeat(40), 'b'.repeat(40))
    expect(name).toHaveLength(64)
    expect(name).toBe(`mcp__${'a'.repeat(40)}__${'b'.repeat(17)}`)
    expect(promptCommandName('x'.repeat(57), 'y')).toBe(`mcp__${'x'.repeat(57)}__`)
  })

  it('replaces every character outside [A-Za-z0-9_-] with an underscore', () => {
    expect(promptCommandName('ser/ver:1', 'pro.mpt (x)')).toBe('mcp__ser_ver_1__pro_mpt_x_')
    expect(promptCommandName('a-b', 'c_d')).toBe('mcp__a-b__c_d')
    expect(promptCommandName('sérver', 'prómpt')).toBe('mcp__s_rver__pr_mpt')
  })
})
