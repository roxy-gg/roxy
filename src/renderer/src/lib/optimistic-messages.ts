import type { Message, QueueItem } from '@shared/types'

/** Keep pending writes visible across a transcript load, without duplicating confirmed rows. */
export function visibleMessages(stored: Message[], pending: Message[] | undefined): Message[] {
  if (!pending?.length) return stored
  const known = new Set(stored.map((message) => message.id))
  return [...stored, ...pending.filter((message) => !known.has(message.id))].sort(
    (a, b) => a.createdAt - b.createdAt
  )
}

/** Only a load containing the canonical ID can retire an acknowledged overlay. */
export function remainingOptimisticMessages(stored: Message[], pending: Message[]): Message[] {
  const known = new Set(stored.map((message) => message.id))
  return pending.filter((message) => !known.has(message.id))
}

export function visibleQueue(stored: QueueItem[], pending: QueueItem[] | undefined): QueueItem[] {
  if (!pending?.length) return stored
  const known = new Set(stored.map((item) => item.id))
  return [...stored, ...pending.filter((item) => !known.has(item.id))]
}
