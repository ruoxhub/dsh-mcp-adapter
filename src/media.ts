// MCP image results, admitted through the host's attachment store.
//
// An MCP tool that returns a screenshot sends `{ type: 'image', data, mimeType }` — base64 bytes in
// the JSON-RPC result. Reducing that to a text placeholder (what this adapter used to do) makes every
// screenshot, chart and diagram an MCP server can produce useless: the model reads "[image … bytes
// omitted]" and the bytes are gone. The host already owns durable image storage and the decision of
// whether the *current model route* accepts images, and its own MCP client (`dsh-mcp-client`) already
// projects images this way. This module does the same for the adapter (ADR-0011):
//
//   decode → ask the model route whether it takes images → `ctx.attachments.saveImages()` → image block
//
// Both services are read structurally (`ctx.get(name, false)`) because neither is a hard dependency of
// this package: a composition without an attachment store must keep working, and it does — every
// refusal falls back to a text block that names the reason, which is what the host does too.

/** The one image block this adapter emits; `attachment` is the host's durable reference, untyped here. */
export interface ImageBlock {
  type: 'image'
  attachment: unknown
}

/** A base64 MCP image part, as the wire sends it. */
interface ImagePart {
  type: 'image'
  data: string
  mimeType?: string
}

/** The `ctx.attachments` surface this module needs. */
export interface AttachmentStoreLike {
  saveImages: (inputs: ReadonlyArray<{ data: Uint8Array; mediaType: string; name?: string }>) => Promise<readonly unknown[]>
}

/** The `ctx.llm` surface used to answer "does the current route take images?". */
export interface ModelInfoLike {
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<{ inputModalities?: readonly string[] }>
}

/** Where the image decision comes from: the host services and the call whose route decides. */
export interface MediaDeps {
  attachments?: unknown
  llm?: unknown
  /** The agent on whose behalf the call runs; its session carries the current model route. */
  agent?: unknown
  signal?: AbortSignal
}

/** One admitted image, keyed by its position in the MCP result's content array. */
export interface ImageAdmission {
  /** Content indexes that became image blocks, in content order. */
  admitted: Map<number, ImageBlock>
  /** Content indexes that stayed text, with the reason the model is told. */
  refused: Map<number, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The `content` array of an MCP `tools/call` result, or an empty list for any other shape. */
export function mcpContent(result: unknown): unknown[] {
  if (!isRecord(result)) return []
  return Array.isArray(result.content) ? result.content : []
}

/** Whether one content part is an image this module is responsible for. */
function imagePartOf(part: unknown): ImagePart | undefined {
  if (!isRecord(part)) return undefined
  if (part.type !== 'image') return undefined
  if (typeof part.data !== 'string' || part.data.length === 0) return undefined
  return {
    type: 'image',
    data: part.data,
    ...(typeof part.mimeType === 'string' ? { mimeType: part.mimeType } : {}),
  }
}

/**
 * Decode one base64 image part to bytes.
 *
 * Base64 is the only encoding MCP defines for image content, so a part that does not decode is a
 * broken server, not a format this adapter should guess at.
 */
function decodeImage(part: ImagePart): Uint8Array {
  const data = Buffer.from(part.data, 'base64')
  if (data.byteLength === 0) throw new Error('the image data was empty after base64 decoding')
  return new Uint8Array(data)
}

/** The current model route, read the way the host's MCP client reads it. */
function routeOf(agent: unknown): { provider?: string; model?: string } {
  if (!isRecord(agent)) return {}
  const session = isRecord(agent.session) ? agent.session : undefined
  const header = session !== undefined && typeof session.requestHeader === 'function'
    ? (session.requestHeader as () => unknown)()
    : undefined
  const config = isRecord(header) && isRecord(header.config) ? header.config : undefined
  const options = isRecord(agent.options) ? agent.options : undefined
  const provider = config?.provider ?? options?.provider
  const model = config?.model ?? options?.model
  return {
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}),
  }
}

/**
 * The attachment store, but only when the current model route definitely accepts images.
 *
 * Sending an image to a model that does not list `image` as an input modality would fail request
 * lowering on that turn and on every later turn that replays the message, so the route decides before
 * anything is stored. A route that cannot be verified is a refusal, never a guess.
 */
async function admittingStore(deps: MediaDeps): Promise<{ store: AttachmentStoreLike } | { reason: string }> {
  const attachments = deps.attachments
  if (!isRecord(attachments) || typeof attachments.saveImages !== 'function') {
    return { reason: 'no attachment store is mounted' }
  }
  const store: AttachmentStoreLike = {
    saveImages: (inputs) => (attachments.saveImages as AttachmentStoreLike['saveImages']).call(attachments, inputs),
  }
  const llm = deps.llm
  if (!isRecord(llm) || typeof llm.resolveModelInfo !== 'function') {
    return { reason: 'the image capability of the current model route could not be verified' }
  }
  const { provider, model } = routeOf(deps.agent)
  if (provider === undefined || model === undefined) {
    return { reason: 'the current model route could not be resolved' }
  }
  try {
    const info = await (llm.resolveModelInfo as ModelInfoLike['resolveModelInfo']).call(llm, provider, model, deps.signal)
    if (!Array.isArray(info.inputModalities) || !info.inputModalities.includes('image')) {
      return { reason: `model "${model}" does not declare image input` }
    }
  } catch {
    return { reason: 'the image capability of the current model route could not be verified' }
  }
  if (deps.signal?.aborted === true) return { reason: 'the tool call was canceled before image storage' }
  return { store }
}

/**
 * Turn one MCP result's image parts into durable image blocks.
 *
 * @param result - the tool's canonical value; only its MCP `content` array is read.
 * @param deps - the host services and the call whose route decides admission.
 * @returns the per-index outcome, or `undefined` when the result carries no image at all — the
 *   caller then keeps its own projection untouched instead of paying for a second one.
 */
export async function admitResultImages(result: unknown, deps: MediaDeps): Promise<ImageAdmission | undefined> {
  const content = mcpContent(result)
  const parts: Array<{ index: number; part: ImagePart }> = []
  const refused = new Map<number, string>()
  for (const [index, value] of content.entries()) {
    const part = imagePartOf(value)
    if (part !== undefined) parts.push({ index, part })
  }
  if (parts.length === 0) return undefined

  // Decode everything before storing anything: a batch with one broken member must not leave half a
  // result as image blocks and half as diagnostics for images that were never the server's fault.
  const decoded: Array<{ index: number; part: ImagePart; data: Uint8Array }> = []
  for (const { index, part } of parts) {
    try {
      decoded.push({ index, part, data: decodeImage(part) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      refused.set(index, message)
    }
  }
  if (decoded.length === 0) return { admitted: new Map(), refused }

  const store = await admittingStore(deps)
  if ('reason' in store) {
    for (const { index } of decoded) refused.set(index, store.reason)
    return { admitted: new Map(), refused }
  }
  try {
    const refs = await store.store.saveImages(decoded.map(({ part, data }) => ({
      data,
      mediaType: part.mimeType ?? 'image/png',
    })))
    if (refs.length !== decoded.length) throw new Error('the attachment store returned a different number of references')
    const admitted = new Map<number, ImageBlock>()
    for (const [offset, { index }] of decoded.entries()) {
      admitted.set(index, { type: 'image', attachment: refs[offset] })
    }
    return { admitted, refused }
  } catch (error) {
    const reason = error instanceof Error ? `durable image storage rejected the result: ${error.message}` : 'durable image storage rejected the result'
    for (const { index } of decoded) refused.set(index, reason)
    return { admitted: new Map(), refused }
  }
}

/** The text a refused image becomes: its type, why it is missing, and that the bytes still exist. */
export function imageDiagnostic(mimeType: string | undefined, reason: string): string {
  return `[image unavailable: ${mimeType ?? 'unknown media type'}; ${reason}; raw image data remains available to programmatic callers]`
}