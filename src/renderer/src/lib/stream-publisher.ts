import type { MessagePart } from '@shared/types'

export interface StreamPublisher {
  (parts: MessagePart[] | null): void
  cancel(): void
}

/** Coalesce cumulative snapshots, but don't strand them behind an occluded window's rAF. */
export function createStreamPublisher(
  publish: (parts: MessagePart[] | null) => void
): StreamPublisher {
  let pending: MessagePart[] | null = null
  let frame = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = (): void => {
    if (frame) cancelAnimationFrame(frame)
    if (timer !== undefined) clearTimeout(timer)
    frame = 0
    timer = undefined
    pending = null
  }
  const flush = (): void => {
    const latest = pending
    cancel()
    if (latest) publish(latest)
  }
  const publisher: StreamPublisher = (parts) => {
    if (parts === null) {
      // Completion must win over queued deltas; otherwise a finished bubble can reappear.
      cancel()
      publish(null)
      return
    }
    pending = parts
    if (frame || timer !== undefined) return
    frame = requestAnimationFrame(flush)
    timer = setTimeout(flush, 50)
  }
  publisher.cancel = cancel
  return publisher
}
