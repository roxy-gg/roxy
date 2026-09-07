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
import { ArrowUp, Plus, Square, X } from 'lucide-react'
import type { BotMember } from '@shared/types'
import { ModelPicker } from './ModelPicker'
import { ContextMeter, ContextPicker, ThinkingPicker, AgentPicker } from './InferenceControls'
import { imageFilesFrom, readImageFile, type ComposerImage } from '../lib/images'
import { ImagePreview } from './ImagePreview'
import { BotAvatar } from './BotAvatar'

export function Composer({
  onSend,
  sending,
  onStop,
  members = [],
  draft,
  onDraftConsumed
}: {
  onSend: (text: string, images?: ComposerImage[]) => void
  sending?: boolean
  onStop?: () => void
  /** Channel members offered by the `@` autocomplete (host first). */
  members?: BotMember[]
  /** Text pushed in from outside (clicking a member in the roster). */
  draft?: string
  onDraftConsumed?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  const [dragging, setDragging] = useState(false)
  // Null = the `@` menu is closed. '' is a real state (just typed `@`), which
  // is why this can't be a plain empty-string check.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Clicking a member in the roster prefills `@Name `, appending rather than
  // replacing so it can be used mid-sentence without eating the draft.
  useEffect(() => {
    if (!draft) return
    setValue((prev) => (prev ? `${prev.replace(/\s*$/, '')} ${draft}` : draft))
    onDraftConsumed?.()
    ref.current?.focus()
  }, [draft, onDraftConsumed])

  const matches = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    return members.filter((m) => m.name.toLowerCase().startsWith(q))
  }, [mentionQuery, members])

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const read = await Promise.all(files.map(readImageFile))
    const valid = read.filter((x): x is ComposerImage => x !== null)
    if (valid.length) setImages((prev) => [...prev, ...valid])
  }

  const removeImage = (id: string): void => setImages((prev) => prev.filter((i) => i.id !== id))

  /** Open/close the `@` menu based on the word the caret is sitting in. */
  const syncMention = (text: string, caret: number): void => {
    // Only a `@` that starts a word opens the menu, so typing an email address
    // doesn't turn the composer into a member picker.
    const match = text.slice(0, caret).match(/(?:^|[^\w@])@([\w-]*)$/)
    setMentionQuery(match ? match[1] : null)
    if (match) setMentionIndex(0)
  }

  const insertMention = (member: BotMember): void => {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart
    const head = value.slice(0, caret).replace(/@[\w-]*$/, `@${member.name} `)
    setValue(head + value.slice(caret))
    setMentionQuery(null)
    // The caret has to be restored after React commits the new value, or the
    // browser parks it at the end of the whole textarea.
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(head.length, head.length)
    })
  }

  const submit = (): void => {
    const text = value.trim()
    if (!text && images.length === 0) return
    onSend(text, images.length ? images : undefined)
    setValue('')
    setImages([])
    setMentionQuery(null)
    if (ref.current) ref.current.style.height = 'auto'
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // The `@` menu owns the arrows, Enter/Tab, and Escape while it's open —
    // checked first so Enter completes the member instead of sending a
    // half-typed `@Rev`.
    if (matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((i) => (i + 1) % matches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        insertMention(matches[mentionIndex] ?? matches[0])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionQuery(null)
        return
      }
    }
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
    <div className="relative bg-bg px-4 pb-1.5 pt-2">
      {matches.length > 0 && (
        <div className="absolute bottom-full left-1/2 z-30 mb-1 w-72 -translate-x-1/2 overflow-hidden sq sq-xl sq-ring rounded-xl border border-border bg-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-text-muted">
            <span>Mention a member</span>
            <span className="text-text-subtle">↑↓ · Enter</span>
          </div>
          <div className="max-h-48 overflow-y-auto p-1">
            {matches.map((m, i) => (
              <button
                key={m.id}
                type="button"
                onClick={() => insertMention(m)}
                onMouseEnter={() => setMentionIndex(i)}
                className={`flex w-full items-center gap-2 sq sq-lg rounded-lg px-2 py-1.5 text-left text-xs ${
                  i === mentionIndex ? 'bg-white/10 text-text' : 'text-text-muted'
                }`}
              >
                <BotAvatar member={m} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-text">{m.name}</div>
                  <div className="truncate text-[10px] text-text-subtle">{m.role}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

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
              : members.length > 1
                ? t('composer.channelPlaceholder')
                : t('composer.placeholder')
          }
          onChange={(e) => {
            setValue(e.target.value)
            autoGrow()
            syncMention(e.target.value, e.target.selectionStart)
          }}
          // The caret can also move without the value changing (arrows, a
          // click), which opens or closes the menu just the same.
          onSelect={(e) => {
            const el = e.currentTarget
            syncMention(el.value, el.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="block max-h-44 w-full resize-none bg-transparent px-4 pt-3 text-sm text-text outline-none placeholder:text-text-subtle"
        />
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
              disabled={!canSend}
              title={sending ? 'Add to queue' : 'Send'}
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
