/** Shared ownership across desktop, phone, and scheduled turns. */
const active = new Map<string, AbortController>()
const paused = new Set<string>()
const listeners = new Set<() => void>()

/** Consumers defer draining until the releasing turn has finished cleanup. */
export function onTurnAvailable(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyTurnAvailable(): void {
  for (const listener of listeners) listener()
}

export function sessionBusy(id: string): boolean {
  return active.has(id)
}

export function claimTurn(id: string, controller: AbortController): (() => void) | null {
  if (active.has(id)) return null
  active.set(id, controller)
  return () => {
    if (active.get(id) === controller) {
      active.delete(id)
      notifyTurnAvailable()
    }
  }
}

export function stopTurn(id: string): void {
  paused.add(id)
  active.get(id)?.abort()
}

export function queuePaused(id: string): boolean {
  return paused.has(id)
}
export function resumeQueue(id: string): void {
  paused.delete(id)
  notifyTurnAvailable()
}

export function stopAllTurns(): void {
  for (const controller of active.values()) controller.abort()
}
