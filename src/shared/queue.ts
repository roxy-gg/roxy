import type { QueueItem } from './types'

export type QueueOrigin = 'user' | 'agent' | 'schedule'

/** Who created a queued request. The responder is a separate concern. */
export function queueOrigin(item: QueueItem): QueueOrigin {
  if (item.scheduleId) return 'schedule'
  if (item.fromUser || !item.sourceChatId) return 'user'
  return 'agent'
}

/** The composer queue contains only user prompts that have not started or need retrying. */
export function isVisibleQueueItem(item: QueueItem): boolean {
  return !isClaimedQueueItem(item) && queueOrigin(item) === 'user'
}

export function isClaimedQueueItem(item: Pick<QueueItem, 'state'>): boolean {
  return item.state === 'starting' || item.state === 'running'
}

/** One admission policy for sends, drains and callers checking a blocked queue. */
export function nextQueueItem(
  items: readonly QueueItem[],
  now = Date.now()
): QueueItem | undefined {
  if (items.some(isClaimedQueueItem)) return undefined
  let item: QueueItem | undefined = items[0]
  // BOTS.md: hidden failed/delayed automation may not lock out user work.
  // It still blocks later automation, and user failures/delays retain FIFO.
  if (
    item &&
    queueOrigin(item) !== 'user' &&
    (item.state === 'failed' || (item.notBefore ?? 0) > now)
  ) {
    item = items.find((entry) => queueOrigin(entry) === 'user')
  }
  return item && (!item.state || item.state === 'pending') && (item.notBefore ?? 0) <= now
    ? item
    : undefined
}

/**
 * Swap user prompts without changing the slots occupied by running or automated work.
 */
export function moveVisibleQueueItem(
  items: readonly QueueItem[],
  id: string,
  direction: 'up' | 'down'
): QueueItem[] | null {
  const visible = items.filter(isVisibleQueueItem)
  const index = visible.findIndex((item) => item.id === id)
  if (index < 0) return null
  const neighbor = direction === 'up' ? index - 1 : index + 1
  if (neighbor < 0 || neighbor >= visible.length) return null
  ;[visible[index], visible[neighbor]] = [visible[neighbor], visible[index]]
  let visibleIndex = 0
  return items.map((item) => (isVisibleQueueItem(item) ? visible[visibleIndex++] : item))
}
