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
  return item.state !== 'running' && queueOrigin(item) === 'user'
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
