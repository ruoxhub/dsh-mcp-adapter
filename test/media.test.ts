import { describe, expect, it } from 'vitest'
import { admitResultImages, imageDiagnostic, mcpContent } from '../src/media.ts'
import type { MediaDeps } from '../src/media.ts'

/** A one-pixel PNG, base64 — the smallest real image an MCP server can return. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A fake attachment store that records what it was asked to store. */
function store(options: { fail?: string } = {}) {
  const saved: Array<{ data: Uint8Array; mediaType: string }> = []
  return {
    saved,
    saveImages: async (inputs: ReadonlyArray<{ data: Uint8Array; mediaType: string }>) => {
      if (options.fail !== undefined) throw new Error(options.fail)
      saved.push(...inputs)
      return inputs.map((_input, index) => ({ attachmentId: `att-${index}`, mediaType: _input.mediaType, bytes: _input.data.byteLength }))
    },
  }
}

/** A model registry whose route declares the modalities the test asks for. */
function llm(modalities: string[] | undefined, options: { fail?: boolean } = {}) {
  const calls: Array<{ provider: string; model: string }> = []
  return {
    calls,
    resolveModelInfo: async (provider: string, model: string) => {
      calls.push({ provider, model })
      if (options.fail === true) throw new Error('registry unavailable')
      return modalities === undefined ? {} : { inputModalities: modalities }
    },
  }
}

/** An agent whose session reports the given route. */
function agent(provider = 'deepseek', model = 'deepseek-chat') {
  return {
    options: { provider, model },
    session: {
      requestHeader: () => ({ config: { provider, model } }),
    },
  }
}

function deps(overrides: Partial<MediaDeps> = {}): MediaDeps {
  return {
    attachments: store(),
    llm: llm(['text', 'image']),
    agent: agent(),
    ...overrides,
  }
}

describe('admitResultImages', () => {
  it('returns undefined for a result with no image, so the caller keeps its own projection', async () => {
    expect(await admitResultImages({ content: [{ type: 'text', text: 'pong' }] }, deps())).toBeUndefined()
    expect(await admitResultImages({}, deps())).toBeUndefined()
    expect(await admitResultImages(null, deps())).toBeUndefined()
  })

  it('stores an image and returns an image block at its content index', async () => {
    const attachments = store()
    const admission = await admitResultImages(
      { content: [{ type: 'text', text: 'shot' }, { type: 'image', data: PNG, mimeType: 'image/png' }] },
      deps({ attachments }),
    )
    expect(admissions(admission)).toEqual([1])
    expect(admission?.refused.size).toBe(0)
    expect(attachments.saved).toHaveLength(1)
    expect(attachments.saved[0].mediaType).toBe('image/png')
    expect(attachments.saved[0].data.byteLength).toBeGreaterThan(0)
  })

  it('defaults the media type when the server omits it', async () => {
    const attachments = store()
    await admitResultImages({ content: [{ type: 'image', data: PNG }] }, deps({ attachments }))
    expect(attachments.saved[0].mediaType).toBe('image/png')
  })

  // Sending an image to a model that does not accept one fails request lowering on that turn and on
  // every later turn replaying the message, so the route decides before anything is stored.
  it('refuses the image when the current route does not declare image input', async () => {
    const attachments = store()
    const admission = await admitResultImages(
      { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] },
      deps({ attachments, llm: llm(['text']) }),
    )
    expect(admission === undefined ? undefined : [...admission.admitted.keys()]).toEqual([])
    expect(admission?.refused.get(0)).toMatch(/does not declare image input/)
    // Nothing was stored: a refusal must not leave an unreachable attachment behind.
    expect(attachments.saved).toHaveLength(0)
  })

  it('refuses when the route cannot be verified rather than guessing', async () => {
    const admission = await admitResultImages(
      { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] },
      deps({ llm: llm(['image'], { fail: true }) }),
    )
    expect(admission?.refused.get(0)).toMatch(/could not be verified/)
  })

  it('refuses when the model registry is absent entirely', async () => {
    const admission = await admitResultImages(
      { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] },
      { attachments: store(), agent: agent() },
    )
    expect(admission?.refused.get(0)).toMatch(/could not be verified/)
  })

  it('refuses when no attachment store is mounted, without failing the call', async () => {
    const admission = await admitResultImages(
      { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] },
      deps({ attachments: undefined }),
    )
    expect(admission?.refused.get(0)).toMatch(/no attachment store is mounted/)
  })

  it('refuses when the route names no provider or model', async () => {
    const admission = await admitResultImages(
      { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] },
      deps({ agent: { options: {}, session: { requestHeader: () => ({}) } } }),
    )
    expect(admission?.refused.get(0)).toMatch(/could not be resolved/)
  })

  it('turns a storage failure into a refusal instead of failing the tool call', async () => {
    const admission = await admitResultImages(
      { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] },
      deps({ attachments: store({ fail: 'disk full' }) }),
    )
    expect(admission?.refused.get(0)).toMatch(/disk full/)
    expect(admission === undefined ? undefined : [...admission.admitted.keys()]).toEqual([])
  })

  // A batch with one broken member must not leave half the result as images: the server sent one
  // invalid part, and the model should see one diagnostic naming that part.
  it('refuses only the undecodable member of a batch and admits the rest', async () => {
    const attachments = store()
    const admission = await admitResultImages(
      { content: [{ type: 'image', data: '', mimeType: 'image/png' }, { type: 'image', data: PNG, mimeType: 'image/png' }] },
      deps({ attachments }),
    )
    // An empty `data` is not an image part at all, so it is left to the caller's own projection.
    expect(admissions(admission)).toEqual([1])
    expect(attachments.saved).toHaveLength(1)
  })

  it('does not touch a result whose content is not an array', async () => {
    expect(await admitResultImages({ content: 'nope' }, deps())).toBeUndefined()
    expect(mcpContent({ content: 'nope' })).toEqual([])
  })
})

/** The admitted content indexes of an admission, sorted, or an empty list when nothing was admitted. */
function admissions(admission: { admitted: ReadonlyMap<number, unknown> } | undefined): number[] {
  return admission === undefined ? [] : [...admission.admitted.keys()].sort((left, right) => left - right)
}

describe('imageDiagnostic', () => {
  it('names the media type, the reason, and that the bytes still exist', () => {
    expect(imageDiagnostic('image/png', 'no store')).toBe(
      '[image unavailable: image/png; no store; raw image data remains available to programmatic callers]',
    )
  })

  it('names an unknown media type rather than printing undefined', () => {
    expect(imageDiagnostic(undefined, 'no store')).toContain('unknown media type')
  })
})
