import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Plus, Settings, Trash2 } from 'lucide-react'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'
import { BotAvatar } from './BotAvatar'
import { Button } from './ui'
import { ContextMenuRow, ContextMenuSurface, CONTEXT_MENU_PAD, CONTEXT_ROW_H } from './ContextMenu'

export function BotsSection({ rail = false }: { rail?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const bots = useRoxyStore((s) => s.bots)
  const active = useRoxyStore((s) => s.activeChatId)
  const running = useRoxyStore((s) => s.runningAutomation)
  const selectChat = useRoxyStore((s) => s.selectChat)
  const createBot = useRoxyStore((s) => s.createBot)
  const removeBot = useRoxyStore((s) => s.removeBot)
  const setBotSettings = useRoxyStore((s) => s.setBotSettings)
  const [menu, setMenu] = useState<{
    botId: string
    x: number
    y: number
    trigger: HTMLButtonElement
  } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBot = bots.find((bot) => bot.id === menu?.botId)
  const closeMenu = (): void => {
    setMenu(null)
    menu?.trigger.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (menu) menuRef.current?.querySelector('button')?.focus({ preventScroll: true })
  }, [menu])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** Bot pending deletion — its own confirm dialog, separate from the edit pane. */
  const [deleting, setDeleting] = useState<string | null>(null)
  const deletingBot = bots.find((bot) => bot.id === deleting)
  const trigger = useRef<HTMLButtonElement>(null)
  /**
   * Creating a bot asks nothing: it opens its chat.
   *
   * The old dialog wanted a username, a role and schedules BEFORE the first
   * message — exactly the things you work out by talking to it, and exactly the
   * reason a new user closed it again. The bot starts on a free handle and
   * renames itself when the conversation says who it is.
   */
  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await createBot()
    } catch (e) {
      // Surfaced next to the button below. The only other place this state is
      // rendered is the delete dialog, which is closed here, so a failed
      // creation used to just re-enable the button and say nothing.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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
            onContextMenu={(e) => {
              e.preventDefault()
              const rect = e.currentTarget.getBoundingClientRect()
              setMenu({
                botId: bot.id,
                x: e.clientX || rect.left,
                y: e.clientY || rect.bottom,
                trigger: e.currentTarget
              })
            }}
            onKeyDown={(e) => {
              if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                setMenu({ botId: bot.id, x: rect.left, y: rect.bottom, trigger: e.currentTarget })
              }
            }}
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
          disabled={busy}
          onClick={() => void create()}
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
      {error && !deleting && (
        <p role="alert" className="break-words px-1 pb-2 text-xs text-danger">
          {error}
        </p>
      )}
      {menu && menuBot && (
        <ContextMenuSurface
          x={menu.x}
          y={menu.y}
          height={2 * CONTEXT_ROW_H + CONTEXT_MENU_PAD}
          onClose={closeMenu}
        >
          <div
            ref={menuRef}
            data-bot-menu={menuBot.id}
            onKeyDown={(e) => {
              const buttons = [...e.currentTarget.querySelectorAll('button')]
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
              if (
                e.key === 'ArrowDown' ||
                e.key === 'ArrowUp' ||
                e.key === 'Home' ||
                e.key === 'End'
              ) {
                e.preventDefault()
                const next =
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? buttons.length - 1
                      : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
                buttons[next]?.focus()
              } else if (e.key === 'Tab') closeMenu()
            }}
          >
            <ContextMenuRow
              label={t('bots.editSettings')}
              icon={Settings}
              onSelect={() => {
                closeMenu()
                setBotSettings(menuBot.id)
              }}
            />
            <ContextMenuRow
              label={t('bots.delete')}
              icon={Trash2}
              danger
              onSelect={() => {
                closeMenu()
                setError('')
                setDeleting(menuBot.id)
              }}
            />
          </div>
        </ContextMenuSurface>
      )}
      {deletingBot &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !busy) setDeleting(null)
            }}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-bot-title"
              className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl"
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !busy) setDeleting(null)
              }}
            >
              <h2 id="delete-bot-title" className="text-lg font-semibold">
                {t('bots.deleteTitle')}
              </h2>
              <p className="mt-2 text-xs text-text-muted">
                {t('bots.deleteConfirm', { username: deletingBot.username })}
              </p>
              {error && (
                <p role="alert" className="mt-3 break-words text-xs text-danger">
                  {error}
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDeleting(null)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  autoFocus
                  type="button"
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    setError('')
                    void removeBot(deletingBot.id)
                      .then(() => setDeleting(null))
                      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setBusy(false))
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('bots.delete')}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
