import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'
import { BotAvatar } from './BotAvatar'
import { Button, Input } from './ui'

export function BotsSection({ rail = false }: { rail?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const bots = useRoxyStore((s) => s.bots)
  const active = useRoxyStore((s) => s.activeChatId)
  const running = useRoxyStore((s) => s.runningAutomation)
  const selectChat = useRoxyStore((s) => s.selectChat)
  const createBot = useRoxyStore((s) => s.createBot)
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const close = (): void => {
    if (!busy) {
      setOpen(false)
      trigger.current?.focus()
    }
  }
  const valid = /^[a-z][a-z0-9_-]{1,31}$/i.test(username) && username.toLowerCase() !== 'roxy'

  return (
    <>
      <div
        className={cn(
          'flex gap-2 py-3',
          rail
            ? 'max-h-64 flex-col items-center overflow-y-auto'
            : 'items-center overflow-x-auto px-1'
        )}
      >
        {bots.map((bot) => (
          <button
            key={bot.id}
            title={`@${bot.username}`}
            aria-label={`@${bot.username}`}
            aria-pressed={active === bot.chatId}
            onClick={() => void selectChat(bot.chatId)}
            className={cn(
              'press-scale relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent',
              active === bot.chatId && 'ring-2 ring-accent ring-offset-2 ring-offset-surface'
            )}
          >
            <BotAvatar username={bot.username} />
            {running[bot.chatId] && (
              <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full bg-success ring-2 ring-surface" />
            )}
          </button>
        ))}
        <button
          ref={trigger}
          title={t('bots.new')}
          onClick={() => {
            setUsername('')
            setError('')
            setOpen(true)
          }}
          className={cn(
            'press-scale flex h-8 shrink-0 items-center justify-center gap-2 text-text-muted hover:bg-white/5 hover:text-text focus-visible:ring-2 focus-visible:ring-accent',
            bots.length || rail
              ? 'w-8 rounded-full border border-dashed border-border-strong'
              : 'w-full rounded-lg text-sm'
          )}
        >
          <Plus className="h-4 w-4" />
          {!bots.length && !rail && t('bots.new')}
        </button>
      </div>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close()
            }}
          >
            <form
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-bot-title"
              className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  close()
                }
                if (e.key === 'Tab') {
                  const elements = [
                    ...e.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)')
                  ]
                  const first = elements[0],
                    last = elements.at(-1)
                  if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault()
                    last?.focus()
                  } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault()
                    first?.focus()
                  }
                }
              }}
              onSubmit={async (e) => {
                e.preventDefault()
                if (!valid || busy) return
                setBusy(true)
                setError('')
                try {
                  await createBot(username)
                  setOpen(false)
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              <div className="mb-4 flex items-center gap-3">
                <BotAvatar username={username || 'bot'} size={40} />
                <h2 id="new-bot-title" className="text-lg font-semibold">
                  {t('bots.new')}
                </h2>
              </div>
              <label className="flex flex-col gap-2 text-xs text-text-muted">
                {t('bots.username')}
                <Input
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))}
                  placeholder="helper"
                  maxLength={32}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              <p className="mt-2 text-xs text-text-subtle">{t('bots.usernameHint')}</p>
              {error && (
                <p role="alert" className="mt-3 text-xs text-danger">
                  {error}
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" variant="primary" disabled={!valid || busy}>
                  {busy ? t('bots.creating') : t('bots.create')}
                </Button>
              </div>
            </form>
          </div>,
          document.body
        )}
    </>
  )
}
