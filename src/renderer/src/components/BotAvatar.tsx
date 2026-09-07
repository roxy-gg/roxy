import { Bot, Hammer, Scale, Search, ShieldCheck, TestTube } from 'lucide-react'
import type { BotAuthor, BotMember } from '@shared/types'
import { ROXY_HOST_ID } from '@shared/channel-members'
import roxy from '../assets/roxy.png'
import { cn } from '../lib/cn'

/**
 * Per-member accent, keyed by `BotMember.color`.
 *
 * A palette rather than free-form classes so a member added at runtime can only
 * pick a color that actually reads against the surface — and so the avatar, the
 * name in the transcript, and the `@mention` chip all tint from one place
 * instead of three lists that drift apart.
 */
const ACCENTS = {
  accent: { text: 'text-accent', chip: 'bg-accent/15 text-accent border-accent/30' },
  blue: { text: 'text-blue-400', chip: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  purple: {
    text: 'text-purple-400',
    chip: 'bg-purple-500/15 text-purple-300 border-purple-500/30'
  },
  emerald: {
    text: 'text-emerald-400',
    chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
  },
  amber: { text: 'text-amber-400', chip: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  cyan: { text: 'text-cyan-400', chip: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' }
} as const

export type AccentKey = keyof typeof ACCENTS

export function accentOf(color?: string): (typeof ACCENTS)[AccentKey] {
  return ACCENTS[(color ?? '') as AccentKey] ?? ACCENTS.accent
}

/** Every icon a member can carry. `Bot` is the fallback for an unknown key. */
const ICONS = {
  builder: Hammer,
  reviewer: Search,
  security: ShieldCheck,
  architect: Scale,
  tester: TestTube
} as const

const SIZES = {
  sm: { box: 'h-6 w-6', glyph: 'h-3 w-3' },
  md: { box: 'h-7 w-7', glyph: 'h-4 w-4' },
  lg: { box: 'h-9 w-9', glyph: 'h-5 w-5' }
} as const

/**
 * A channel member's avatar.
 *
 * Takes either a live `BotMember` (the roster, the `@` menu) or the `BotAuthor`
 * denormalized onto a message (the transcript), because a message's author may
 * have been detached from the channel since it was written and must still
 * render. No author at all means Roxy — every message that predates channels.
 */
export function BotAvatar({
  member,
  author,
  size = 'md',
  className
}: {
  member?: BotMember
  author?: BotAuthor
  size?: keyof typeof SIZES
  className?: string
}): JSX.Element {
  const id = member?.id
  const name = member?.name ?? author?.name
  const icon = member?.icon ?? author?.icon
  const color = member?.color ?? author?.color
  const { box, glyph } = SIZES[size]

  // The host wears the app's own face — it IS Roxy, not a bot standing in for her.
  if (!name || id === ROXY_HOST_ID || icon === 'roxy') {
    return (
      <img
        src={roxy}
        alt="Roxy"
        className={cn(
          box,
          'sq sq-lg rounded-lg object-cover inset-ring-1 inset-ring-border',
          className
        )}
      />
    )
  }

  const Icon = ICONS[(icon ?? '') as keyof typeof ICONS] ?? Bot
  return (
    <div
      title={name}
      className={cn(
        box,
        'flex items-center justify-center sq sq-lg sq-ring rounded-lg border bg-surface-2',
        accentOf(color).chip,
        className
      )}
    >
      <Icon className={glyph} />
    </div>
  )
}
