import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot as BotIcon, Trash2, X } from 'lucide-react'
import type { Bot, CreateBotInput } from '@shared/types'
import { BOT_LOOKS } from '@shared/channel-members'
import { BotAvatar, accentOf } from './BotAvatar'
import { Button, Input, Textarea } from './ui'
import { cn } from '../lib/cn'

/**
 * The form you get right after clicking "New bot" — and the one you get back
 * when you edit it.
 *
 * It is deliberately a blocking step rather than a bot that appears fully
 * formed with a default brief. The three fields ARE the bot: what to call it,
 * what it is for, and how it should work. Filling them in is the moment the
 * user learns that a bot is something they define, not a preset they pick — so
 * skipping straight to a chat with "New Bot" would teach exactly the wrong
 * model of the feature (and produce a roster of identical bots).
 *
 * The same component covers create and edit, because the thing being described
 * does not change between the two, and having two dialogs is how the wording of
 * the two fields drifts apart.
 */
export function BotDialog({
  bot,
  onSave,
  onDelete,
  onClose
}: {
  /** The bot being edited, or undefined to create a new one. */
  bot?: Bot
  onSave: (input: CreateBotInput) => Promise<void>
  /** Offered only when editing. */
  onDelete?: () => Promise<void>
  onClose: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(bot?.name ?? '')
  const [description, setDescription] = useState(bot?.description ?? '')
  const [instructions, setInstructions] = useState(bot?.instructions ?? '')
  const [look, setLook] = useState(() => {
    const i = BOT_LOOKS.findIndex((l) => l.icon === bot?.icon)
    return i === -1 ? 0 : i
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const canSave = !!name.trim() && !saving

  const save = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        icon: BOT_LOOKS[look].icon,
        color: BOT_LOOKS[look].color
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!onDelete) return
    setSaving(true)
    try {
      await onDelete()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="animate-scrim-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="animate-modal-in flex max-h-full w-full max-w-md flex-col overflow-hidden sq sq-2xl sq-ring rounded-2xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          {/* The live avatar, not a generic dialog icon: the picked face is part
              of what is being authored, so it belongs where the title is. */}
          <div className="shrink-0">
            {name.trim() ? (
              <BotAvatar
                member={{
                  id: 'preview',
                  name: name.trim(),
                  role: description,
                  icon: BOT_LOOKS[look].icon,
                  color: BOT_LOOKS[look].color
                }}
                size="lg"
              />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center sq sq-xl rounded-xl bg-white/5 text-text-muted">
                <BotIcon className="h-5 w-5" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">
              {bot ? t('bots.editTitle', { name: bot.name }) : t('bots.newTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">{t('bots.subtitle')}</p>
          </div>
          <button
            onClick={onClose}
            title={t('common.close')}
            className="press-scale flex h-7 w-7 shrink-0 items-center justify-center sq sq-lg rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          <Field label={t('bots.nameLabel')} hint={t('bots.nameHint')}>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('bots.namePlaceholder')}
            />
          </Field>

          <Field label={t('bots.descriptionLabel')} hint={t('bots.descriptionHint')}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('bots.descriptionPlaceholder')}
            />
          </Field>

          <Field label={t('bots.lookLabel')}>
            <div className="flex gap-1.5">
              {BOT_LOOKS.map((l, i) => (
                <button
                  key={l.icon}
                  type="button"
                  onClick={() => setLook(i)}
                  className={cn(
                    'press-scale flex h-9 flex-1 items-center justify-center sq sq-lg rounded-lg border',
                    look === i
                      ? accentOf(l.color).chip
                      : 'border-border text-text-subtle hover:text-text'
                  )}
                >
                  <BotAvatar
                    member={{ id: l.icon, name: l.icon, role: '', icon: l.icon, color: l.color }}
                    size="sm"
                    className="border-0 bg-transparent"
                  />
                </button>
              ))}
            </div>
          </Field>

          {/* The one field that actually decides how the bot behaves, and the
              one people put a one-liner in. Highlighted while empty once a name
              is in - the mistake is silent otherwise, because a bot with no
              brief still answers (as plain Roxy) and nothing says why. */}
          <Field label={t('bots.instructionsLabel')} hint={t('bots.instructionsHint')}>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={6}
              placeholder={t('bots.instructionsPlaceholder')}
              className={cn(
                // `--sq-ring` has to be set alongside `border-*`: the squircle
                // mask repaints the hairline itself, so a border color on its
                // own is hidden and the hint would never show.
                name.trim() &&
                  !instructions.trim() &&
                  'border-accent/50 [--sq-ring:color-mix(in_srgb,var(--color-accent)_45%,transparent)]'
              )}
            />
          </Field>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3">
          {onDelete ? (
            <Button variant="danger" size="sm" onClick={() => void remove()} disabled={saving}>
              <Trash2 className="h-3.5 w-3.5" /> {t('bots.delete')}
            </Button>
          ) : (
            <span className="text-[11px] text-text-subtle">{t('bots.newFooter')}</span>
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={!canSave}>
              {bot ? t('bots.save') : t('bots.create')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-text-subtle">{hint}</span>}
    </label>
  )
}
