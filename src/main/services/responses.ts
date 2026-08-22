/**
 * OpenAI **Responses API** translation.
 *
 * Some models are served ONLY on `/responses` and reject `/chat/completions`
 * with a 400 `unsupported_api_for_model` - notably the GPT-5.x family on GitHub
 * Copilot (`gpt-5.6-sol` and friends). Claude on Copilot is unaffected: it is a
 * chat-completions model and keeps the existing path.
 *
 * Rather than pattern-matching model names (the `gpt-5.6-sol` naming already
 * broke the `gpt-5` prefix assumption, and the next model will break whatever we
 * write), detection is DYNAMIC: the caller tries chat, and on that specific 400
 * records the model here and retries on `/responses`. The result is cached per
 * provider+model, so the fallback costs one wasted round-trip per model per
 * process and nothing thereafter.
 *
 * This module owns the wire differences, which are not just a URL swap:
 * `messages` -> `input`, flattened tool schemas, `reasoning_effort` -> nested
 * `reasoning.effort`, and a semantic-event SSE stream instead of delta chunks.
 */
import type { OpenAiContentPart } from './llm'
import type { ReasoningEffort } from '../../shared/types'

/** The API-code Copilot/OpenAI return when a model is Responses-only. */
const UNSUPPORTED_API = 'unsupported_api_for_model'

/**
 * True when a failed response says the model cannot be served on
 * `/chat/completions`. Deliberately narrow: only this exact code triggers the
 * fallback, so an unrelated 400 (bad request body, content filter) still
 * surfaces to the user instead of being retried on the wrong endpoint.
 */
export function isChatUnsupported(status: number, body: string): boolean {
  return status === 400 && body.includes(UNSUPPORTED_API)
}

/** provider+model pairs known to require `/responses`. Process-lifetime cache. */
const responsesOnly = new Set<string>()

const key = (providerId: string, model: string): string => `${providerId}:${model}`

export function markResponsesOnly(providerId: string, model: string): void {
  responsesOnly.add(key(providerId, model))
}

export function isResponsesOnly(providerId: string, model: string): boolean {
  return responsesOnly.has(key(providerId, model))
}

// ---- Request translation -----------------------------------------------------

/** The OpenAI-chat message shape both callers already build. */
export interface ChatLikeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAiContentPart[] | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** A chat-style tool schema: `{ type: 'function', function: {...} }`. */
export interface ChatToolSchema {
  type: 'function'
  function: Record<string, unknown>
}

/** Flatten one content value to plain text (assistant items take no parts). */
function flattenText(content: string | OpenAiContentPart[] | null): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** Responses input content: `input_text` / `input_image` parts (image_url is a bare string). */
function inputContent(content: string | OpenAiContentPart[] | null): unknown {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'input_text', text: p.text }
      : { type: 'input_image', image_url: p.image_url.url }
  )
}

/**
 * Convert chat `messages` into Responses `input` items.
 *
 * Tool calls and their results are separate top-level items here rather than
 * fields on an assistant message, so an assistant turn that both spoke and
 * called tools expands into several items.
 */
export function toResponsesInput(messages: ChatLikeMessage[]): unknown[] {
  const input: unknown[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: flattenText(m.content)
      })
      continue
    }
    if (m.role === 'assistant') {
      const text = flattenText(m.content)
      if (text) input.push({ role: 'assistant', content: text })
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments
        })
      }
      continue
    }
    input.push({ role: m.role, content: inputContent(m.content) })
  }
  return input
}

/** Flatten chat tool schemas into the shape Responses expects (no `function` wrapper). */
export function toResponsesTools(tools: ChatToolSchema[]): unknown[] {
  return tools.map((t) => ({ type: 'function', ...t.function }))
}

/** Responses nests effort under `reasoning` instead of a flat `reasoning_effort`. */
export function toResponsesReasoning(
  reasoning?: boolean,
  effort?: ReasoningEffort
): { reasoning?: { effort: ReasoningEffort } } {
  if (!reasoning || !effort) return {}
  return { reasoning: { effort } }
}

// ---- Stream translation ------------------------------------------------------

/** A Responses SSE event (only the fields we consume). */
export interface ResponsesEvent {
  type?: string
  delta?: string
  output_index?: number
  item?: { type?: string; call_id?: string; name?: string; arguments?: string }
  response?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
      output_tokens_details?: { reasoning_tokens?: number }
    }
  }
  message?: string
}

export interface ResponsesUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  estimated: false
}

export interface ResponsesHandlers {
  onText: (delta: string) => void
  onReasoning?: (delta: string) => void
  /** Called as tool-call items arrive; `index` is the item's output_index. */
  onToolCall?: (index: number, patch: { id?: string; name?: string; args?: string }) => void
  onUsage?: (usage: ResponsesUsage) => void
}

/**
 * Apply one Responses event to the handlers. Returns true on a terminal event so
 * the reader can stop (the stream has no `[DONE]` sentinel of its own).
 */
export function applyResponsesEvent(ev: ResponsesEvent, h: ResponsesHandlers): boolean {
  switch (ev.type) {
    case 'response.output_text.delta':
      if (ev.delta) h.onText(ev.delta)
      return false
    // Reasoning arrives as summary text on current models and as raw reasoning
    // text on others; both are surfaced the same way.
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      if (ev.delta) h.onReasoning?.(ev.delta)
      return false
    case 'response.output_item.added':
      if (ev.item?.type === 'function_call') {
        h.onToolCall?.(ev.output_index ?? 0, {
          id: ev.item.call_id,
          name: ev.item.name,
          args: ev.item.arguments
        })
      }
      return false
    case 'response.function_call_arguments.delta':
      if (ev.delta) h.onToolCall?.(ev.output_index ?? 0, { args: ev.delta })
      return false
    case 'response.completed': {
      const u = ev.response?.usage
      if (u) {
        const cached = u.input_tokens_details?.cached_tokens ?? 0
        h.onUsage?.({
          // `input_tokens` INCLUDES cached tokens, so subtract them out to match
          // how the chat path reports fresh vs. cached input.
          input: Math.max(0, (u.input_tokens ?? 0) - cached),
          output: u.output_tokens ?? 0,
          cacheRead: cached,
          cacheWrite: 0,
          reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
          estimated: false
        })
      }
      return true
    }
    case 'response.failed':
    case 'response.incomplete':
    case 'error':
      return true
    default:
      return false
  }
}
