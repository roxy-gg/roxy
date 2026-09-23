import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Plus, Square, X } from 'lucide-react'
import { ModelPicker } from './ModelPicker'
import { ContextMeter, ContextPicker, ThinkingPicker, AgentPicker } from './InferenceControls'
import { imageFilesFrom, readImageFile, type ComposerImage } from '../lib/images'
import { ImagePreview } from './ImagePreview'
import { useRoxyStore } from '../lib/store'
import { BotAvatar } from './BotAvatar'
import { cn } from '../lib/cn'
import { dismissProjectAtHint, isProjectAtHintDismissed } from '../lib/project-at-hint'
import { MENTION, isKnownMention, mentionedBots } from '@shared/mentions'

export function Composer({
  onSend,
  sending,
  onStop,
  variant = 'session'
}: {
  onSend: (text: string, images?: ComposerImage[]) => void | Promise<void>
  sending?: boolean
  onStop?: () => void
  /**
   * `'bot'` strips the controls that only mean something for a project session,
   * so a bot's window reads as a different kind of place at a glance:
   *
   * - Build/Plan is a *code* mode (Plan narrows tools to read-only over a repo).
   *   A bot has no workstream - it already hides the workstream strip below -
   *   so the choice would name something that does not exist here.
   * - Model, effort and context budget are standing config for a bot, not a
   *   per-turn decision: its scheduled runs happen with no window open, so a
   *   footer picker there promises control nobody is present to exercise. They
   *   move to the bot's settings pane (`BotInferenceFields`).
   *
   * The meter stays - it describes the conversation you are actually looking at.
   */
  variant?: 'session' | 'bot'
}): JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const bots = useRoxyStore((s) => s.bots)
  const recipients = [{ id: 'roxy', username: 'roxy' }, ...bots]
  const [caret, setCaret] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [projectAtHintDismissed, setProjectAtHintDismissed] = useState(() =>
    isProjectAtHintDismissed()
  )
  /** Explicit pick when several known @bots appear; cleared when no longer mentioned. */
  const [pickedSendId, setPickedSendId] = useState<string | null>(null)
  // A mention can start anywhere, as long as the "@" opens a word (start of
  // input or after whitespace) — matching how you actually type "ask @bob to…".
  const prefix = /(?:^|[\s,;:!?()[\]{}\u00bf\u00a1])@([a-z0-9_-]*)$/i.exec(value.slice(0, caret))
  const mentions =
    focused && prefix && !mentionDismissed
      ? recipients.filter((bot) => bot.username.startsWith(prefix[1].toLowerCase())).slice(0, 8)
      : []
  const selectedMention = Math.min(mentionIndex, Math.max(0, mentions.length - 1))
  const chooseMention = (username: string): void => {
    if (!prefix) return
    // Replace just the partial mention, keeping whatever surrounds it.
    const head = value.slice(0, caret - prefix[1].length - 1) + `@${username} `
    const rest = value.slice(caret).replace(/^[a-z0-9_-]*\s*/i, '')
    setValue(head + rest)
    setCaret(head.length)
    setMentionDismissed(true)
    const picked = bots.find((bot) => bot.username.toLowerCase() === username.toLowerCase())
    setPickedSendId(picked?.id ?? null)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(head.length, head.length)
      autoGrow()
    })
  }

  // Take the caret only for the chat that asked for it (a bot just created),
  // then clear the request so switching back later does not refocus.
  const focusChatId = useRoxyStore((s) => s.composerFocusChatId)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  useEffect(() => {
    if (!focusChatId || focusChatId !== activeChatId) return
    ref.current?.focus()
    useRoxyStore.setState({ composerFocusChatId: null })
  }, [focusChatId, activeChatId])

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const read = await Promise.all(files.map(readImageFile))
    const valid = read.filter((x): x is ComposerImage => x !== null)
    if (valid.length) setImages((prev) => [...prev, ...valid])
  }

  const removeImage = (id: string): void => setImages((prev) => prev.filter((i) => i.id !== id))

  // Project sessions only: known @bots in the draft. Mentions stay visual for
  // default Enter (Roxy); "Send to @…" is the explicit guest route.
  const knownTargets = variant === 'session' ? mentionedBots(value, bots) : []
  const sendTarget =
    knownTargets.length === 1
      ? knownTargets[0]
      : (knownTargets.find((bot) => bot.id === pickedSendId) ?? null)

  useEffect(() => {
    if (!pickedSendId) return
    const stillMentioned = (variant === 'session' ? mentionedBots(value, bots) : []).some(
      (bot) => bot.id === pickedSendId
    )
    if (!stillMentioned) setPickedSendId(null)
  }, [pickedSendId, value, bots, variant])

  const submit = async (toBotId?: string): Promise<void> => {
    const text = value.trim()
    if ((submitting && !sending) || (!text && images.length === 0)) return
    if (toBotId) {
      const allowed =
        knownTargets.length === 1
          ? knownTargets[0].id === toBotId
          : knownTargets.some((bot) => bot.id === toBotId) && sendTarget?.id === toBotId
      if (!allowed) {
        setError(t('composer.chooseSendTo'))
        return
      }
    }
    // Clear immediately so a long direct turn never locks the composer. If the
    // enqueue fails, restore this draft without dropping its image attachments.
    const snapshotImages = images
    setValue('')
    setImages([])
    setMentionDismissed(true)
    setPickedSendId(null)
    setError('')
    setSubmitting(true)
    if (ref.current) ref.current.style.height = 'auto'
    try {
      if (toBotId) {
        await useRoxyStore
          .getState()
          .submitToCollaborator(text, toBotId, snapshotImages.length ? snapshotImages : undefined)
      } else {
        await onSend(text, snapshotImages.length ? snapshotImages : undefined)
      }
    } catch (e) {
      setValue((draft) => draft || text)
      setImages((draft) => (draft.length ? draft : snapshotImages))
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (mentions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex(
          (selectedMention + (event.key === 'ArrowDown' ? 1 : -1) + mentions.length) %
            mentions.length
        )
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        chooseMention(mentions[selectedMention].username)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionDismissed(true)
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
      void submit()
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

  // Only known collaborators get a tint. A mention never chooses the responder.
  const highlighted = value
    .split(new RegExp(`(${MENTION.source})`, MENTION.flags))
    .map((chunk, i) => {
      if (
        i % 2 === 0 ||
        !isKnownMention(
          chunk,
          bots.map((bot) => bot.username)
        )
      )
        return (
          <span key={i} className="text-text">
            {chunk}
          </span>
        )
      return (
        <span key={i} className="font-semibold text-accent">
          {chunk}
        </span>
      )
    })
    // A trailing newline is invisible in a div but real in a textarea.
    .concat(value.endsWith('\n') ? [<span key="pad">{'\u200b'}</span>] : [])

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
        className={`relative mx-auto max-w-3xl sq-frame sq-2xl sq-ring sq-fill-surface-2 edge edge-panel shadow-raised rounded-2xl border bg-surface-2 transition ${
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

        {mentions.length > 0 && (
          <div
            id="bot-mentions"
            role="listbox"
            aria-label={t('bots.mentionLabel')}
            className="absolute bottom-full left-0 z-40 mb-2 w-64 max-w-full rounded-xl border border-border bg-surface p-1 shadow-2xl"
          >
            {mentions.map((bot, index) => (
              <button
                type="button"
                key={bot.id}
                id={`bot-mention-${bot.id}`}
                role="option"
                aria-selected={index === selectedMention}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => chooseMention(bot.username)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm',
                  index === selectedMention
                    ? 'bg-elevated text-text'
                    : 'text-text-muted hover:bg-white/5'
                )}
              >
                <BotAvatar username={bot.username} size={24} />
                <span className="truncate">@{bot.username}</span>
              </button>
            ))}
          </div>
        )}
        {/* A textarea can't style parts of its own value, so an identical,
            aria-hidden layer sits behind it and paints the @mentions. Every
            metric below must match the textarea's exactly or the text drifts. */}
        <div className="relative">
          <div
            ref={mirror}
            aria-hidden
            className="pointer-events-none absolute inset-0 max-h-44 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3 text-sm text-transparent"
          >
            {highlighted}
          </div>
          <textarea
            ref={ref}
            value={value}
            rows={1}
            aria-label={t('composer.placeholder')}
            aria-autocomplete="list"
            aria-controls={mentions.length ? 'bot-mentions' : undefined}
            aria-activedescendant={
              mentions.length ? `bot-mention-${mentions[selectedMention].id}` : undefined
            }
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            placeholder={
              sending
                ? onStop
                  ? t('composer.queuePlaceholderStop')
                  : t('composer.queuePlaceholder')
                : t('composer.placeholder')
            }
            onChange={(e) => {
              setValue(e.target.value)
              setError('')
              setCaret(e.target.selectionStart)
              setMentionIndex(0)
              setMentionDismissed(false)
              autoGrow()
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onScroll={(e) => {
              if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop
            }}
            className="relative block max-h-44 w-full resize-none bg-transparent px-4 pt-3 text-sm text-transparent caret-text outline-none placeholder:text-text-subtle"
          />
        </div>
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
            {variant === 'session' && (
              <>
                <ModelPicker />
                <AgentPicker />
                <ThinkingPicker />
                <ContextPicker />
              </>
            )}
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
            <div className="flex max-w-[min(100%,22rem)] flex-col items-end gap-1">
              {knownTargets.length > 1 && !sendTarget && (
                <div
                  role="group"
                  aria-label={t('composer.chooseSendTo')}
                  className="flex flex-wrap justify-end gap-1"
                >
                  <span className="px-1 text-[11px] text-text-muted">
                    {t('composer.chooseSendTo')}
                  </span>
                  {knownTargets.map((bot) => (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => setPickedSendId(bot.id)}
                      className="press-scale rounded-md bg-white/5 px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-white/10"
                    >
                      @{bot.username}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1.5">
                {sendTarget && (
                  <button
                    type="button"
                    onClick={() => void submit(sendTarget.id)}
                    disabled={!canSend || (submitting && !sending)}
                    title={t('composer.sendToHint')}
                    className="press-scale h-8 shrink-0 rounded-lg bg-accent/15 px-2.5 text-xs font-medium text-accent hover:bg-accent/25 disabled:opacity-30"
                  >
                    {t('composer.sendTo', { username: sendTarget.username })}
                  </button>
                )}
                <button
                  onClick={() => void submit()}
                  disabled={!canSend || (submitting && !sending)}
                  title={sending ? t('composer.addToQueue') : t('composer.send')}
                  className="press-scale flex h-8 w-8 shrink-0 items-center justify-center sq sq-lg rounded-lg bg-white text-black hover:bg-white/90 disabled:opacity-30"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {variant === 'session' && bots.length > 0 && !projectAtHintDismissed && (
        <div
          role="note"
          className="mx-auto mb-2 flex max-w-3xl items-start gap-2 rounded-lg border border-border/60 bg-elevated/50 px-3 py-2 text-xs text-text-muted"
        >
          <p className="min-w-0 flex-1 leading-relaxed">{t('composer.projectAtHint')}</p>
          <button
            type="button"
            onClick={() => {
              dismissProjectAtHint()
              setProjectAtHintDismissed(true)
            }}
            className="press-scale shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10"
          >
            {t('composer.projectAtHintDismiss')}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mx-auto mt-2 max-w-3xl text-xs text-danger">
          {error}
        </p>
      )}
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
