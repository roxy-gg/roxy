import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  ImagePlus,
  Loader2,
  Pencil,
  UserRound,
  X
} from 'lucide-react'
import type { QueueItem as QueueItemType } from '@shared/types'
import { isClaimedQueueItem, queueOrigin } from '@shared/queue'
import { useRoxyStore } from '../lib/store'
import { imageFilesFrom, readImageFile, type ComposerImage } from '../lib/images'
import { ImagePreview } from './ImagePreview'
import {
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemAttachment,
  QueueItemContent,
  QueueItemImage,
  QueueItemIndicator
} from './Queue'

/** Give a persisted QueueImage the extra fields the composer editor needs (id + name). */
function toComposerImages(item: QueueItemType): ComposerImage[] {
  return (item.images ?? []).map((img) => ({
    id: crypto.randomUUID(),
    dataUrl: img.dataUrl,
    mediaType: img.mediaType,
    name: img.name ?? 'image'
  }))
}

/**
 * One user-authored prompt in the composer queue, including requests to collaborators.
 */
export function QueuedMessage({
  item,
  index,
  total,
  pending = false
}: {
  item: QueueItemType
  index: number
  total: number
  pending?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const editQueued = useRoxyStore((s) => s.editQueued)
  const removeQueued = useRoxyStore((s) => s.removeQueued)
  const moveQueued = useRoxyStore((s) => s.moveQueued)
  const bots = useRoxyStore((s) => s.bots)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<ComposerImage[]>([])
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const running = isClaimedQueueItem(item)
  const automated = queueOrigin(item) !== 'user'
  const failed = item.state === 'failed'
  const recipient = item.asBotId ? bots.find((bot) => bot.id === item.asBotId) : undefined
  const textRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const startEditing = (): void => {
    if (running || pending) return
    setError('')
    setDraft(item.content)
    setDraftImages(toComposerImages(item))
    setEditing(true)
    // Focus + size the textarea once it mounts.
    requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  const cancelEditing = (): void => {
    setEditing(false)
    setDraft('')
    setDraftImages([])
    setDragging(false)
  }

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const read = await Promise.all(files.map(readImageFile))
    const valid = read.filter((x): x is ComposerImage => x !== null)
    if (valid.length) setDraftImages((prev) => [...prev, ...valid])
  }

  const save = async (): Promise<void> => {
    const text = draft.trim()
    // An empty edit would silently drop the item — treat clearing everything as
    // a removal instead (matches the × affordance), so nothing invisible remains.
    if (!text && draftImages.length === 0) {
      await removeQueued(item.id)
      cancelEditing()
      return
    }
    setSaving(true)
    setError('')
    try {
      await editQueued(item.id, text, draftImages.length ? draftImages : undefined)
      cancelEditing()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditing()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = imageFilesFrom(e.clipboardData)
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    const files = imageFilesFrom(e.dataTransfer)
    setDragging(false)
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const autoGrow = (): void => {
    const el = textRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  // ---- Edit mode -------------------------------------------------------------
  if (editing) {
    return (
      <QueueItem className="flex-col items-stretch gap-0 !border-border-strong bg-surface p-0">
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
          className={`sq sq-lg rounded-lg transition ${dragging ? 'inset-ring-1 inset-ring-accent/40' : ''}`}
        >
          {draftImages.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
              {draftImages.map((img) => (
                <ImagePreview
                  key={img.id}
                  src={img.dataUrl}
                  name={img.name}
                  className="group/img relative h-12 w-12 overflow-hidden sq sq-md sq-ring rounded-md border border-border bg-surface-2"
                >
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    className="h-full w-full cursor-zoom-in object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setDraftImages((prev) => prev.filter((i) => i.id !== img.id))}
                    title={t('queue.removeImage')}
                    className="press-scale absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity group-hover/img:opacity-100"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </ImagePreview>
              ))}
            </div>
          )}
          <textarea
            ref={textRef}
            value={draft}
            rows={1}
            placeholder={t('queue.editPlaceholder')}
            onChange={(e) => {
              setDraft(e.target.value)
              setError('')
              autoGrow()
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="block max-h-52 w-full resize-none bg-transparent px-2.5 pb-1.5 pt-2.5 text-xs leading-relaxed text-text outline-none placeholder:text-text-subtle"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title={t('queue.attachImages')}
              className="press-scale flex h-6 items-center gap-1 sq sq-md sq-ring rounded-md border border-border bg-surface-2 px-1.5 text-[11px] text-text-muted hover:border-border-strong hover:text-text"
            >
              <ImagePlus className="h-3.5 w-3.5" /> {t('queue.image')}
            </button>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={cancelEditing}
                className="press-scale flex h-6 items-center sq sq-md rounded-md px-2 text-[11px] text-text-muted hover:bg-white/5 hover:text-text"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="press-scale flex h-6 items-center gap-1 sq sq-md rounded-md bg-white px-2 text-[11px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
              >
                <Check className="h-3.5 w-3.5" /> {failed ? t('queue.saveRetry') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
        {error && (
          <p role="alert" className="px-2.5 pb-2 text-xs text-danger">
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
      </QueueItem>
    )
  }

  // ---- Read-only row ---------------------------------------------------------
  return (
    <QueueItem>
      {running ? (
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
      ) : failed ? (
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
      ) : (
        <QueueItemIndicator />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide">
          <span className="inline-flex items-center gap-1 text-text-muted">
            <UserRound className="h-3 w-3" />
            {automated ? t('queue.automatedRequest') : t('queue.userRequest')}
          </span>
          {recipient && (
            <span className="normal-case tracking-normal text-text-subtle">
              {t('queue.toCollaborator', { username: recipient.username })}
            </span>
          )}
          {(running || failed) && (
            <span className={failed ? 'text-danger' : 'text-accent'}>
              {failed ? t('queue.failed') : t('queue.running')}
            </span>
          )}
        </div>
        {item.content && <QueueItemContent>{item.content}</QueueItemContent>}
        {item.images && item.images.length > 0 && (
          <QueueItemAttachment>
            {item.images.map((img, j) => (
              <QueueItemImage key={j} src={img.dataUrl} alt={img.name ?? 'image'} />
            ))}
          </QueueItemAttachment>
        )}
        {!item.content && (!item.images || item.images.length === 0) && (
          <QueueItemContent className="italic text-text-subtle">
            {t('queue.empty')}
          </QueueItemContent>
        )}
        {item.error && (
          <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-danger">
            {item.error}
          </p>
        )}
        {item.waitReason && item.waitReason !== 'delayed' && (
          <p className="mt-1 text-[11px] text-text-subtle">{t(`queue.wait.${item.waitReason}`)}</p>
        )}
        {item.notBefore != null && item.notBefore > Date.now() && (
          <p className="mt-1 text-[11px] text-text-subtle">
            {t('queue.notBefore', { time: new Date(item.notBefore).toLocaleString() })}
          </p>
        )}
      </div>
      <QueueItemActions>
        <QueueItemAction
          onClick={startEditing}
          disabled={running || pending}
          title={failed ? t('queue.editRetry') : t('queue.editMessage')}
        >
          <Pencil className="h-3.5 w-3.5" />
        </QueueItemAction>
        <QueueItemAction
          onClick={() => moveQueued(item.id, 'up')}
          disabled={running || pending || automated || index === 0}
          title={t('queue.moveUp')}
          className="disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-subtle"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </QueueItemAction>
        <QueueItemAction
          onClick={() => moveQueued(item.id, 'down')}
          disabled={running || pending || automated || index === total - 1}
          title={t('queue.moveDown')}
          className="disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-subtle"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </QueueItemAction>
        <QueueItemAction
          disabled={running || pending}
          onClick={() => removeQueued(item.id)}
          title={t('queue.removeFromQueue')}
        >
          <X className="h-3.5 w-3.5" />
        </QueueItemAction>
      </QueueItemActions>
    </QueueItem>
  )
}
