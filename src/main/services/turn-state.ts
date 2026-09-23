/** Shared ownership across desktop, phone, and scheduled turns. */
const active = new Map<string, AbortController>()
const paused = new Set<string>()

export function sessionBusy(id: string): boolean {
  return active.has(id)
}

export function claimTurn(id: string, controller: AbortController): (() => void) | null {
  if (active.has(id)) return null
  active.set(id, controller)
  return () => {
    if (active.get(id) === controller) active.delete(id)
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
}

export function stopAllTurns(): void {
  for (const controller of active.values()) controller.abort()
}
