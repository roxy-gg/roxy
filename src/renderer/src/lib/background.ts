import { useSyncExternalStore } from 'react'
import { DEFAULT_BACKGROUND, normalizeBackground, type BackgroundState } from '@shared/background'
import { api } from './api'

const listeners = new Set<() => void>()
let snapshot = {
  settings: { ...DEFAULT_BACKGROUND },
  image: null as string | null,
  rendered: null as string | null,
  processing: false,
  failed: false,
  ready: false
}
let worker: Worker | undefined
let objectUrl: string | undefined
let revision = 0

function notify(): void {
  for (const listener of listeners) listener()
}

export function applyBackground(state: BackgroundState): void {
  revision++
  const settings = normalizeBackground(state.settings)
  const regenerate = state.image !== snapshot.image || settings.effect !== snapshot.settings.effect
  snapshot = { ...snapshot, ...state, settings, ready: true }
  if (!regenerate) {
    notify()
    return
  }
  worker?.terminate()
  worker = undefined
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = undefined
  snapshot = { ...snapshot, rendered: state.image, failed: false, processing: false }
  if (state.image && !['none', 'haze'].includes(settings.effect)) {
    snapshot = { ...snapshot, processing: true }
    try {
      const current = new Worker(new URL('./background-effects.worker.ts', import.meta.url), {
        type: 'module'
      })
      worker = current
      const fail = (): void => {
        if (worker !== current) return
        snapshot = { ...snapshot, processing: false, failed: true }
        current.terminate()
        worker = undefined
        notify()
      }
      current.onerror = fail
      current.onmessage = (event: MessageEvent<{ blob?: Blob }>): void => {
        if (worker !== current) return
        if (!event.data.blob) {
          fail()
          return
        }
        objectUrl = URL.createObjectURL(event.data.blob)
        snapshot = { ...snapshot, rendered: objectUrl, processing: false }
        current.terminate()
        worker = undefined
        notify()
      }
      current.postMessage({ image: state.image, effect: settings.effect })
    } catch {
      snapshot = { ...snapshot, processing: false, failed: true }
    }
  }
  notify()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const getSnapshot = (): typeof snapshot => snapshot
export function useBackground(): typeof snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function startBackground(): () => void {
  // Cosmetic preferences must not prevent booting with an older preload.
  if (!api?.background) return () => {}
  let disposed = false
  const atStart = revision
  const off = api.background.onChanged(applyBackground)
  void api.background
    .get()
    .then((state) => {
      if (!disposed && atStart === revision) applyBackground(state)
    })
    .catch(() => {
      if (!disposed && atStart === revision) {
        snapshot = { ...snapshot, ready: true, failed: true }
        notify()
      }
    })
  return () => {
    disposed = true
    off()
    worker?.terminate()
    worker = undefined
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = undefined
  }
}
