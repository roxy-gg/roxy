import { useSyncExternalStore } from 'react'
import {
  DEFAULT_MOTION,
  normalizeMotion,
  reduceMotion,
  type MotionPreference
} from '@shared/motion'

const CACHE_KEY = 'roxy.motion.v1'
const system = window.matchMedia('(prefers-reduced-motion: reduce)')
const listeners = new Set<() => void>()
let snapshot = { preference: DEFAULT_MOTION, reduced: false }
let revision = 0

function update(preference = snapshot.preference): void {
  const reduced = reduceMotion(preference, system.matches)
  document.documentElement.dataset.motion = reduced ? 'reduced' : 'full'
  if (snapshot.preference === preference && snapshot.reduced === reduced) return
  snapshot = { preference, reduced }
  for (const notify of listeners) notify()
}

export function applyMotion(value: unknown): void {
  const preference = normalizeMotion(value)
  revision++
  update(preference)
  try {
    localStorage.setItem(CACHE_KEY, preference)
  } catch {
    /* Storage is only a first-paint cache. */
  }
}

export function motionSnapshot(): typeof snapshot {
  return snapshot
}

export function prefersReducedMotion(): boolean {
  return snapshot.reduced
}

export function subscribeMotion(notify: () => void): () => void {
  listeners.add(notify)
  return () => {
    listeners.delete(notify)
  }
}

export function useMotion(): typeof snapshot {
  return useSyncExternalStore(subscribeMotion, motionSnapshot, motionSnapshot)
}

/** Prime before the first paint; SQLite remains authoritative, just like the theme cache. */
export function startMotion(): () => void {
  let cached: string | null = null
  try {
    cached = localStorage.getItem(CACHE_KEY)
  } catch {
    /* Use the default. */
  }
  applyMotion(cached)
  const onSystemChange = (): void => update()
  system.addEventListener('change', onSystemChange)
  const settings = window.roxy?.settings
  let disposed = false
  const atStart = revision
  // A Vite reload can briefly pair this renderer with the previous preload.
  const off = settings?.onMotionChanged?.(applyMotion)
  void settings
    ?.getAll()
    .then((settings) => {
      if (!disposed && revision === atStart) applyMotion(settings.motion)
    })
    .catch(() => {})
  return () => {
    disposed = true
    off?.()
    system.removeEventListener('change', onSystemChange)
  }
}

export type { MotionPreference }
