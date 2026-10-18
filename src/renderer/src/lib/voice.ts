import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useLocation } from 'react-router-dom'
import { mergeVoiceDraft, type VoiceError, type VoiceState } from '@shared/voice'
import { api } from './api'
import { useRoxyStore } from './store'
import { updateComposerDraft } from './composerDrafts'

export function useVoiceState(): VoiceState | null {
  const [state, setState] = useState<VoiceState | null>(null)
  useEffect(() => {
    if (!api.voice) return
    let live = true
    let revision = 0
    const refresh = (): void => {
      const current = revision
      void api.voice
        .state()
        .then((next) => {
          if (live && current === revision) setState(next)
        })
        .catch(() => undefined)
    }
    const off = api.voice.onEvent((event) => {
      if (event.type === 'state') {
        revision++
        setState(event.state)
      }
    })
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      live = false
      off()
      window.removeEventListener('focus', refresh)
    }
  }, [])
  return state
}

export function useVoiceComposer(
  chatId: string,
  textarea: RefObject<HTMLTextAreaElement>
): {
  enabled: boolean
  phase: 'idle' | 'starting' | 'recording' | 'stopping'
  slowPhase: 'starting' | 'stopping' | null
  error: VoiceError | null
  fallback: boolean
  toggle: () => void
  interrupt: () => void
} {
  const state = useVoiceState()
  const { pathname } = useLocation()
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'stopping'>('idle')
  const [slowPhase, setSlowPhase] = useState<'starting' | 'stopping' | null>(null)
  useEffect(() => {
    setSlowPhase(null)
    if (phase !== 'starting' && phase !== 'stopping') return
    const timer = setTimeout(() => setSlowPhase(phase), 2000)
    return () => clearTimeout(timer)
  }, [phase])
  const [error, setError] = useState<VoiceError | null>(null)
  const [fallback, setFallback] = useState(false)
  const owned = useRef<{ id: string; start: number; text: string; sequence: number } | null>(null)
  const latest = useRef<() => void>(() => {})
  const interrupt = (): void => {
    const recording = owned.current
    owned.current = null
    if (!recording) return
    setPhase('idle')
    void api.voice.stop(recording.id, false).catch(() => undefined)
  }
  const toggle = (): void => {
    const recording = owned.current
    if (recording) {
      if (phase === 'starting') {
        interrupt()
        return
      }
      if (phase === 'stopping') return
      setPhase('stopping')
      void api.voice.stop(recording.id, true).catch(() => {
        interrupt()
        setError('engineFailed')
      })
      return
    }
    if (!state?.settings.enabled) return
    if (!state.supported) {
      setError('unsupported')
      return
    }
    if (!state.settings.modelId || !state.installed.includes(state.settings.modelId)) {
      setError('modelRequired')
      return
    }
    const current = useRoxyStore.getState()
    if (
      pathname !== '/' ||
      current.activeChatId !== chatId ||
      !textarea.current?.getClientRects().length ||
      getComputedStyle(textarea.current).visibility === 'hidden'
    )
      return
    const id = crypto.randomUUID()
    const value = current.composerDrafts[chatId]?.value ?? ''
    owned.current = {
      id,
      start: textarea.current.selectionStart ?? value.length,
      text: '',
      sequence: 0
    }
    setError(null)
    setFallback(false)
    setPhase('starting')
    textarea.current.focus()
    void api.voice
      .start(id, chatId)
      .then((result) => {
        if (owned.current?.id !== id) return
        if (!result.ok) {
          interrupt()
          setError(result.error)
        }
      })
      .catch(() => {
        if (owned.current?.id === id) {
          interrupt()
          setError('unknown')
        }
      })
  }
  latest.current = toggle
  useLayoutEffect(() => {
    if (pathname !== '/') interrupt()
  }, [pathname])
  useEffect(() => {
    if (!api.voice) return
    const off = api.voice.onEvent((event) => {
      if (event.type === 'toggle') {
        const element = textarea.current
        if (
          element &&
          getComputedStyle(element).visibility !== 'hidden' &&
          !document.querySelector('[role="dialog"], [aria-modal="true"]')
        )
          latest.current()
        return
      }
      const recording = owned.current
      if (!recording || !('recordingId' in event) || event.recordingId !== recording.id) return
      if (event.type === 'recording') {
        if (event.phase === 'stopped') {
          owned.current = null
          setPhase('idle')
          if (event.error) setError(event.error)
        } else {
          setPhase((current) => (current === 'stopping' ? current : 'recording'))
          setFallback(event.fallback ?? false)
        }
      } else if (event.type === 'transcript' && event.sequence > recording.sequence) {
        recording.sequence = event.sequence
        let conflict = false
        useRoxyStore.setState((store) => ({
          composerDrafts: updateComposerDraft(
            store.composerDrafts,
            store.chats,
            chatId,
            (draft) => {
              const merged = mergeVoiceDraft(draft.value, recording, event.text)
              if (!merged) {
                conflict = true
                return draft
              }
              recording.text = merged.text
              return { ...draft, value: merged.value }
            }
          )
        }))
        if (conflict) interrupt()
      }
    })
    return () => {
      off()
      interrupt()
    }
  }, [chatId])
  useEffect(() => {
    if (state && !state.settings.enabled) interrupt()
  }, [state?.settings.enabled])
  return {
    enabled: state?.settings.enabled ?? false,
    phase,
    slowPhase: slowPhase === phase ? slowPhase : null,
    error,
    fallback,
    toggle,
    interrupt
  }
}
