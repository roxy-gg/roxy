import { useTranslation } from 'react-i18next'
import { useRef, useState } from 'react'
import { api } from '../lib/api'
import type { QueueItem } from '@shared/types'
import { useRoxyStore } from '../lib/store'

export function QueueBlocker({ item, waiting }: { item: QueueItem; waiting: number }): JSX.Element {
  const { t } = useTranslation()
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmedRetry, setConfirmedRetry] = useState<number>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const resolve = async (action: 'retry' | 'discard'): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await api.queue.resolve(item.id, action, action === 'retry' ? confirmedRetry : undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const source = useRoxyStore((s) => s.chats.find((chat) => chat.id === item.sourceChatId))
  return (
    <section
      role="alert"
      className="mx-4 mt-2 shrink-0 rounded-lg border border-danger/40 bg-surface px-3 py-2 text-xs"
      data-testid="queue-blocker"
    >
      <div className="mx-auto max-w-3xl space-y-1">
        <p className="font-medium text-danger">
          {item.state === 'cancelled' ? t('queue.cancelledBlocked') : t('queue.blocked')}
        </p>
        <p className="text-text-muted">{t('queue.pausePolicy')}</p>
        <p className="line-clamp-2 break-words text-text">{item.content}</p>
        {item.sourceChatId && (
          <p className="break-words text-text-muted">
            {t('queue.source', {
              source: source?.title || item.sourceChatId
            })}
          </p>
        )}
        <p className="break-words text-danger">{item.error || t('queue.failed')}</p>
        <p className="text-text-muted">{t('queue.waiting', { count: waiting })}</p>
        <p className="select-text break-all font-mono text-text-subtle">
          {t('queue.jobId', { id: item.id })}
        </p>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {confirmDiscard && <p>{t('queue.discardConfirm')}</p>}
        {item.retryAfter !== undefined && <p className="text-danger">{t('queue.staleRetry')}</p>}
        <div className="flex flex-wrap gap-3 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              item.retryAfter !== undefined && confirmedRetry !== item.retryAfter
                ? setConfirmedRetry(item.retryAfter)
                : void resolve('retry')
            }
            className="text-accent disabled:opacity-40"
          >
            {confirmedRetry !== undefined && confirmedRetry === item.retryAfter
              ? t('queue.confirmRetry')
              : t('queue.retry')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => (confirmDiscard ? void resolve('discard') : setConfirmDiscard(true))}
            className="text-danger disabled:opacity-40"
          >
            {confirmDiscard ? t('queue.confirmDiscard') : t('queue.discard')}
          </button>
          {confirmDiscard && (
            <button type="button" disabled={busy} onClick={() => setConfirmDiscard(false)}>
              {t('common.cancel')}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
