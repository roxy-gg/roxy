/**
 * MCP content blocks and results, kept LOSSLESS.
 *
 * Pure logic only (no Node/SDK imports) so every rule here is unit tested in
 * smoke:shared.
 *
 * ## Why this module exists
 *
 * A `tools/call` result is a structured, typed thing: an ordered list of content
 * blocks (text, image, audio, resource links, embedded resources), optional
 * `structuredContent` matching the tool's `outputSchema`, and `_meta` carrying
 * whatever extensions the server speaks. Roxy used to reduce all of that, at the
 * moment it arrived, to `{ ok, output: string, image? }`.
 *
 * That flattening is correct for ONE consumer - the model, which reads text -
 * and destructive for every other one. A resource link became the sentence
 * "[resource: file://x]" with the URI no longer addressable. A second image was
 * dropped entirely. `_meta` never survived at all, which is precisely where MCP
 * Apps puts the identity of the view a result belongs to.
 *
 * So the rule this module enforces is: **parse into a typed model, keep
 * everything, and flatten only at the boundary that actually needs a string.**
 * `toModelText` is that boundary. Nothing else should be lowering a result.
 *
 * ## Bounded, not unlimited
 *
 * "Lossless" cannot mean "hold whatever a server sends". A tool can return a
 * 200MB base64 blob, and MCP connections are warm and long-lived, so anything
 * retained is retained for the life of the session. Every field that can grow
 * without bound is capped HERE, at parse time, and the cap is recorded in the
 * value itself (`truncated`, `omitted`) rather than left implicit - a consumer
 * must be able to tell "empty" from "too big to keep".
 */

import type { ToolResult } from './types'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Caps applied when parsing a result. Deliberately generous for text (a file
 * listing is legitimately large) and strict for binary (base64 in memory is the
 * only thing here that can realistically exhaust a session).
 */
export const MCP_LIMITS = {
  /** Per text-ish block, in chars. */
  textChars: 200_000,
  /** Per inline binary payload (image/audio/blob), in base64 chars (~3MB decoded). */
  binaryChars: 4_000_000,
  /** Blocks kept per result; beyond this we count and drop. */
  blocks: 1_000,
  /** Serialized size cap for `structuredContent` / `_meta`, in chars. */
  jsonChars: 200_000
} as const

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

/** Text a server returned. */
export interface McpTextBlock {
  kind: 'text'
  text: string
  /** True when `text` was cut to `MCP_LIMITS.textChars`. */
  truncated?: boolean
  annotations?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

/** Inline binary (an image or audio clip) as base64, with its media type. */
export interface McpBinaryBlock {
  kind: 'image' | 'audio'
  /** base64 payload, or undefined when it exceeded `MCP_LIMITS.binaryChars`. */
  data?: string
  mimeType: string
  /** True when the payload was dropped for size (so `data` is absent by policy). */
  omitted?: boolean
  annotations?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

/**
 * A pointer to a resource the server hosts (`resource_link`).
 *
 * The URI is the whole point and must stay addressable: this is what a client
 * calls `resources/read` with. Flattening it into prose - as the old renderer
 * did - is exactly the loss this module exists to prevent.
 */
export interface McpResourceLinkBlock {
  kind: 'resource_link'
  uri: string
  name?: string
  title?: string
  description?: string
  mimeType?: string
  annotations?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

/** A resource embedded directly in the result (text or base64 blob). */
export interface McpEmbeddedResourceBlock {
  kind: 'resource'
  uri: string
  mimeType?: string
  /** Inline text contents, when the resource is textual. */
  text?: string
  /** Inline base64 contents, when it is binary. */
  blob?: string
  truncated?: boolean
  omitted?: boolean
  annotations?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

/**
 * A block whose `type` this version of Roxy does not model.
 *
 * Kept rather than discarded, because the spec is actively gaining content
 * types and "we didn't recognise it" is not a reason to make it unrecoverable.
 * The raw JSON is retained (bounded) so a newer consumer can interpret it.
 */
export interface McpUnknownBlock {
  kind: 'unknown'
  /** The server's own `type` discriminator, when it had one. */
  type?: string
  /** The block verbatim, serialized. Absent if it exceeded the JSON cap. */
  raw?: string
}

export type McpContentBlock =
  | McpTextBlock
  | McpBinaryBlock
  | McpResourceLinkBlock
  | McpEmbeddedResourceBlock
  | McpUnknownBlock

/**
 * One `tools/call` result, with nothing thrown away.
 *
 * This is what the service returns and what every non-model consumer should
 * read. `toModelText` derives the string the model sees; it is a projection of
 * this, never a replacement for it.
 */
export interface McpCallResult {
  /** `isError: true` from the server (a tool-level failure, not a transport one). */
  isError: boolean
  /** Content blocks in the order the server sent them. */
  content: McpContentBlock[]
  /** Typed output, when the tool declares an `outputSchema`. */
  structuredContent?: unknown
  /** Result-level extension data (MCP Apps and friends live here). */
  _meta?: Record<string, unknown>
  /** How many blocks were dropped for exceeding `MCP_LIMITS.blocks`. */
  droppedBlocks?: number
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** Copy a `_meta`/`annotations` bag if it is a plain object AND fits the cap. */
function bag(v: unknown): Record<string, unknown> | undefined {
  if (!isRecord(v)) return undefined
  const json = safeJson(v)
  if (!json || json.length > MCP_LIMITS.jsonChars) return undefined
  return v
}

function clampText(v: string): { text: string; truncated?: boolean } {
  if (v.length <= MCP_LIMITS.textChars) return { text: v }
  return { text: v.slice(0, MCP_LIMITS.textChars), truncated: true }
}

/** Parse one content block, preserving everything that fits the caps. */
function parseBlock(raw: unknown): McpContentBlock {
  if (!isRecord(raw)) return { kind: 'unknown', raw: boundedJson(raw) }
  const type = str(raw.type)
  const annotations = bag(raw.annotations)
  const meta = bag(raw._meta)

  if (type === 'text' && typeof raw.text === 'string') {
    const { text, truncated } = clampText(raw.text)
    return { kind: 'text', text, ...(truncated && { truncated }), annotations, _meta: meta }
  }

  if ((type === 'image' || type === 'audio') && typeof raw.data === 'string') {
    const mimeType = str(raw.mimeType) ?? (type === 'image' ? 'image/png' : 'audio/mpeg')
    const tooBig = raw.data.length > MCP_LIMITS.binaryChars
    return {
      kind: type,
      ...(tooBig ? { omitted: true } : { data: raw.data }),
      mimeType,
      annotations,
      _meta: meta
    }
  }

  if (type === 'resource_link' && str(raw.uri)) {
    return {
      kind: 'resource_link',
      uri: str(raw.uri)!,
      name: str(raw.name),
      title: str(raw.title),
      description: str(raw.description),
      mimeType: str(raw.mimeType),
      annotations,
      _meta: meta
    }
  }

  if (type === 'resource' && isRecord(raw.resource)) {
    const r = raw.resource
    const uri = str(r.uri) ?? ''
    const block: McpEmbeddedResourceBlock = {
      kind: 'resource',
      uri,
      mimeType: str(r.mimeType),
      annotations,
      _meta: meta
    }
    if (typeof r.text === 'string') {
      const { text, truncated } = clampText(r.text)
      block.text = text
      if (truncated) block.truncated = true
    } else if (typeof r.blob === 'string') {
      if (r.blob.length > MCP_LIMITS.binaryChars) block.omitted = true
      else block.blob = r.blob
    }
    return block
  }

  // Unrecognised. A `text` field is still worth surfacing to the model, so a
  // block that is merely NEWER than us doesn't read as empty - but it stays
  // typed as unknown, because guessing at its semantics would be worse.
  if (typeof raw.text === 'string') {
    const { text, truncated } = clampText(raw.text)
    return { kind: 'text', text, ...(truncated && { truncated }), annotations, _meta: meta }
  }
  return { kind: 'unknown', type, raw: boundedJson(raw) }
}

/**
 * Parse a raw `tools/call` result into the lossless model.
 *
 * Never throws: a malformed result degrades to an empty-but-valid value, since
 * the caller is an agent turn that must not die because a server misbehaved.
 */
export function parseCallResult(raw: {
  content?: unknown
  isError?: boolean
  structuredContent?: unknown
  _meta?: unknown
}): McpCallResult {
  const list = Array.isArray(raw?.content) ? raw.content : []
  const kept = list.slice(0, MCP_LIMITS.blocks)
  const result: McpCallResult = {
    isError: raw?.isError === true,
    content: kept.map(parseBlock)
  }
  if (list.length > kept.length) result.droppedBlocks = list.length - kept.length
  if (raw?.structuredContent !== undefined && raw.structuredContent !== null) {
    result.structuredContent = raw.structuredContent
  }
  const meta = bag(raw?._meta)
  if (meta) result._meta = meta
  return result
}

// ---------------------------------------------------------------------------
// Projection to the model's view
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** One entry from `resources/list`. */
export interface McpResourceInfo {
  uri: string
  name?: string
  title?: string
  description?: string
  mimeType?: string
}

/**
 * The contents of one resource, as read.
 *
 * Text and binary are separate fields rather than one `data: string`, because a
 * consumer must not have to guess which it got: an MCP App's HTML is text to be
 * rendered, a PNG is bytes to be embedded, and conflating them is how you end up
 * rendering base64 into a document.
 */
export interface McpResourceContents {
  uri: string
  mimeType?: string
  /** Decoded text, when the resource is textual. */
  text?: string
  /** base64 payload, when it is binary. */
  blob?: string
  /** True when `text` was cut to `MCP_LIMITS.textChars`. */
  truncated?: boolean
  /** True when a payload was dropped for exceeding `MCP_LIMITS.binaryChars`. */
  omitted?: boolean
}

/**
 * Parse a `resources/read` response.
 *
 * The wire returns an ARRAY of contents (one URI can expand to several parts).
 * Roxy reads one addressable resource at a time, so the first entry is the
 * answer; flattening that here keeps every call site from re-deciding it.
 *
 * Bounded on the same terms as content blocks - see the note on `MCP_LIMITS`.
 */
export function parseResourceContents(uri: string, contents: unknown): McpResourceContents {
  const first = Array.isArray(contents) ? contents[0] : undefined
  if (!isRecord(first)) return { uri }
  const out: McpResourceContents = {
    uri: str(first.uri) ?? uri,
    mimeType: str(first.mimeType)
  }
  if (typeof first.text === 'string') {
    const { text, truncated } = clampText(first.text)
    out.text = text
    if (truncated) out.truncated = true
  } else if (typeof first.blob === 'string') {
    if (first.blob.length > MCP_LIMITS.binaryChars) out.omitted = true
    else out.blob = first.blob
  }
  return out
}

/**
 * Render a result as the text the MODEL sees.
 *
 * The single place a lossless result is allowed to become a string. Every block
 * contributes something legible: a resource link keeps its URI (so the model can
 * ask for it by name), an omitted payload says so rather than vanishing, and a
 * block we don't understand still reports its type instead of silently emptying.
 */
export function toModelText(result: McpCallResult): string {
  const parts: string[] = []
  for (const b of result.content) {
    switch (b.kind) {
      case 'text':
        parts.push(b.truncated ? `${b.text}\n…[truncated]` : b.text)
        break
      case 'image':
      case 'audio':
        parts.push(b.omitted ? `[${b.kind} omitted: too large]` : `[${b.kind}: ${b.mimeType}]`)
        break
      case 'resource_link':
        // The URI stays verbatim: it is an address the model can act on.
        parts.push(`[resource: ${b.name || b.title || b.uri}](${b.uri})`)
        break
      case 'resource':
        if (b.text) parts.push(b.truncated ? `${b.text}\n…[truncated]` : b.text)
        else if (b.omitted) parts.push(`[resource ${b.uri}: contents too large]`)
        else parts.push(`[resource: ${b.uri}]`)
        break
      case 'unknown':
        parts.push(`[unsupported content${b.type ? `: ${b.type}` : ''}]`)
        break
    }
  }
  if (result.droppedBlocks) {
    parts.push(`…[${result.droppedBlocks} further block(s) omitted]`)
  }

  // Only fall back to the structured half when the blocks said nothing. A server
  // returning both means text for the model and structure for the application;
  // appending the JSON too would pay twice in context for one answer.
  let joined = parts.join('\n').trim()
  if (!joined && result.structuredContent !== undefined) {
    joined = boundedJson(result.structuredContent) ?? ''
  }
  return joined
}

/**
 * Lower a lossless result to the flat `ToolResult` the agent loop and UI use.
 *
 * Keeps the FIRST inline image as the renderable preview, matching how every
 * other Roxy tool reports imagery.
 */
export function toToolResult(result: McpCallResult): ToolResult {
  const text = toModelText(result)
  const output =
    text || (result.isError ? 'The MCP tool reported an error with no message.' : '(no output)')
  const out: ToolResult = { ok: !result.isError, output }
  const img = result.content.find(
    (b): b is McpBinaryBlock => b.kind === 'image' && !!(b as McpBinaryBlock).data
  )
  if (img?.data) out.image = `data:${img.mimeType};base64,${img.data}`
  return out
}

/** JSON for display, bounded, never throwing on a cycle or a BigInt. */
function boundedJson(value: unknown): string | undefined {
  const json = safeJson(value)
  if (!json) return undefined
  return json.length > MCP_LIMITS.jsonChars ? json.slice(0, MCP_LIMITS.jsonChars) : json
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2) ?? undefined
  } catch {
    return undefined
  }
}
