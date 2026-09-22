import type { MessagePart, QueueItem } from '@shared/types'

export type InvokeChipKind = 'calling' | 'replied' | 'failed'

export interface InvokeChip {
  kind: InvokeChipKind
  /** Display handle without a leading @ (i18n templates add it). */
  name: string
}

/**
 * Status chip for a `bot_invoke` tool card.
 *
 * The tool itself finishes as soon as the prompt is queued, so the card's
 * `state` alone cannot tell "still waiting" from "guest answered". Correlate
 * the queue row id in the tool output with the live queue: present → calling
 * (or failed), gone after a successful done → replied.
 */
export function invokeChip(
  part: Extract<MessagePart, { type: 'tool' }>,
  queue: readonly QueueItem[] = []
): InvokeChip {
  const raw = typeof part.input?.bot === 'string' ? part.input.bot : ''
  const name = raw.replace(/^@/, '').trim() || 'bot'

  if (part.state === 'error') return { kind: 'failed', name }
  if (part.state === 'running') return { kind: 'calling', name }

  const id = queueIdFromOutput(part.output)
  const item = id ? queue.find((entry) => entry.id === id) : undefined
  if (item?.state === 'failed') return { kind: 'failed', name }
  if (item) return { kind: 'calling', name }
  return { kind: 'replied', name }
}

function queueIdFromOutput(output: string | undefined): string | undefined {
  if (!output) return undefined
  try {
    const parsed = JSON.parse(output) as { id?: unknown }
    return typeof parsed.id === 'string' && parsed.id ? parsed.id : undefined
  } catch {
    return undefined
  }
}
