import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import type { Bot } from '@shared/types'
import { BotAvatar } from './BotAvatar'
import { cn } from '../lib/cn'

/**
 * The saved bots, as a row of faces above the session list — Instagram-stories
 * shaped, and for the same reason: a roster is browsed by recognition, not read
 * as a list.
 *
 * It sits between the two buttons and the sessions on purpose. Bots are not
 * sessions, so listing them among the chats would make them look like more
 * conversations to scroll past; and a bot you cannot see in one glance is a bot
 * you forget you made. One tap opens its own chat, so the strip is also the
 * only navigation a bot needs.
 *
 * Squircles, not circles, even though the reference is round: `BotAvatar` is
 * masked to the app's superellipse, so a `rounded-full` wrapper would draw a
 * circle around a visibly non-circular face and the mismatch shows at the
 * corners. The ring follows the avatar's shape one size up instead.
 *
 * Empty means empty: with no bots this renders nothing at all rather than a
 * placeholder rail. The "New bot" button above is already the empty state (see
 * the diagram), and an empty strip would just be a second, quieter one.
 */
export function BotCarousel({
  bots,
  activeChatId,
  busyChatIds,
  onOpen,
  onEdit,
  onNew,
  railed
}: {
  bots: Bot[]
  activeChatId: string | null
  /** Bot chats with a turn in flight — pulses the ring, as stories do for unseen. */
  busyChatIds: Set<string>
  onOpen: (bot: Bot) => void
  onEdit: (bot: Bot) => void
  onNew: () => void
  /** Collapsed sidebar: stack vertically instead of scrolling sideways. */
  railed?: boolean
}): JSX.Element | null {
  const { t } = useTranslation()

  if (bots.length === 0) return null

  return (
    <div className={cn('shrink-0 px-3 pb-1', railed && 'px-1')}>
      <div
        // Horizontal wheel: the strip is one row inside a vertically scrolling
        // sidebar, so a plain wheel event over it must keep scrolling the
        // SIDEBAR (it is what the pointer is really in) while a trackpad's
        // sideways swipe pans the strip. Translating vertical wheel into
        // horizontal pan here is the usual trick and the wrong one: it traps the
        // sidebar's scroll under the pointer.
        onWheel={(e) => {
          if (railed || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
          e.currentTarget.scrollLeft += e.deltaX
          e.preventDefault()
        }}
        className={cn(
          'flex gap-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          railed ? 'flex-col items-center' : 'items-start overflow-x-auto pb-0.5'
        )}
      >
        {bots.map((bot) => {
          const active = bot.chatId === activeChatId
          const busy = busyChatIds.has(bot.chatId)
          return (
            <button
              key={bot.id}
              onClick={() => onOpen(bot)}
              // Right-click / double-click to edit: the strip's primary job is
              // opening a bot, so editing gets the secondary gesture rather
              // than a pencil badge on every avatar.
              onDoubleClick={() => onEdit(bot)}
              onContextMenu={(e) => {
                e.preventDefault()
                onEdit(bot)
              }}
              title={bot.description ? `${bot.name} — ${bot.description}` : bot.name}
              className={cn(
                'press-scale group flex shrink-0 flex-col items-center gap-1',
                railed ? 'w-auto' : 'w-14'
              )}
            >
              {/* `.sq` + a gradient, never `.sq-ring`: the ring utility paints
                  through a background IMAGE, which a Tailwind gradient also is,
                  so the two cannot share an element (see main.css). */}
              <span
                className={cn(
                  'flex items-center justify-center sq sq-xl rounded-xl p-[2px] transition-colors',
                  busy
                    ? 'animate-pulse bg-gradient-to-br from-accent to-accent/30'
                    : active
                      ? 'bg-gradient-to-br from-accent to-accent/40'
                      : 'bg-white/10 group-hover:bg-white/25'
                )}
              >
                <BotAvatar
                  member={{
                    id: bot.id,
                    name: bot.name,
                    role: bot.description,
                    icon: bot.icon,
                    color: bot.color
                  }}
                  size="md"
                />
              </span>
              {!railed && (
                <span
                  className={cn(
                    'w-full truncate text-center text-[10px] leading-tight',
                    active ? 'text-text' : 'text-text-muted group-hover:text-text'
                  )}
                >
                  {bot.name}
                </span>
              )}
            </button>
          )
        })}

        {/* The trailing "+" from the diagram — once bots exist, adding another
            is a move within the roster, so it lives at the end of the row. */}
        <button
          onClick={onNew}
          title={t('bots.newTitle')}
          className={cn(
            'press-scale group flex shrink-0 flex-col items-center gap-1',
            railed ? 'w-auto' : 'w-14'
          )}
        >
          <span className="flex items-center justify-center p-[2px]">
            <span className="flex h-7 w-7 items-center justify-center sq sq-lg rounded-lg border border-dashed border-border text-text-subtle transition-colors group-hover:border-accent/50 group-hover:text-accent">
              <Plus className="h-3.5 w-3.5" />
            </span>
          </span>
          {!railed && (
            <span className="w-full truncate text-center text-[10px] leading-tight text-text-subtle group-hover:text-text-muted">
              {t('bots.newShort')}
            </span>
          )}
        </button>
      </div>
    </div>
  )
}
