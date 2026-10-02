import type { MessagePart, QueueItem } from '@shared/types'

export type InvokeChipKind =
  | 'calling'
  | 'replied'
  | 'failed'
  | 'cancelled'
  | 'enqueued'
  | 'blocked'
  | 'discarded'
  | 'none'

export interface InvokeChip {
  kind: InvokeChipKind
  /** Display handle without a leading @ (i18n templates add it). */
  name: string
}

/** Acceptance is not execution; only a durable receipt proves completion. */
export function invokeChip(
  part: Extract<MessagePart, { type: 'tool' }>,
  queue: readonly QueueItem[] = [],
  queueLoaded = true
): InvokeChip {
  const raw = typeof part.input?.bot === 'string' ? part.input.bot : ''
  const name = raw.replace(/^@/, '').trim() || 'bot'

  if (part.state === 'error') return { kind: 'failed', name }
  if (part.state === 'running') return { kind: 'enqueued', name }

  const id = queueIdFromOutput(part.output)
  // No id to correlate: a transcript written before this field existed, or a
  // result that did not serialize. Claiming "replied" would be inventing an
  // outcome, so say nothing and leave the plain tool state.
  if (!id) return { kind: 'none', name }
  // The queue for this chat has not arrived yet (a reload, or a chat switch
  // mid-flight). Absence here is ignorance, not evidence of an answer.
  if (!queueLoaded) return { kind: 'enqueued', name }
  const item = queue.find((entry) => entry.id === id)
  if (item?.state === 'failed') return { kind: 'failed', name }
  if (item?.state === 'cancelled') return { kind: 'cancelled', name }
  if (item?.state === 'running') return { kind: 'calling', name }
  if (item)
    return {
      kind: queue.some((entry) => entry.state === 'failed' || entry.state === 'cancelled')
        ? 'blocked'
        : 'enqueued',
      name
    }
  try {
    const receipt = JSON.parse(part.output!) as { delivery?: string }
    const kinds: Record<string, InvokeChipKind> = {
      completed: 'replied',
      running: 'calling',
      failed: 'failed',
      cancelled: 'cancelled',
      discarded: 'discarded',
      waiting_behind_failure: 'blocked'
    }
    return { kind: kinds[receipt.delivery ?? ''] ?? 'enqueued', name }
  } catch {
    return { kind: 'none', name }
  }
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
