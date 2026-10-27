import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, LoaderCircle, Mic, MousePointer2, Plus, RefreshCw, X } from 'lucide-react'
import {
  NARRETE_NOTE_LIMIT,
  type NarreteOverlayApi,
  type NarreteSelection,
  type NarreteSurface
} from '@shared/narrete'
import { applyLanguage } from '../i18n'
import { useVoiceComposer } from '../lib/voice'
import { cn } from '../lib/cn'

declare global {
  interface Window {
    narrete: NarreteOverlayApi
  }
}

export function NarreteOverlay(): JSX.Element {
  const { t } = useTranslation()
  const [surface, setSurface] = useState<NarreteSurface | null>(null)
  const [selection, setSelection] = useState<NarreteSelection | null>(null)
  const [drag, setDrag] = useState<NarreteSelection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'captureFailed' | 'sendFailed' | null>(null)
  const [note, setNote] = useState('')
  const noteRef = useRef('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const pending = useRef(false)
  const [position, setPosition] = useState({ left: 16, top: 16 })
  const voice = useVoiceComposer(surface?.chatId ?? '', textarea, {
    standalone: true,
    maxLength: NARRETE_NOTE_LIMIT,
    read: () => noteRef.current,
    write: (value) => {
      noteRef.current = value
      setNote(noteRef.current)
    }
  })
  const latestVoice = useRef(voice)
  latestVoice.current = voice
  useEffect(() => {
    let live = true
    let revision = 0
    const reset = async (next: NarreteSurface): Promise<void> => {
      if (!live) return
      const current = ++revision
      latestVoice.current.interrupt()
      setSurface(next)
      noteRef.current = next.note
      setNote(next.note)
      setSelection(next.selection)
      setDrag(null)
      setError(next.error ?? null)
      await applyLanguage(next.language)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      if (live && revision === current) {
        if (next.selection) textarea.current?.focus()
        await window.narrete.ready()
      }
    }
    const off = window.narrete.onReset((next) => {
      void reset(next).catch(() => {
        if (live) setError('captureFailed')
      })
    })
    const offDrag = window.narrete.onDrag(setDrag)
    void window.narrete
      .state()
      .then(reset)
      .catch(() => {
        if (live) setError('captureFailed')
      })
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        latestVoice.current.interrupt()
        void window.narrete.cancel()
      }
    }
    window.addEventListener('keydown', escape)
    return () => {
      live = false
      off()
      offDrag()
      window.removeEventListener('keydown', escape)
    }
  }, [])
  useLayoutEffect(() => {
    if (!selection || !panel.current) return
    const place = (): void => {
      const rect = panel.current!.getBoundingClientRect()
      const left = selection.x * innerWidth
      const bottom = (selection.y + selection.height) * innerHeight
      const top = selection.y * innerHeight
      setPosition({
        left: Math.max(12, Math.min(left, innerWidth - rect.width - 12)),
        top: Math.max(
          12,
          Math.min(
            bottom + 12 + rect.height <= innerHeight ? bottom + 12 : top - rect.height - 12,
            innerHeight - rect.height - 12
          )
        )
      })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(panel.current)
    textarea.current?.focus()
    return () => observer.disconnect()
  }, [selection, drag !== null])

  useLayoutEffect(() => {
    if (!surface || !root.current) return
    const controls = [...root.current.querySelectorAll<HTMLElement>('[data-narrete-interactive]')]
    const report = (): void => {
      const rectangles = controls.map((control) => {
        const r = control.getBoundingClientRect()
        return {
          x: Math.max(0, r.left),
          y: Math.max(0, r.top),
          width: Math.min(r.width, innerWidth - Math.max(0, r.left)),
          height: Math.min(r.height, innerHeight - Math.max(0, r.top))
        }
      })
      void window.narrete.layout(surface.revision, rectangles)
    }
    report()
    const observer = new ResizeObserver(report)
    controls.forEach((control) => observer.observe(control))
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [surface, selection, drag, position, error, busy])
  const refresh = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      if (voice.phase === 'starting' || !(await voice.finish())) return
      const result = await window.narrete.refresh(noteRef.current)
      if (!result.ok) setError('captureFailed')
    } catch {
      setError('captureFailed')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const complete = async (): Promise<void> => {
    if (
      pending.current ||
      (!selection && (!surface?.regions.length || !!noteRef.current.trim())) ||
      voice.phase === 'starting'
    )
      return
    pending.current = true
    setBusy(true)
    setError(null)
    const caret = textarea.current?.selectionStart ?? noteRef.current.length
    try {
      if (!(await voice.finish())) return
      if (selection && !noteRef.current.trim()) {
        textarea.current?.focus()
        return
      }
      const result = selection
        ? await window.narrete.refresh(noteRef.current, selection)
        : await window.narrete.submit(null, '')
      if (!result.ok) setError(selection ? 'captureFailed' : 'sendFailed')
    } catch {
      setError(selection ? 'captureFailed' : 'sendFailed')
    } finally {
      pending.current = false
      setBusy(false)
      requestAnimationFrame(() => {
        textarea.current?.focus()
        textarea.current?.setSelectionRange(caret, caret)
      })
    }
  }
  const regions = surface?.regions ?? []
  const sequence = regions.length > 0 && (
    <div data-narrete-sequence className="flex min-w-0 items-center gap-2">
      <div className="flex min-w-0 gap-1 overflow-x-auto">
        {regions.map((region, index) => (
          <div
            key={index}
            title={t('narrete.savedRegion', { number: index + 1, note: region.note })}
            className="relative h-8 w-10 shrink-0 overflow-hidden rounded border border-white/15 bg-white/5"
          >
            <img src={region.dataUrl} alt="" className="h-full w-full object-contain" />
            <span className="absolute bottom-0 left-0 rounded-tr bg-black/80 px-1 text-[9px] leading-3 text-white">
              {index + 1}
            </span>
          </div>
        ))}
      </div>
      <span role="status" className="shrink-0 whitespace-nowrap text-[11px] text-white/55">
        {t('narrete.savedCount', { count: regions.length })}
      </span>
    </div>
  )
  const button =
    'press-scale flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/65 hover:bg-white/10 hover:text-white disabled:opacity-40'

  return (
    <div
      data-narrete-overlay
      ref={root}
      className="pointer-events-none fixed inset-0 select-none overflow-hidden bg-transparent font-sans text-white"
    >
      {drag && (
        <div
          data-narrete-region
          className="pointer-events-none absolute border-2 border-white"
          style={{
            left: `${drag.x * 100}%`,
            top: `${drag.y * 100}%`,
            width: `${drag.width * 100}%`,
            height: `${drag.height * 100}%`
          }}
        />
      )}
      {!selection && !drag && (
        <div
          data-narrete-interactive
          className="pointer-events-auto absolute left-1/2 top-6 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-3 rounded-xl border border-white/15 bg-[#171717] py-2 pl-4 pr-2 shadow-xl"
        >
          <MousePointer2 aria-hidden className="h-4 w-4 shrink-0 text-blue-400" />
          <p role={error ? 'alert' : undefined} className="text-xs">
            {error
              ? error === 'sendFailed'
                ? t('narrete.errors.draftFailed')
                : t('narrete.errors.captureFailed')
              : note.trim()
                ? t('narrete.ctrlReselectHint')
                : t('narrete.ctrlHint')}
          </p>
          <button
            type="button"
            className={button}
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={() => void window.narrete.cancel()}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {!selection && !drag && regions.length > 0 && (
        <div
          data-narrete-saved-bar
          data-narrete-interactive
          className="pointer-events-auto absolute bottom-6 left-1/2 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-3 rounded-xl border border-white/15 bg-[#171717] p-3 shadow-xl"
        >
          {sequence}
          <button
            type="button"
            aria-label={t('narrete.addToPrompt')}
            disabled={busy || !!note.trim()}
            onClick={() => void complete()}
            className="press-scale flex h-8 shrink-0 items-center gap-2 rounded-lg bg-white px-3 text-xs font-medium text-black hover:bg-white/90 disabled:opacity-40"
          >
            {busy ? (
              <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUp aria-hidden className="h-3.5 w-3.5" />
            )}
            {t('narrete.addToPrompt')}
          </button>
        </div>
      )}
      {selection && !drag && (
        <div
          ref={panel}
          data-narrete-interactive
          role="dialog"
          aria-labelledby="narrete-note-label"
          className="pointer-events-auto absolute w-[380px] max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] overflow-y-auto rounded-2xl border border-white/15 bg-[#171717] p-3 shadow-2xl"
          style={position}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return
            const controls = panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), textarea:not(:disabled)'
            )
            if (!controls?.length) return
            const first = controls[0]
            const last = controls[controls.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
          }}
        >
          {surface?.previewDataUrl && (
            <div className="mb-3 h-[min(200px,30dvh)] overflow-hidden rounded-lg border border-white/10 bg-black/25">
              <img
                data-narrete-preview
                src={surface.previewDataUrl}
                alt={t('narrete.preview', { number: regions.length + 1 })}
                draggable={false}
                className="h-full w-full object-contain"
              />
            </div>
          )}
          <div className="mb-1 flex items-center justify-between gap-2 pl-1">
            <label
              id="narrete-note-label"
              htmlFor="narrete-note"
              className="text-xs font-medium text-white/80"
            >
              {t('narrete.regionNote', { number: regions.length + 1 })}
            </label>
            <button
              type="button"
              className={button}
              aria-label={t('common.close')}
              onClick={() => {
                voice.interrupt()
                void window.narrete.cancel()
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <textarea
            ref={textarea}
            id="narrete-note"
            value={note}
            rows={3}
            maxLength={NARRETE_NOTE_LIMIT}
            disabled={busy}
            placeholder={t('narrete.notePlaceholder')}
            className="block max-h-40 min-h-20 w-full resize-none select-text rounded-lg bg-transparent px-1 py-1 text-sm leading-relaxed text-white outline-none focus-visible:ring-1 focus-visible:ring-white/20 placeholder:text-white/35"
            onChange={(event) => {
              voice.interrupt()
              noteRef.current = event.target.value
              setNote(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void complete()
              }
            }}
          />
          {(error || voice.error || voice.slowPhase || voice.fallback) && (
            <p
              role={error || voice.error ? 'alert' : 'status'}
              className="px-1 pb-2 text-xs text-white/60"
            >
              {error
                ? error === 'sendFailed'
                  ? t('narrete.errors.draftFailed')
                  : t('narrete.errors.captureFailed')
                : voice.error
                  ? t(`voice.errors.${voice.error}`)
                  : voice.slowPhase
                    ? t(`voice.phase.${voice.slowPhase}`)
                    : t('voice.fallback')}
            </p>
          )}
          {sequence && <div className="mb-2 overflow-x-auto px-1">{sequence}</div>}
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              aria-label={t('narrete.reselect')}
              disabled={busy}
              onClick={() => void refresh()}
              className="press-scale flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-white/55 hover:bg-white/5 hover:text-white disabled:opacity-40"
            >
              <RefreshCw aria-hidden className="h-3 w-3" />
              {t('narrete.reselect')}
            </button>
            <div className="flex items-center gap-1.5">
              {voice.enabled && (
                <button
                  type="button"
                  aria-label={t(voice.phase === 'idle' ? 'voice.start' : 'voice.stop')}
                  aria-pressed={voice.phase !== 'idle'}
                  disabled={busy || voice.phase === 'stopping'}
                  onClick={voice.toggle}
                  className={cn(button, voice.phase !== 'idle' && 'bg-red-400/15 text-red-400')}
                >
                  {voice.phase === 'starting' || voice.phase === 'stopping' ? (
                    <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />
                  ) : (
                    <Mic aria-hidden className="h-4 w-4" />
                  )}
                </button>
              )}
              <button
                type="button"
                aria-label={t('narrete.addNext')}
                disabled={
                  busy || voice.phase === 'starting' || (!note.trim() && voice.phase === 'idle')
                }
                onClick={() => void complete()}
                className="press-scale flex h-8 items-center gap-2 rounded-lg bg-white px-3 text-xs font-medium text-black hover:bg-white/90 disabled:opacity-40"
              >
                {busy ? (
                  <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus aria-hidden className="h-3.5 w-3.5" />
                )}
                {t('narrete.addNext')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
