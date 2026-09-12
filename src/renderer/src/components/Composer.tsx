import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Mic, Plus, Sparkles, Square, Undo2, X } from 'lucide-react'
import { ModelPicker } from './ModelPicker'
import { ContextMeter, ContextPicker, ThinkingPicker, AgentPicker } from './InferenceControls'
import { imageFilesFrom, readImageFile, type ComposerImage } from '../lib/images'
import { ImagePreview } from './ImagePreview'
import { api } from '../lib/api'
import { startDictationCapture, type DictationCapture } from '../lib/dictation-audio'
import { useRoxyStore } from '../lib/store'
import { resolveSessionConfig } from '@shared/session-config'
import { replaceDictationSuffix, retainedDictationSuffix } from '@shared/dictation-draft'
import type { DictationState } from '@shared/dictation'
import { assistantSpeechText, takeSpeakableSentences } from '../lib/voice-output'

export function Composer({
  onSend,
  sending,
  onStop
}: {
  onSend: (text: string, images?: ComposerImage[]) => void
  sending?: boolean
  onStop?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  const [dragging, setDragging] = useState(false)
  const [dictationState, setDictationState] = useState<DictationState | null>(null)
  const [dictationError, setDictationError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [polishing, setPolishing] = useState(false)
  const [rawTranscript, setRawTranscript] = useState<string | null>(null)
  const [voiceMode, setVoiceMode] = useState(false)
  const [voicePhase, setVoicePhase] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>(
    'idle'
  )
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef(value)
  const captureRef = useRef<DictationCapture | null>(null)
  const requestRef = useRef<string | null>(null)
  const beforeDictationRef = useRef('')
  const partialRef = useRef('')
  const transcriptDetachedRef = useRef(false)
  const startingRef = useRef(false)
  const mountedRef = useRef(true)
  const voiceModeRef = useRef(false)
  const sendingRef = useRef(Boolean(sending))
  const autoSubmitRef = useRef<((text: string) => void) | null>(null)
  const awaitingResponseRef = useRef(false)
  const spokenLengthRef = useRef(0)
  const speechTailRef = useRef('')
  const pendingSpeechRef = useRef(0)
  const settings = useRoxyStore((s) => s.settings)
  const activeChat = useRoxyStore((s) => s.chats.find((c) => c.id === s.activeChatId))
  const providers = useRoxyStore((s) => s.providers)
  const streamingParts = useRoxyStore((s) =>
    s.activeChatId ? (s.streamingChats[s.activeChatId] ?? null) : null
  )
  const streamingText = useMemo(() => assistantSpeechText(streamingParts), [streamingParts])
  const config = useMemo(() => resolveSessionConfig(activeChat, settings), [activeChat, settings])

  useEffect(() => {
    valueRef.current = value
  }, [value])

  useEffect(() => {
    sendingRef.current = Boolean(sending)
  }, [sending])

  useEffect(() => {
    mountedRef.current = true
    void api.dictation.status().then(setDictationState)
    const offState = api.dictation.onState(setDictationState)
    const offTranscript = api.dictation.onTranscript((event) => {
      if (event.requestId !== requestRef.current) return
      if (transcriptDetachedRef.current) return
      if (event.kind === 'partial') {
        const nextPartial = `${partialRef.current}${event.text}`
        const next = replaceDictationSuffix(valueRef.current, partialRef.current, nextPartial)
        partialRef.current = nextPartial
        valueRef.current = next
        setValue(next)
      } else {
        const next = replaceDictationSuffix(valueRef.current, partialRef.current, event.text)
        partialRef.current = ''
        transcriptDetachedRef.current = false
        valueRef.current = next
        setValue(next)
        if (voiceModeRef.current && next.trim()) autoSubmitRef.current?.(next.trim())
      }
      requestAnimationFrame(autoGrow)
    })
    return () => {
      mountedRef.current = false
      offState()
      offTranscript()
      const requestId = requestRef.current
      void captureRef.current?.stop()
      captureRef.current = null
      requestRef.current = null
      if (requestId) void api.dictation.stop(requestId, true)
      window.speechSynthesis.cancel()
    }
  }, [])

  const listening = dictationState?.status === 'listening'
  const dictationBusy =
    listening ||
    dictationState?.status === 'downloading-runtime' ||
    dictationState?.status === 'downloading-model' ||
    dictationState?.status === 'starting' ||
    dictationState?.status === 'stopping'

  useEffect(() => {
    if (dictationState?.status !== 'error' || !requestRef.current) return
    requestRef.current = null
    partialRef.current = ''
    const capture = captureRef.current
    captureRef.current = null
    void capture?.stop()
    setDictationError(dictationState.error || t('composer.dictationStopped'))
  }, [dictationState])

  useEffect(() => {
    if (!listening) {
      setElapsed(0)
      return
    }
    const started = Date.now()
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000
    )
    return () => window.clearInterval(timer)
  }, [listening])

  const startDictation = async (): Promise<void> => {
    if (dictationBusy || startingRef.current) return
    startingRef.current = true
    const requestId = crypto.randomUUID()
    beforeDictationRef.current = valueRef.current
    partialRef.current = ''
    requestRef.current = requestId
    setDictationError('')
    setRawTranscript(null)
    try {
      await api.dictation.start({ requestId, mode: settings?.dictationMode ?? 'fast' })
      if (!mountedRef.current || requestRef.current !== requestId) {
        await api.dictation.stop(requestId, true).catch(() => undefined)
        return
      }
      const capture = await startDictationCapture((audio) => {
        if (requestRef.current === requestId) api.dictation.pushAudio(requestId, audio)
      })
      if (!mountedRef.current || requestRef.current !== requestId) {
        await capture.stop()
        await api.dictation.stop(requestId, true).catch(() => undefined)
        return
      }
      captureRef.current = capture
      if (voiceModeRef.current) setVoicePhase('listening')
    } catch (error) {
      await api.dictation.stop(requestId, true).catch(() => undefined)
      requestRef.current = null
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? t('composer.microphoneDenied')
          : error instanceof Error
            ? error.message
            : String(error)
      setDictationError(message)
    } finally {
      startingRef.current = false
    }
  }

  const finishDictation = async (cancel: boolean): Promise<void> => {
    const requestId = requestRef.current
    if (!requestId) return
    if (cancel) requestRef.current = null
    await captureRef.current?.stop()
    captureRef.current = null
    if (cancel) {
      valueRef.current = beforeDictationRef.current
      setValue(beforeDictationRef.current)
      partialRef.current = ''
    }
    try {
      await api.dictation.stop(requestId, cancel)
      requestRef.current = null
    } catch (error) {
      setDictationError(error instanceof Error ? error.message : String(error))
    }
    requestAnimationFrame(autoGrow)
  }

  const resumeListening = (): void => {
    if (
      !voiceModeRef.current ||
      sendingRef.current ||
      pendingSpeechRef.current > 0 ||
      requestRef.current
    )
      return
    awaitingResponseRef.current = false
    spokenLengthRef.current = 0
    speechTailRef.current = ''
    window.setTimeout(() => {
      if (voiceModeRef.current && !sendingRef.current && !requestRef.current) void startDictation()
    }, 180)
  }

  const speak = (text: string): void => {
    const clean = text.trim()
    if (!clean || !voiceModeRef.current) return
    const utterance = new SpeechSynthesisUtterance(clean)
    utterance.rate = 1.05
    pendingSpeechRef.current += 1
    setVoicePhase('speaking')
    const settled = (): void => {
      pendingSpeechRef.current = Math.max(0, pendingSpeechRef.current - 1)
      if (!sendingRef.current && pendingSpeechRef.current === 0) resumeListening()
    }
    utterance.onend = settled
    utterance.onerror = settled
    window.speechSynthesis.speak(utterance)
  }

  useEffect(() => {
    if (!voiceMode || !awaitingResponseRef.current) return
    const appended = streamingText.slice(spokenLengthRef.current)
    spokenLengthRef.current = streamingText.length
    const ready = takeSpeakableSentences(`${speechTailRef.current}${appended}`)
    speechTailRef.current = ready.rest
    ready.chunks.forEach(speak)
  }, [streamingText, voiceMode])

  useEffect(() => {
    if (!voiceMode || sending || !awaitingResponseRef.current) return
    const tail = speechTailRef.current.trim()
    speechTailRef.current = ''
    if (tail) speak(tail)
    else if (pendingSpeechRef.current === 0) resumeListening()
  }, [sending, voiceMode])

  autoSubmitRef.current = (text: string): void => {
    const requestId = requestRef.current
    if (!requestId) return
    requestRef.current = null
    const capture = captureRef.current
    captureRef.current = null
    partialRef.current = ''
    transcriptDetachedRef.current = false
    void capture
      ?.stop()
      .then(() => api.dictation.stop(requestId, false))
      .catch((error) => setDictationError(error instanceof Error ? error.message : String(error)))
    valueRef.current = ''
    setValue('')
    setImages([])
    awaitingResponseRef.current = true
    spokenLengthRef.current = 0
    speechTailRef.current = ''
    setVoicePhase('thinking')
    onSend(text, images.length ? images : undefined)
    if (ref.current) ref.current.style.height = 'auto'
  }

  const endVoiceConversation = (): void => {
    voiceModeRef.current = false
    setVoiceMode(false)
    setVoicePhase('idle')
    awaitingResponseRef.current = false
    pendingSpeechRef.current = 0
    speechTailRef.current = ''
    window.speechSynthesis.cancel()
    if (listening) void finishDictation(true)
    else if (sending && onStop) onStop()
  }

  const toggleVoiceConversation = (): void => {
    if (voiceModeRef.current && listening) {
      endVoiceConversation()
      return
    }
    if (!voiceModeRef.current) {
      voiceModeRef.current = true
      setVoiceMode(true)
    }
    window.speechSynthesis.cancel()
    pendingSpeechRef.current = 0
    speechTailRef.current = ''
    awaitingResponseRef.current = false
    if (sending && onStop) onStop()
    void startDictation()
  }

  const polish = async (): Promise<void> => {
    const sourceDraft = valueRef.current
    const text = sourceDraft.trim()
    if (!text || polishing) return
    const provider = providers.find((candidate) => candidate.id === config.providerId)
    if (!provider || !config.model) {
      setDictationError(t('composer.polishNeedsModel'))
      return
    }
    setPolishing(true)
    setDictationError('')
    setRawTranscript(valueRef.current)
    const sourceChatId = activeChat?.id ?? null
    const sourceProviderId = provider.id
    const sourceModel = config.model
    try {
      const next = await api.dictation.polish({
        text,
        providerId: sourceProviderId,
        model: sourceModel,
        chatId: sourceChatId
      })
      const current = useRoxyStore.getState()
      const currentChat = current.chats.find((chat) => chat.id === current.activeChatId)
      const currentConfig = resolveSessionConfig(currentChat, current.settings)
      if (
        valueRef.current !== sourceDraft ||
        current.activeChatId !== sourceChatId ||
        currentConfig.providerId !== sourceProviderId ||
        currentConfig.model !== sourceModel
      ) {
        setRawTranscript(null)
        setDictationError(t('composer.polishDiscarded'))
        return
      }
      valueRef.current = next
      setValue(next)
      requestAnimationFrame(autoGrow)
    } catch (error) {
      setRawTranscript(null)
      setDictationError(error instanceof Error ? error.message : String(error))
    } finally {
      setPolishing(false)
    }
  }

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const read = await Promise.all(files.map(readImageFile))
    const valid = read.filter((x): x is ComposerImage => x !== null)
    if (valid.length) setImages((prev) => [...prev, ...valid])
  }

  const removeImage = (id: string): void => setImages((prev) => prev.filter((i) => i.id !== id))

  const submit = (): void => {
    if (dictationBusy || partialRef.current) return
    const text = value.trim()
    if (!text && images.length === 0) return
    onSend(text, images.length ? images : undefined)
    setValue('')
    setImages([])
    if (ref.current) ref.current.style.height = 'auto'
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Escape stops the turn. The button alone was not enough: it hides as soon
    // as you type (the composer switches to "add to queue"), so drafting a
    // follow-up while a turn ran left no visible way to stop it — you had to
    // clear the box first to get the button back. The draft is preserved.
    if (event.key === 'Escape' && sending && onStop) {
      event.preventDefault()
      onStop()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = imageFilesFrom(event.clipboardData)
    if (files.length > 0) {
      event.preventDefault()
      void addFiles(files)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = imageFilesFrom(event.dataTransfer)
    setDragging(false)
    if (files.length > 0) {
      event.preventDefault()
      void addFiles(files)
    }
  }

  const autoGrow = (): void => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }

  // Stop needs a handler to be honest: a session can be busy with a turn this
  // composer doesn't own (a subagent's run is driven by its parent), and a Stop
  // button that does nothing is worse than none. Fall through to a disabled Send.
  const showStop = !!sending && !!onStop && !value.trim() && images.length === 0
  const canSend = !!value.trim() || images.length > 0

  return (
    <div className="bg-bg px-4 pb-1.5 pt-2">
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={onDrop}
        // `sq-frame`, not `sq`: the controls row below renders five popovers
        // (model, mode, effort, context, usage) that open UPWARD, well outside
        // this box. `.sq` masks, and a mask clips descendants, so it would erase
        // all five. `sq-frame` paints the fill instead of clipping.
        //
        // `sq-ring` repaints the border inside the squircle, so the color has to
        // travel as `--sq-ring` alongside each `border-*`. The drag ring is an
        // inset one so it follows the curve rather than boxing the corners.
        //
        // `edge` gives it the translucent, top-lit border, and `shadow-raised`
        // -- not `float` -- because the composer is anchored to the bottom of
        // the pane, not hovering over it. A float-weight shadow on a full-width
        // element that never moves reads as a permanent dark band under the box
        // rather than as depth. The edge already separates it from the
        // conversation; the shadow only has to sit it down.
        //
        // On focus the hairline brightens rather than changing hue: the box is
        // already the focus of the screen, so a colored ring on it is noise.
        className={`mx-auto max-w-3xl sq-frame sq-2xl sq-ring sq-fill-surface-2 edge edge-panel shadow-raised rounded-2xl border bg-surface-2 transition ${
          dragging
            ? 'border-accent [--sq-ring:var(--color-accent)] inset-ring-1 inset-ring-accent/40'
            : 'border-border focus-within:border-border-strong focus-within:[--sq-ring:var(--edge-strong)]'
        }`}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((img) => (
              <ImagePreview
                key={img.id}
                src={img.dataUrl}
                name={img.name}
                className="group relative h-16 w-16 overflow-hidden sq sq-lg sq-ring rounded-lg border border-border bg-surface"
              >
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  className="h-full w-full cursor-zoom-in object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  title={t('composer.removeImage')}
                  className="press-scale absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </ImagePreview>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder={
            sending
              ? onStop
                ? t('composer.queuePlaceholderStop')
                : t('composer.queuePlaceholder')
              : t('composer.placeholder')
          }
          onChange={(e) => {
            const next = e.target.value
            const previousPartial = partialRef.current
            partialRef.current = retainedDictationSuffix(next, previousPartial)
            if (previousPartial && !partialRef.current) transcriptDetachedRef.current = true
            valueRef.current = next
            setValue(next)
            autoGrow()
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="block max-h-44 w-full resize-none bg-transparent px-4 pt-3 text-sm text-text outline-none placeholder:text-text-subtle"
        />
        {(voiceMode ||
          dictationBusy ||
          dictationError ||
          dictationState?.status === 'error' ||
          dictationState?.status === 'unsupported') && (
          <div className="flex min-h-7 items-center gap-2 px-4 pb-1 text-[11px]">
            {listening ? (
              <>
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500 motion-reduce:animate-none" />
                <span className="font-medium text-text">{t('composer.localDictation')}</span>
                <span className="text-text-muted">
                  {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
                </span>
                <button
                  type="button"
                  onClick={() => void finishDictation(false)}
                  className="ml-auto rounded px-1.5 py-0.5 text-text hover:bg-white/5"
                >
                  {t('composer.stopDictation')}
                </button>
                <button
                  type="button"
                  onClick={endVoiceConversation}
                  className="rounded px-1.5 py-0.5 text-text-muted hover:bg-white/5 hover:text-text"
                >
                  {t('composer.endVoice')}
                </button>
              </>
            ) : voiceMode && voicePhase === 'thinking' ? (
              <>
                <span className="text-text-muted">{t('composer.voiceThinking')}</span>
                <button
                  type="button"
                  onClick={toggleVoiceConversation}
                  className="ml-auto rounded px-1.5 py-0.5 text-text hover:bg-white/5"
                >
                  {t('composer.interrupt')}
                </button>
                <button
                  type="button"
                  onClick={endVoiceConversation}
                  className="rounded px-1.5 py-0.5 text-text-muted hover:bg-white/5 hover:text-text"
                >
                  {t('composer.endVoice')}
                </button>
              </>
            ) : voiceMode && voicePhase === 'speaking' ? (
              <>
                <span className="font-medium text-accent">{t('composer.voiceSpeaking')}</span>
                <button
                  type="button"
                  onClick={toggleVoiceConversation}
                  className="ml-auto rounded px-1.5 py-0.5 text-text hover:bg-white/5"
                >
                  {t('composer.interrupt')}
                </button>
                <button
                  type="button"
                  onClick={endVoiceConversation}
                  className="rounded px-1.5 py-0.5 text-text-muted hover:bg-white/5 hover:text-text"
                >
                  {t('composer.endVoice')}
                </button>
              </>
            ) : dictationState?.status === 'downloading-runtime' ||
              dictationState?.status === 'downloading-model' ? (
              <span className="text-text-muted">
                {t('composer.dictationDownloading', { percent: dictationState.progress })}
              </span>
            ) : dictationState?.status === 'starting' || dictationState?.status === 'stopping' ? (
              <span className="text-text-muted">
                {dictationState.status === 'starting'
                  ? t('composer.dictationLoading')
                  : t('composer.dictationFinishing')}
              </span>
            ) : (
              <span className="text-red-400">{dictationError || dictationState?.error}</span>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1.5">
          {/* Chrome-less controls, matching the workstream strip below. Two
              things do the work the borders used to: gap-1 (further apart and
              five bare labels just scatter across the row) and px-1.5 on every
              control, which against the row's px-2.5 puts each label's first
              glyph exactly on the textarea's px-4 text column. */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title={t('composer.attachImages')}
              className="press-scale flex h-6 shrink-0 items-center justify-center sq sq-md rounded-md px-1.5 text-text-muted hover:bg-white/5 hover:text-text"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={toggleVoiceConversation}
              disabled={(dictationBusy && !listening) || dictationState?.status === 'unsupported'}
              title={
                voiceMode
                  ? listening
                    ? t('composer.stopVoiceTitle')
                    : t('composer.interruptVoiceTitle')
                  : t('composer.startVoiceTitle')
              }
              aria-label={
                voiceMode ? t('composer.stopVoiceAria') : t('composer.startVoiceAria')
              }
              className={`press-scale flex h-6 shrink-0 items-center justify-center sq sq-md rounded-md px-1.5 hover:bg-white/5 disabled:opacity-40 ${
                voiceMode ? 'bg-red-500/15 text-red-400' : 'text-text-muted hover:text-text'
              }`}
            >
              <Mic className="h-3.5 w-3.5" />
            </button>
            {settings?.dictationPolish && value.trim() && !dictationBusy && (
              <button
                type="button"
                onClick={() => void polish()}
                disabled={polishing}
                title={t('composer.polishTitle')}
                className="press-scale flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-muted hover:bg-white/5 hover:text disabled:opacity-40"
              >
                <Sparkles className="h-3 w-3" />
                {polishing ? t('composer.polishing') : t('composer.polish')}
              </button>
            )}
            {rawTranscript !== null && !dictationBusy && (
              <button
                type="button"
                onClick={() => {
                  valueRef.current = rawTranscript
                  setValue(rawTranscript)
                  setRawTranscript(null)
                  requestAnimationFrame(autoGrow)
                }}
                title={t('composer.restoreTranscript')}
                className="press-scale flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-muted hover:bg-white/5 hover:text"
              >
                <Undo2 className="h-3 w-3" />
                {t('composer.undoPolish')}
              </button>
            )}
            <ModelPicker />
            <AgentPicker />
            <ThinkingPicker />
            <ContextPicker />
            <ContextMeter />
          </div>
          {showStop ? (
            <button
              onClick={onStop}
              title={t('composer.stop')}
              className="press-scale flex h-8 w-8 shrink-0 items-center justify-center sq sq-lg rounded-lg bg-white text-black hover:bg-white/90"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend || dictationBusy || !!partialRef.current}
              title={sending ? t('composer.addToQueue') : t('composer.send')}
              className="press-scale flex h-8 w-8 shrink-0 items-center justify-center sq sq-lg rounded-lg bg-white text-black hover:bg-white/90 disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
    </div>
  )
}
