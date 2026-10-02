import { useTranslation } from 'react-i18next'
import type { QueueItem } from '@shared/types'
import { useRoxyStore } from '../lib/store'

export function QueueBlocker({ item, waiting }: { item: QueueItem; waiting: number }): JSX.Element {
  const { t } = useTranslation()
  const source = useRoxyStore((s) => s.chats.find((chat) => chat.id === item.sourceChatId))
  return (
    <section
      role="alert"
      className="mx-4 mt-2 shrink-0 rounded-lg border border-danger/40 bg-surface px-3 py-2 text-xs"
      data-testid="queue-blocker"
    >
      <div className="mx-auto max-w-3xl space-y-1">
        <p className="font-medium text-danger">{t('queue.blocked')}</p>
        <p className="line-clamp-2 break-words text-text">{item.content}</p>
        {item.sourceChatId && (
          <p className="break-words text-text-muted">
            {t('queue.source', {
              source: item.botUsername ? '@' + item.botUsername : source?.title || item.sourceChatId
            })}
          </p>
        )}
        <p className="break-words text-danger">{item.error || t('queue.failed')}</p>
        <p className="text-text-muted">{t('queue.waiting', { count: waiting })}</p>
        <p className="select-text break-all font-mono text-text-subtle">
          {t('queue.jobId', { id: item.id })}
        </p>
      </div>
    </section>
  )
}
