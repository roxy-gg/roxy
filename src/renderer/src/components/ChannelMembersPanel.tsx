import { useMemo, useState } from 'react'
import { Check, Plus, Trash2, UserPlus, X } from 'lucide-react'
import type { BotMember } from '@shared/types'
import { ROXY_HOST_ID, SUGGESTED_MEMBERS } from '@shared/channel-members'
import { BotAvatar, accentOf } from './BotAvatar'
import { Button, Input, Textarea } from './ui'
import { cn } from '../lib/cn'

/** Icon/accent pairs a custom member can pick from (mirrors BotAvatar's maps). */
const LOOKS = [
  { icon: 'builder', color: 'blue', label: 'Build' },
  { icon: 'reviewer', color: 'purple', label: 'Review' },
  { icon: 'security', color: 'emerald', label: 'Secure' },
  { icon: 'architect', color: 'amber', label: 'Design' },
  { icon: 'tester', color: 'cyan', label: 'Test' }
] as const

/**
 * The channel roster: who is in this session, and the controls to change it.
 *
 * Attaching is a one-click pick from a suggested list (or a custom bot), and
 * detaching is available on every member except the host — the point being that
 * membership is edited DURING the conversation, the way you add someone to a
 * group chat, rather than declared up front when the session is created.
 */
export function ChannelMembersPanel({
  members,
  onChange,
  onMention,
  onClose
}: {
  /** Full membership, host first. */
  members: BotMember[]
  /** Persist a new membership list (host included; it's filtered on the way in). */
  onChange: (members: BotMember[]) => void
  /** Prefill the composer with `@Name`. */
  onMention: (name: string) => void
  onClose: () => void
}): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [custom, setCustom] = useState<{
    name: string
    role: string
    prompt: string
    look: number
  }>({ name: '', role: '', prompt: '', look: 0 })

  const present = useMemo(() => new Set(members.map((m) => m.id)), [members])
  const available = SUGGESTED_MEMBERS.filter((m) => !present.has(m.id))

  const attach = (member: BotMember): void => {
    onChange([...members, member])
    setAdding(false)
  }

  const detach = (id: string): void => onChange(members.filter((m) => m.id !== id))

  const addCustom = (): void => {
    const name = custom.name.trim()
    if (!name) return
    // Slug from the name, so `@Name` addressing and the id agree. Suffixed on
    // collision rather than rejected — two bots called "QA" is the user's call,
    // but two bots with one id would make the roster ambiguous.
    let id =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'bot'
    if (id === ROXY_HOST_ID || present.has(id)) id = `${id}-${members.length}`
    const look = LOOKS[custom.look]
    attach({
      id,
      name,
      role: custom.role.trim() || 'Specialist',
      icon: look.icon,
      color: look.color,
      systemPrompt: custom.prompt.trim() || undefined
    })
    setCustom({ name: '', role: '', prompt: '', look: 0 })
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-l border-border bg-bg">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-text">
          Members <span className="text-text-subtle">{members.length}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Hide members"
          className="press-scale flex h-6 w-6 items-center justify-center sq sq-md rounded-md text-text-muted hover:bg-white/5 hover:text-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {members.map((m) => (
          <div
            key={m.id}
            className="group flex items-center gap-2 sq sq-lg rounded-lg px-2 py-1.5 hover:bg-white/5"
          >
            <BotAvatar member={m} size="sm" />
            <button
              type="button"
              onClick={() => onMention(m.name)}
              title={`Mention @${m.name}`}
              className="min-w-0 flex-1 text-left"
            >
              <div className={cn('truncate text-xs font-medium', accentOf(m.color).text)}>
                {m.name}
              </div>
              <div className="truncate text-[10px] text-text-subtle">
                {m.id === ROXY_HOST_ID ? 'Host · always here' : m.role}
              </div>
            </button>
            {m.id !== ROXY_HOST_ID && (
              <button
                type="button"
                onClick={() => detach(m.id)}
                title={`Remove ${m.name} from this channel`}
                className="press-scale flex h-6 w-6 shrink-0 items-center justify-center sq sq-md rounded-md text-text-subtle opacity-0 transition-opacity hover:bg-white/5 hover:text-danger group-hover:opacity-100"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}

        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="press-scale mt-1 flex w-full items-center gap-2 sq sq-lg rounded-lg px-2 py-1.5 text-xs text-text-muted hover:bg-white/5 hover:text-text"
          >
            <span className="flex h-6 w-6 items-center justify-center sq sq-lg rounded-lg border border-dashed border-border">
              <UserPlus className="h-3 w-3" />
            </span>
            Add member
          </button>
        )}

        {adding && (
          <div className="mt-2 sq-frame sq-xl sq-ring sq-fill-surface-2 rounded-xl border border-border bg-surface-2 p-2">
            <div className="mb-1.5 flex items-center justify-between px-0.5">
              <span className="text-[11px] font-medium text-text">Add a member</span>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="press-scale flex h-5 w-5 items-center justify-center sq sq-md rounded-md text-text-subtle hover:text-text"
              >
                <X className="h-3 w-3" />
              </button>
            </div>

            {available.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => attach(m)}
                className="press-scale flex w-full items-center gap-2 sq sq-lg rounded-lg px-1.5 py-1.5 text-left hover:bg-white/5"
              >
                <BotAvatar member={m} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-text">{m.name}</div>
                  <div className="truncate text-[10px] text-text-subtle">{m.role}</div>
                </div>
                <Plus className="h-3 w-3 shrink-0 text-text-subtle" />
              </button>
            ))}

            <div className="mt-2 border-t border-border pt-2">
              <div className="mb-1.5 px-0.5 text-[10px] uppercase tracking-wide text-text-subtle">
                Or build your own
              </div>
              <Input
                value={custom.name}
                onChange={(e) => setCustom((c) => ({ ...c, name: e.target.value }))}
                placeholder="Name"
                className="h-7 text-xs"
              />
              <Input
                value={custom.role}
                onChange={(e) => setCustom((c) => ({ ...c, role: e.target.value }))}
                placeholder="One-line role, e.g. Reviews PRs"
                className="mt-1.5 h-7 text-xs"
              />
              <div className="mt-1.5 flex gap-1">
                {LOOKS.map((look, i) => (
                  <button
                    key={look.icon}
                    type="button"
                    onClick={() => setCustom((c) => ({ ...c, look: i }))}
                    title={look.label}
                    className={cn(
                      'press-scale relative flex h-7 flex-1 items-center justify-center sq sq-md rounded-md border',
                      custom.look === i
                        ? accentOf(look.color).chip
                        : 'border-border text-text-subtle hover:text-text'
                    )}
                  >
                    <BotAvatar
                      member={{
                        id: look.icon,
                        name: look.label,
                        role: '',
                        icon: look.icon,
                        color: look.color
                      }}
                      size="sm"
                      className="border-0 bg-transparent"
                    />
                  </button>
                ))}
              </div>
              {/* Highlighted while empty once a name is in: the two fields read
                  alike, and putting the bot's actual instructions in "What it
                  does" (a one-line label) is the easy mistake - it half-works,
                  so nothing tells you it went in the wrong box. */}
              <Textarea
                value={custom.prompt}
                onChange={(e) => setCustom((c) => ({ ...c, prompt: e.target.value }))}
                rows={3}
                placeholder="Its full instructions - what it specializes in, how to work, who to hand off to. Added on top of Roxy's."
                className={cn(
                  'mt-1.5 text-xs',
                  custom.name.trim() &&
                    !custom.prompt.trim() &&
                    'border-accent/60 placeholder:text-text-muted'
                )}
              />
              <Button
                size="sm"
                variant="primary"
                onClick={addCustom}
                disabled={!custom.name.trim()}
                className="mt-1.5 w-full"
              >
                <Check className="h-3 w-3" /> Add
              </Button>
            </div>
          </div>
        )}
      </div>

      <p className="shrink-0 border-t border-border px-3 py-2 text-[10px] leading-relaxed text-text-subtle">
        Roxy answers anything you don&apos;t address.{' '}
        <span className="text-text-muted">@mention</span> a member to hand the work to them — each
        one sees only the parts of the conversation that concern it.
      </p>
    </aside>
  )
}
