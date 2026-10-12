import { useRef, useState } from 'react'
import { ArrowUp, ImagePlus, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  BACKGROUND_EFFECTS,
  DEFAULT_BACKGROUND,
  type BackgroundResult,
  type BackgroundSettings as Settings
} from '@shared/background'
import { api } from '../lib/api'
import { useBackground } from '../lib/background'
import { cn } from '../lib/cn'
import { Button } from './ui'
import { ChatBackground } from './ChatBackground'

export function BackgroundSettings(): JSX.Element {
  const { t } = useTranslation()
  const background = useBackground()
  const [edits, setEdits] = useState<Partial<Settings>>({})
  const revision = useRef(0)
  const versions = useRef<Partial<Record<keyof Settings, number>>>({})
  const draft = { ...background.settings, ...edits }
  const [empty, setEmpty] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (
    operation: () => Promise<BackgroundResult | null>,
    lock = true,
    current = (): boolean => true
  ): Promise<void> => {
    if (lock) setBusy(true)
    setError('')
    try {
      const result = await operation()
      // onChanged is authoritative; replaying an older IPC reply can undo a newer broadcast.
      if (result && !result.ok && current()) {
        setError(t(`background.errors.${result.error}`))
      }
    } catch {
      if (current()) setError(t('background.errors.saveFailed'))
    } finally {
      if (lock) setBusy(false)
    }
  }
  const edit = (patch: Partial<Settings>): number => {
    const version = ++revision.current
    for (const key of Object.keys(patch) as (keyof Settings)[]) versions.current[key] = version
    setEdits((previous) => ({ ...previous, ...patch }))
    return version
  }
  const save = (patch: Partial<Settings>): void => {
    const version = edit(patch)
    const keys = Object.keys(patch) as (keyof Settings)[]
    void run(
      () => api.background.update(patch),
      false,
      () => keys.some((key) => versions.current[key] === version)
    ).finally(() => {
      // An acknowledgement may settle only its own edits, never a newer slider drag.
      setEdits((previous) => {
        const next = { ...previous }
        for (const key of keys) {
          if (versions.current[key] === version) delete next[key]
        }
        return next
      })
    })
  }
  const disabled = busy || !background.ready || !api?.background
  const controlsDisabled = disabled || !background.image

  return (
    <section className="@container mb-8" aria-labelledby="background-heading">
      <h2 id="background-heading" className="text-sm font-medium text-text">
        {t('background.title')}
      </h2>
      <p className="mt-1 mb-3 text-xs text-text-muted">{t('background.description')}</p>
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="p-4">
          <div
            className="chat-background-host relative isolate flex h-60 flex-col justify-between overflow-hidden rounded-lg border border-border bg-bg p-4"
            data-glass={(draft.glass && !!background.image) || undefined}
          >
            <ChatBackground empty={empty} settings={draft} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="rounded-md bg-bg/80 px-2 py-1 text-[11px] text-text-muted">
                {t('background.preview')}
              </span>
              <div
                className="flex rounded-lg border border-border bg-bg/90 p-0.5"
                role="group"
                aria-label={t('background.preview')}
              >
                {([true, false] as const).map((value) => (
                  <button
                    key={String(value)}
                    type="button"
                    aria-pressed={empty === value}
                    onClick={() => setEmpty(value)}
                    className={cn(
                      'rounded-md px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-accent',
                      empty === value ? 'bg-elevated text-text' : 'text-text-muted'
                    )}
                  >
                    {t(value ? 'background.emptyPreview' : 'background.sessionPreview')}
                  </button>
                ))}
              </div>
            </div>
            {!background.image ? (
              <div className="flex flex-col items-center gap-2 text-text-muted">
                <ImagePlus aria-hidden className="h-7 w-7 text-text-subtle" />
                <span className="text-xs">{t('background.noImage')}</span>
              </div>
            ) : (
              !empty && (
                <div className="flex items-start gap-2 text-xs text-text">
                  <span
                    aria-hidden
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent text-on-accent"
                  >
                    R
                  </span>
                  <span className="pt-0.5">{t('background.sampleReply')}</span>
                </div>
              )
            )}
            <div className="background-preview-panel rounded-xl border border-border p-3">
              <p className="text-xs text-text-muted">{t('background.samplePrompt')}</p>
              <div className="mt-4 flex items-center justify-between text-text-subtle">
                <Plus aria-hidden className="h-4 w-4" />
                <span className="rounded-md bg-white p-1 text-black">
                  <ArrowUp aria-hidden className="h-3.5 w-3.5" />
                </span>
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] text-text-subtle">{t('background.formats')}</p>
            <div className="flex gap-2">
              {background.image && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void run(() => api.background.remove())}
                >
                  {t('background.remove')}
                </Button>
              )}
              <Button
                size="sm"
                disabled={disabled}
                onClick={() => void run(() => api.background.choose())}
              >
                <ImagePlus aria-hidden className="h-3.5 w-3.5" />
                {t(background.image ? 'background.change' : 'background.choose')}
              </Button>
            </div>
          </div>
        </div>
        <fieldset
          disabled={controlsDisabled}
          className="min-w-0 border-t border-border disabled:opacity-50"
        >
          <legend className="sr-only">{t('background.title')}</legend>
          <div className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span id="background-effect-label" className="text-xs font-medium text-text">
                {t('background.effect')}
              </span>
              <span aria-live="polite" className="text-[11px] text-text-muted">
                {background.processing ? t('background.processing') : ''}
              </span>
            </div>
            <div
              role="group"
              aria-labelledby="background-effect-label"
              className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-bg p-1 @min-[560px]:grid-cols-6"
            >
              {BACKGROUND_EFFECTS.map((effect) => (
                <button
                  key={effect}
                  type="button"
                  aria-pressed={draft.effect === effect}
                  className={cn(
                    'rounded-md px-2 py-2 text-xs focus-visible:outline-2 focus-visible:outline-accent',
                    draft.effect === effect
                      ? 'bg-elevated text-text'
                      : 'text-text-muted hover:text-text'
                  )}
                  onClick={() => save({ effect })}
                >
                  {t(`background.effects.${effect}`)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-text-muted">{t(`background.hints.${draft.effect}`)}</p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
            <label htmlFor="background-scope" className="text-xs font-medium">
              {t('background.showOn')}
            </label>
            <select
              id="background-scope"
              value={draft.showOn}
              onChange={(e) => save({ showOn: e.target.value as Settings['showOn'] })}
              className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs outline-accent"
            >
              <option value="empty">{t('background.emptyOnly')}</option>
              <option value="all">{t('background.allSessions')}</option>
            </select>
          </div>
          {(['emptyOpacity', 'sessionOpacity'] as const).map((key) => (
            <div
              key={key}
              className="flex flex-col gap-3 border-t border-border p-4 @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:justify-between"
            >
              <div>
                <label htmlFor={`background-${key}`} className="text-xs font-medium">
                  {t(`background.${key}`)}
                </label>
                <p className="mt-1 text-xs text-text-muted">{t(`background.${key}Hint`)}</p>
              </div>
              <div className="flex items-center gap-3 @min-[560px]:w-60">
                <input
                  id={`background-${key}`}
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={draft[key]}
                  disabled={key === 'sessionOpacity' && draft.showOn === 'empty'}
                  className="min-w-0 flex-1 accent-accent"
                  onChange={(e) => {
                    setEmpty(key === 'emptyOpacity')
                    edit({ [key]: Number(e.target.value) })
                  }}
                  onPointerUp={(e) => save({ [key]: Number(e.currentTarget.value) })}
                  onKeyUp={(e) => {
                    if (
                      [
                        'ArrowLeft',
                        'ArrowRight',
                        'ArrowUp',
                        'ArrowDown',
                        'Home',
                        'End',
                        'PageUp',
                        'PageDown'
                      ].includes(e.key)
                    )
                      save({ [key]: Number(e.currentTarget.value) })
                  }}
                  onBlur={(e) => {
                    if (edits[key] !== undefined) save({ [key]: Number(e.currentTarget.value) })
                  }}
                />
                <output
                  htmlFor={`background-${key}`}
                  className="w-10 text-right text-xs tabular-nums text-text-muted"
                >
                  {t('background.percent', { value: draft[key] })}
                </output>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-4 border-t border-border p-4">
            <div>
              <label htmlFor="background-glass" className="text-xs font-medium">
                {t('background.glass')}
              </label>
              <p className="mt-1 text-xs text-text-muted">{t('background.glassHint')}</p>
            </div>
            <input
              id="background-glass"
              type="checkbox"
              checked={draft.glass}
              onChange={(e) => save({ glass: e.target.checked })}
              className="h-4 w-4 shrink-0 accent-accent"
            />
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
          <p className="text-[11px] text-text-subtle">{t('background.autoSave')}</p>
          <Button
            size="sm"
            variant="ghost"
            disabled={controlsDisabled}
            onClick={() => save({ ...DEFAULT_BACKGROUND })}
          >
            {t('background.reset')}
          </Button>
        </div>
      </div>
      {(error || background.failed) && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error ||
            t(background.image ? 'background.effectFailed' : 'background.errors.readFailed')}
        </p>
      )}
    </section>
  )
}
