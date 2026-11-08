import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boundedText, extractFields, prefixedToolName, projectResult, spillOutput, withTimeout } from '../src/util.ts'

/** The text of one projected block; the projection can also emit host image blocks. */
function textAt(blocks: ReadonlyArray<{ type: string; text?: string }>, index: number): string {
  const block = blocks[index]
  if (block === undefined || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error(`block ${index} is not text: ${JSON.stringify(block)}`)
  }
  return block.text
}

describe('util', () => {
  it('prefixes a tool name and clamps it to 64 characters', () => {
    expect(prefixedToolName('demo', 'ping')).toBe('demo_ping')
    expect(prefixedToolName('demo', 'x'.repeat(80)).length).toBe(64)
  })

  it('rejects when the timeout wins', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'too slow')).rejects.toThrow('too slow')
  })

  it('projects a text result and marks structured content', () => {
    const blocks = projectResult({ content: [{ type: 'text', text: 'pong' }], structuredContent: { ok: true } })
    expect(blocks[0]).toEqual({ type: 'text', text: 'pong' })
    expect(textAt(blocks, 1)).toContain('"ok": true')
  })

  it('truncates past the byte cap and says so', () => {
    expect(boundedText('a'.repeat(20), 8)).toContain('truncated at 8 bytes')
  })

  it('stringifies a null content item instead of dropping it', () => {
    expect(textAt(projectResult({ content: [null] }), 0)).toBe('null')
  })

  it('passes through when the timeout is not a positive finite number', async () => {
    await expect(withTimeout(Promise.resolve(1), 0)).resolves.toBe(1)
  })

  it('prefixes structured content with a newline so it does not run into the text', () => {
    const blocks = projectResult({ content: [{ type: 'text', text: 'pong' }], structuredContent: { ok: true } })
    expect(textAt(blocks, 1).startsWith('\n')).toBe(true)
  })

  // `appendStructuredContent: false` is for a server whose `content` already says what the model
  // needs. The field was normalized and then ignored, so the setting did nothing at all.
  describe('appendStructuredContent', () => {
    it('drops structured content when the server sent text content too', () => {
      const blocks = projectResult(
        { content: [{ type: 'text', text: 'pong' }], structuredContent: { ok: true } },
        false,
      )
      expect(blocks).toEqual([{ type: 'text', text: 'pong' }])
    })

    it('keeps structured content when there is no content to fall back on', () => {
      const blocks = projectResult({ content: [], structuredContent: { ok: true } }, false)
      expect(textAt(blocks, 0)).toContain('"ok": true')
    })

    it('keeps both by default', () => {
      const blocks = projectResult({ content: [{ type: 'text', text: 'pong' }], structuredContent: { ok: true } })
      expect(blocks.length).toBe(2)
    })
  })

  it('reports the byte cap it hit on a multibyte truncation', () => {
    const out = boundedText('é'.repeat(10), 8)
    expect(out).toContain('truncated at 8 bytes')
  })

  it('extracts top-level and dot-nested fields from object data', () => {
    const data = {
      items: [{ id: 1, title: 'one' }, { id: 2, title: 'two' }],
      total: 2,
      meta: { author: { name: 'Alice' } },
    }
    const res = extractFields(data, ['total', 'meta.author.name', 'items.0.title']) as any
    expect(res).toEqual({
      total: 2,
      'meta.author.name': 'Alice',
      'items.0.title': 'one',
    })
  })

  it('extracts fields from MCP tool result containing JSON text block', () => {
    const mcpResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: 42, extra: 'bloat', list: ['a', 'b'] }),
        },
      ],
    }
    const extracted = extractFields(mcpResult, ['count', 'list.1']) as any
    expect(extracted.extracted).toBe(true)
    const parsed = JSON.parse(extracted.content[0].text)
    expect(parsed).toEqual({ count: 42, 'list.1': 'b' })
  })

  it('spills output to file when exceeding maxOutputChars threshold', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-spill-test-'))
    try {
      const longOutput = 'Hello world! '.repeat(200) // ~2600 chars
      const result = spillOutput(longOutput, {
        home: tempDir,
        maxOutputChars: 500,
        prefixChars: 50,
      })
      expect(result.spilledPath).toBeDefined()
      expect(existsSync(result.spilledPath!)).toBe(true)
      expect(readFileSync(result.spilledPath!, 'utf8')).toBe(longOutput)
      expect(result.text).toContain('[Notice: Tool output exceeded 500 characters')
      expect(result.text).toContain(result.spilledPath!)
      expect(result.text).toContain('Preview (first 50 characters):')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not spill output when length is below maxOutputChars', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-spill-test-'))
    try {
      const shortOutput = 'short text'
      const result = spillOutput(shortOutput, {
        home: tempDir,
        maxOutputChars: 500,
      })
      expect(result.spilledPath).toBeUndefined()
      expect(result.text).toBe(shortOutput)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
