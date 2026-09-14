import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Plus, Settings, Trash2 } from 'lucide-react'
import type { BotJobInput } from '@shared/bots'
import { api } from '../lib/api'
import { BotJobEditor } from './BotSettingsPane'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'
import { BotAvatar } from './BotAvatar'
import { Button, Input, Textarea } from './ui'
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
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [instructions, setInstructions] = useState('')
  // Schedules are drafted here and saved once the bot exists (jobs need its id).
  const [drafts, setDrafts] = useState<BotJobInput[]>([])
  const [editingDraft, setEditingDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** Bot pending deletion — its own confirm dialog, separate from the edit pane. */
  const [deleting, setDeleting] = useState<string | null>(null)
  const deletingBot = bots.find((bot) => bot.id === deleting)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = (): void => {
    if (!busy) {
      setOpen(false)
      trigger.current?.focus()
    }
  }
  const valid = /^[a-z][a-z0-9_-]{1,31}$/i.test(username) && username.toLowerCase() !== 'roxy'
  const create = async (): Promise<void> => {
    if (!valid || busy || editingDraft) return
    setBusy(true)
    setError('')
    try {
      const bot = await createBot(username, instructions)
      for (const draft of drafts) await api.bots.saveJob({ ...draft, botId: bot.id })
      if (drafts.length) await api.automation.wake()
      setOpen(false)
    } catch (e) {
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
          onClick={() => {
            setUsername('')
            setInstructions('')
            setDrafts([])
            setEditingDraft(false)
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
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close()
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-bot-title"
              className="flex max-h-full w-full max-w-sm flex-col overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-2xl"
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
                  onChange={(e) => setUsername(e.target.value.replace(/\s/g, '').replace(/^@/, ''))}
                  placeholder="helper"
                  maxLength={32}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void create()
                    }
                  }}
                />
              </label>
              <p className="mt-2 text-xs text-text-subtle">{t('bots.usernameHint')}</p>
              <label className="mt-4 flex flex-col gap-2 text-xs text-text-muted">
                {t('bots.instructions')}
                <Textarea
                  rows={5}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={t('bots.instructionsHint')}
                  disabled={busy}
                />
              </label>
              <section className="mt-4 border-t border-border pt-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-text">{t('bots.schedules')}</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy || editingDraft}
                    onClick={() => setEditingDraft(true)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('bots.addSchedule')}
                  </Button>
                </div>
                {editingDraft ? (
                  <BotJobEditor
                    botId=""
                    submit={async (input) => setDrafts((old) => [...old, input])}
                    onCancel={() => setEditingDraft(false)}
                    onSaved={async () => setEditingDraft(false)}
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    {!drafts.length && (
                      <p className="text-xs text-text-subtle">{t('bots.noSchedules')}</p>
                    )}
                    {drafts.map((draft, index) => (
                      <div
                        key={index}
                        className="flex items-start justify-between gap-2 rounded-lg border border-border bg-surface-2 p-2"
                      >
                        <span className="min-w-0 break-words text-xs">{draft.name}</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          title={t('bots.deleteSchedule')}
                          disabled={busy}
                          onClick={() => setDrafts((old) => old.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-danger" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              {error && (
                <p role="alert" className="mt-3 text-xs text-danger">
                  {error}
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                  {t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={!valid || busy || editingDraft}
                  onClick={() => void create()}
                >
                  {busy ? t('bots.creating') : t('bots.create')}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
