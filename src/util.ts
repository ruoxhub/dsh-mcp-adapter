// Small shared helpers: timeouts, abort composition, and the tool-name rules the proxy and direct
// tools both have to agree on.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { imageDiagnostic } from './media.ts'
import type { ContentBlock } from './types.ts'

/** Reject when `promise` does not settle within `ms`; the underlying work is left to finish. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message ?? `timed out after ${ms} ms`)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** An AbortSignal that fires when any input fires; undefined inputs are ignored. */
export function combinedSignal(...signals: Array<AbortSignal | undefined | null>): AbortSignal | undefined {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined && signal !== null)
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  const controller = new AbortController()
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/** `serverName_toolName`, normalized to what a model-facing function name may contain. */
export function prefixedToolName(serverName: string, toolName: string, prefix = ''): string {
  const raw = `${prefix}${sanitize(serverName)}_${sanitize(toolName)}`
  return raw.length > 64 ? raw.slice(0, 64) : raw
}

function sanitize(value: unknown): string {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'x'
}

/** An object-shaped value, which is all `projectResult` needs before it reads a field. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Parse one MCP `tools/call` result into model-facing blocks.
 *
 * `images` carries what `admitResultImages()` managed to store for this result. A content index in
 * `admitted` becomes a real image block; one in `refused` becomes a text block naming the reason; an
 * index absent from both keeps the old placeholder. Taking it as an argument (rather than reading
 * host services here) is what lets the synchronous `render` seam stay pure and replayable.
 *
 * @param result - the server's `CallToolResult`.
 * @param appendStructuredContent - `false` shows the model only `content` when the server sent
 *   any; `structuredContent` is still shown when `content` is empty, because otherwise the call
 *   would look like it returned nothing at all. This is pi-mcp-adapter's `appendStructuredContent`
 *   semantics, and the field was previously normalized here and then never read.
 * @param images - admission outcome per content index; see {@link ImageAdmission}.
 */
export function projectResult(
  result: unknown,
  appendStructuredContent = true,
  images?: { admitted: ReadonlyMap<number, unknown>; refused: ReadonlyMap<number, string> },
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  const content: unknown[] = isRecord(result) && Array.isArray(result.content) ? result.content : []
  for (const [index, item] of content.entries()) {
    const record = isRecord(item) ? item : undefined
    if (record?.type === 'text' && typeof record.text === 'string') blocks.push({ type: 'text', text: record.text })
    else if (record?.type === 'image' && typeof record.data === 'string') {
      // Admitted images were stored by the host; reaching this branch with an index in `refused`
      // means admission ran and declined, so the reason replaces the old placeholder.
      const admitted = images?.admitted.get(index)
      if (admitted !== undefined) blocks.push(admitted as ContentBlock)
      else {
        const refused = images?.refused.get(index)
        blocks.push({
          type: 'text',
          text: refused === undefined
            ? `[image ${record.mimeType ?? 'unknown'} — ${Math.round((record.data.length * 3) / 4)} bytes omitted]`
            : imageDiagnostic(typeof record.mimeType === 'string' ? record.mimeType : undefined, refused),
        })
      }
    } else if (record?.type === 'resource' && isRecord(record.resource) && record.resource.uri) {
      blocks.push({ type: 'text', text: `[resource ${record.resource.uri}]` })
    } else if (item !== undefined) {
      blocks.push({ type: 'text', text: JSON.stringify(item) })
    }
  }
  const hasContent = blocks.length > 0
  if (isRecord(result) && result.structuredContent !== undefined && (appendStructuredContent || !hasContent)) {
    blocks.push({ type: 'text', text: `\n${JSON.stringify(result.structuredContent, null, 2)}` })
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '(no output)' })
  return blocks
}

/** Truncate text for a tool result, pointing the model at the cap it hit. */
export function boundedText(text: unknown, maxBytes = 64 * 1024): string {
  const source = String(text ?? '')
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source
  const slice = Buffer.from(source, 'utf8').subarray(0, maxBytes).toString('utf8')
  return `${slice}\n… [output truncated at ${maxBytes} bytes]`
}

/**
 * Safely resolves a dot-separated path on an object or array.
 */
function getByPath(target: unknown, path: string): unknown {
  if (target === null || target === undefined) return undefined
  const parts = path.split('.')
  let current: any = target
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

/**
 * Extracts named fields or dot-paths from an object or MCP tool result.
 */
export function extractFields(data: unknown, fields: string[]): unknown {
  if (!fields || fields.length === 0 || data === null || data === undefined) return data

  let target: unknown = data
  let isMcpResultWrapper = false

  if (isRecord(data) && Array.isArray(data.content) && data.content.length > 0) {
    const firstText = data.content.find((c) => isRecord(c) && c.type === 'text' && typeof c.text === 'string')
    if (firstText && typeof (firstText as any).text === 'string') {
      try {
        const parsed = JSON.parse((firstText as any).text)
        if (typeof parsed === 'object' && parsed !== null) {
          target = parsed
          isMcpResultWrapper = true
        }
      } catch {
        // Not JSON text, fall back to extracting off data directly
      }
    }
  } else if (isRecord(data) && data.structuredContent !== undefined) {
    target = data.structuredContent
    isMcpResultWrapper = true
  }

  const extracted: Record<string, unknown> = {}
  for (const field of fields) {
    extracted[field] = getByPath(target, field)
  }

  if (isMcpResultWrapper) {
    return {
      content: [{ type: 'text', text: JSON.stringify(extracted, null, 2) }],
      extracted: true,
    }
  }

  return extracted
}

export interface SpillOptions {
  home: string
  maxOutputChars?: number
  prefixChars?: number
}

/**
 * Spills long output to disk if it exceeds maxOutputChars (default: 40,000 chars).
 * Returns notice with spilled file path and preview.
 */
export function spillOutput(text: string, options: SpillOptions): { text: string; spilledPath?: string } {
  const maxOutputChars = options.maxOutputChars ?? 40_000
  if (text.length <= maxOutputChars) {
    return { text }
  }

  const prefixChars = options.prefixChars ?? 2_000
  const spillDir = join(options.home, 'spill')
  try {
    mkdirSync(spillDir, { recursive: true })
    const filename = `spill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
    const spilledPath = join(spillDir, filename)
    writeFileSync(spilledPath, text, 'utf8')

    const preview = text.slice(0, prefixChars)
    const notice = [
      `[Notice: Tool output exceeded ${maxOutputChars} characters (${text.length} chars) and was spilled to file: ${spilledPath}]`,
      `[Hint: You can use the 'read' tool to inspect parts of this file, or rerun mcp({ tool, args, extract: [...] }) to filter specific fields]`,
      '',
      `Preview (first ${prefixChars} characters):`,
      preview,
      `\n... [rest of output omitted, see spilled file: ${spilledPath}]`,
    ].join('\n')

    return { text: notice, spilledPath }
  } catch {
    return { text: boundedText(text) }
  }
}

