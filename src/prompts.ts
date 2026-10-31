// MCP prompt templates as dsh slash commands: `/mcp__<server>__<prompt> [args]`.
//
// A prompt is the server's own reusable instruction. dsh's command surface can return text to the
// turn, which is what a prompt is for — the same mapping pi-mcp-adapter does with Pi's commands.

/** One declared argument of a prompt, the only field `parsePromptArgs` reads. */
export interface PromptArgumentDef {
  name: string
  required?: boolean
}

/** `mcp__<server>__<prompt>`, the shape Claude Code and Codex use for MCP prompts. */
export function promptCommandName(serverName: string, promptName: string): string {
  const raw = `mcp__${serverName}__${promptName}`.replace(/[^A-Za-z0-9_-]+/g, '_')
  return raw.slice(0, 64)
}

/**
 * Split a prompt invocation the way pi-mcp-adapter does: positional arguments first, then
 * `key=value` pairs, with double quotes honoured.
 * @returns a record the server's `arguments` object expects.
 */
export function parsePromptArgs(rawInput: string, argumentDefs: PromptArgumentDef[] = []): { args: Record<string, string>; missing: string[] } {
  const tokens = tokenize(String(rawInput ?? ''))
  const named: Record<string, string> = {}
  const positional: string[] = []
  for (const token of tokens) {
    const match = /^([A-Za-z0-9_.-]+)=(.*)$/.exec(token)
    if (match === null) {
      positional.push(token)
      continue
    }
    named[match[1]] = match[2]
  }
  const args: Record<string, string> = { ...named }
  const remaining = argumentDefs.filter((definition) => args[definition.name] === undefined)
  for (const [index, value] of positional.entries()) {
    const slot = remaining[index]
    if (slot === undefined) break
    args[slot.name] = value
  }
  const missing = argumentDefs.filter((definition) => definition.required === true && (args[definition.name] === undefined || args[definition.name] === ''))
  return { args, missing: missing.map((definition) => definition.name) }
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  for (const character of input) {
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(character)) {
      if (current.length > 0) tokens.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/** An object-shaped value, which is all this module reads off an unknown block. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Flatten an MCP `prompts/get` result into one message, keeping `[role]` markers so a
 * multi-message prompt survives as text.
 */
export function flattenPromptResult(result: unknown): string {
  const parts: string[] = []
  // `Array.isArray` on `unknown` narrows to `any[]`; binding to `unknown[]` keeps it honest.
  const messages: unknown[] = isRecord(result) && Array.isArray(result.messages) ? result.messages : []
  for (const message of messages) {
    const record = isRecord(message) ? message : undefined
    const role = record?.role ?? 'user'
    const content = isRecord(record?.content) ? record.content : undefined
    const resource = isRecord(content?.resource) ? content.resource : undefined
    // A `text` block whose body is not a string contributes nothing.
    //
    // This is a wider deviation than "the malformed shape the source crashed on". The source read
    // `content.text` and then called `.length` on it, so:
    //   - `{type:'text'}` with no `text`, or `text: null` -> TypeError (no `.length` to read);
    //   - `text: 5`, `0`, `false`, `NaN`, `[]` -> already produced this same placeholder, because
    //     `.length` is `undefined` and the source's own `text.length > 0` check is false;
    //   - `text: ['a']`, `text: {length: 2}` -> the source coerced and kept the block
    //     (`[user] a`, `[user] [object Object]`), while this port drops it.
    // Only that last group is a behaviour change, and the MCP client cannot produce it:
    // `TextContentSchema` requires `text: z.string()`.
    const text =
      content?.type === 'text'
        ? typeof content.text === 'string'
          ? content.text
          : ''
        : content?.type === 'resource'
          ? `[resource ${resource?.uri ?? ''}]`
          : content?.type === 'image'
            ? '[image omitted]'
            : ''
    if (text.length > 0) parts.push(`[${role}] ${text}`)
  }
  return parts.join('\n\n') || '(the prompt produced no text)'
}
