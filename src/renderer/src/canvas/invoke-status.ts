import type { MessagePart, QueueItem } from '@shared/types'

export type InvokeChipKind = 'calling' | 'replied' | 'failed' | 'none'

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
  queue: readonly QueueItem[] = [],
  queueLoaded = true
): InvokeChip {
  const raw = typeof part.input?.bot === 'string' ? part.input.bot : ''
  const name = raw.replace(/^@/, '').trim() || 'bot'

  if (part.state === 'error') return { kind: 'failed', name }
  if (part.state === 'running') return { kind: 'calling', name }

  const id = queueIdFromOutput(part.output)
  // No id to correlate: a transcript written before this field existed, or a
  // result that did not serialize. Claiming "replied" would be inventing an
  // outcome, so say nothing and leave the plain tool state.
  if (!id) return { kind: 'none', name }
  // The queue for this chat has not arrived yet (a reload, or a chat switch
  // mid-flight). Absence here is ignorance, not evidence of an answer.
  if (!queueLoaded) return { kind: 'calling', name }
  const item = queue.find((entry) => entry.id === id)
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
