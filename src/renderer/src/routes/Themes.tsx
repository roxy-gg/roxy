import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation, Trans } from 'react-i18next'
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FolderOpen,
  Palette,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react'
import type { ThemeListResult } from '@shared/api'
import {
  DEFAULT_THEME_ID,
  FONT_PRESETS,
  SWATCH_KEYS,
  THEME_COLOR_TOKENS,
  buildThemePrompt,
  serializeTheme,
  type ThemeView
} from '@shared/theme'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { Button, Textarea } from '../components/ui'
import { PageShell } from '../components/PageShell'

export default function Themes(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [data, setData] = useState<ThemeListResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (refresh = false): Promise<void> => {
    const next = refresh ? await api.themes.refresh() : await api.themes.list()
    setData(next)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Switching theme does NOT wait for this component to re-render: main
   * broadcasts the resolved theme and `lib/theme.ts` applies it to the document
   * directly, so the whole window repaints the instant it's picked. The reload
   * here only refreshes which row shows as active.
   */
  const activate = async (id: string): Promise<void> => {
    setBusy(id)
    setError('')
    try {
      await api.themes.setActive(id)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const create = async (from?: string): Promise<void> => {
    setBusy(from ?? '__new__')
    setError('')
    try {
      const source = from ? data?.themes.find((t) => t.id === from) : undefined
      const res = await api.themes.create({
        name: source ? t('themes.copyOf', { name: source.name }) : t('themes.myTheme'),
        from
      })
      if (!res.ok) {
        setError(res.error ?? t('themes.createFailed'))
        return
      }
      await load(true)
      // Drop straight into the editor: a new theme with nothing changed is not
      // a result, it's a starting point.
      if (res.id) setEditing(res.id)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(id)
    setError('')
    try {
      const res = await api.themes.remove(id)
      if (!res.ok) setError(res.error ?? t('themes.deleteFailed'))
      setConfirmDelete(null)
      if (editing === id) setEditing(null)
      await load(true)
    } finally {
      setBusy(null)
    }
  }

  const themes = data?.themes ?? []
  const activeId = data?.activeId ?? DEFAULT_THEME_ID
  const builtins = themes.filter((t) => t.source === 'builtin')
  const custom = themes.filter((t) => t.source === 'user')

  return (
    <PageShell
      title={t('themes.title')}
      subtitle={t('themes.subtitle')}
      onBack={() => navigate('/')}
    >
      {error && <p className="mb-4 text-xs text-danger">{error}</p>}

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
          {t('themes.builtIn')}
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {builtins.map((t) => (
            <ThemeCard
              key={t.id}
              theme={t}
              active={t.id === activeId}
              busy={busy === t.id}
              onActivate={() => void activate(t.id)}
              onDuplicate={() => void create(t.id)}
            />
          ))}
        </div>
      </section>

      <section className="mb-8">
        {/* Every action here acts on THIS section -- creating, rescanning and
            revealing all concern user themes on disk, not the built-ins above.
            Keeping them on the section header puts them where their effect is. */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
            {t('themes.yourThemes')}
          </h2>
          <div className="flex items-center gap-1">
            {/* Reveals the FOLDER, not the active theme: this sits under "Your
                themes" now, and the active theme is often a built-in with no file
                of its own. An empty id makes main fall back to the themes dir. */}
            {data?.directory && (
              <Button
                size="sm"
                variant="ghost"
                title={data.directory}
                onClick={() => void api.themes.reveal('')}
              >
                <FolderOpen className="h-3.5 w-3.5" /> {t('themes.openFolder')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void load(true)}>
              <RefreshCw className="h-3.5 w-3.5" /> {t('themes.rescan')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void create()}>
              <Plus className="h-3.5 w-3.5" /> {t('themes.newTheme')}
            </Button>
          </div>
        </div>

        {custom.length === 0 ? (
          <div className="sq sq-xl sq-ring sq-dashed rounded-xl border border-dashed border-border bg-surface/50 p-5 text-xs text-text-muted">
            {t('themes.emptyLead')} <code className="text-text-subtle">theme.json</code>{' '}
            {t('themes.emptyTail')}
            <ul className="mt-2 flex flex-col gap-1 text-text-subtle">
              <li>
                <code>{data?.directory ?? '\u2026/themes'}</code>
              </li>
              <li>
                <code>~/.roxy/themes/&lt;name&gt;/theme.json</code>
              </li>
            </ul>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {custom.map((t) => (
              <ThemeCard
                key={t.id}
                theme={t}
                active={t.id === activeId}
                busy={busy === t.id}
                editable
                confirmingDelete={confirmDelete === t.id}
                onActivate={() => void activate(t.id)}
                onDuplicate={() => void create(t.id)}
                onEdit={() => setEditing(editing === t.id ? null : t.id)}
                onDelete={() => setConfirmDelete(t.id)}
                onCancelDelete={() => setConfirmDelete(null)}
                onConfirmDelete={() => void remove(t.id)}
              />
            ))}
          </div>
        )}
      </section>

      {editing && (
        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
            {t('themes.editing', {
              name: themes.find((x) => x.id === editing)?.name ?? editing
            })}
          </h2>
          {/* Editor and reference side by side: the reference is only really
              actionable with a file open, and you shouldn't have to scroll away
              from the JSON to remember what "surface-2" paints. Stacks on narrow
              windows, where two columns would squeeze both. */}
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <ThemeEditor
              key={editing}
              id={editing}
              onClose={() => setEditing(null)}
              onSaved={() => void load(true)}
            />
            <ThemeReference variant="panel" />
          </div>
        </section>
      )}

      {data && data.warnings.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-warning">
            {t('themes.problemsFound')}
          </h2>
          <div className="flex flex-col gap-2 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
            {data.warnings.map((w, i) => (
              <div key={i} className="text-xs">
                <div className="text-text-muted">{w.message}</div>
                <div className="truncate font-mono text-[11px] text-text-subtle" title={w.file}>
                  {w.file}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!editing && <ThemeReference />}
    </PageShell>
  )
}

/** A theme's palette, shown as the stack of colors it actually paints with. */
function Swatches({ theme }: { theme: ThemeView }): JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {SWATCH_KEYS.map((key) => (
        <span
          key={key}
          title={key}
          className="h-4 w-4 rounded-full border border-border"
          style={{ background: theme.swatches[key] ?? 'transparent' }}
        />
      ))}
    </div>
  )
}

function ThemeCard({
  theme,
  active,
  busy,
  editable,
  confirmingDelete,
  onActivate,
  onDuplicate,
  onEdit,
  onDelete,
  onCancelDelete,
  onConfirmDelete
}: {
  theme: ThemeView
  active: boolean
  busy: boolean
  editable?: boolean
  confirmingDelete?: boolean
  onActivate: () => void
  onDuplicate: () => void
  onEdit?: () => void
  onDelete?: () => void
  onCancelDelete?: () => void
  onConfirmDelete?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'group flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border bg-surface p-4 transition',
        active
          ? 'border-accent/50 [--sq-ring:color-mix(in_srgb,var(--color-accent)_50%,transparent)]'
          : 'border-border'
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center sq sq-lg sq-ring rounded-lg border border-border bg-surface-2">
          <Palette className="h-4 w-4 text-text-muted" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-text">{theme.name}</span>
            {active && (
              <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success">
                {t('themes.active')}
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">
            {theme.description ?? t('themes.appearanceTheme', { appearance: theme.appearance })}
          </p>
        </div>
        <Swatches theme={theme} />
      </div>

      <div className="flex items-center gap-1">
        {confirmingDelete ? (
          <>
            <span className="mr-auto text-xs text-text-muted">{t('themes.confirmDelete')}</span>
            <Button size="sm" variant="ghost" onClick={onCancelDelete}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={onConfirmDelete}>
              {t('common.delete')}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant={active ? 'ghost' : 'secondary'}
              disabled={active || busy}
              onClick={onActivate}
            >
              {active ? (
                <>
                  <Check className="h-3.5 w-3.5" /> {t('themes.applied')}
                </>
              ) : (
                t('themes.apply')
              )}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onDuplicate}>
              <Copy className="h-3.5 w-3.5" /> {t('themes.duplicate')}
            </Button>
            {editable && (
              <div className="ml-auto flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={onEdit}>
                  {t('common.edit')}
                </Button>
                <button
                  onClick={onDelete}
                  title={t('themes.deleteTheme')}
                  className="press-scale flex h-8 w-8 items-center justify-center sq sq-lg rounded-lg text-text-subtle opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Raw JSON editor.
 *
 * Deliberately the file itself rather than a form of color pickers: the file is
 * the real artifact (it gets shared, diffed and hand-edited), so editing it here
 * teaches the format instead of hiding it. Saving re-applies the theme
 * immediately when it's the active one, which makes this a live preview.
 */
function ThemeEditor({
  id,
  onClose,
  onSaved
}: {
  id: string
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [source, setSource] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [expanded, setExpanded] = useState(false)
  const lineCount = source?.split('\n').length ?? 0

  useEffect(() => {
    let alive = true
    void api.themes.read(id).then((text) => {
      if (alive) setSource(text ?? '')
    })
    return () => {
      alive = false
    }
  }, [id])

  const save = async (): Promise<void> => {
    if (source === null) return
    setSaving(true)
    setError('')
    setStatus('')
    setWarnings([])
    try {
      const res = await api.themes.save(id, source)
      if (!res.ok) {
        setError(res.error ?? t('themes.saveFailed'))
        return
      }
      setWarnings(res.warnings ?? [])
      setDirty(false)
      setStatus(t('themes.saved'))
      setTimeout(() => setStatus(''), 2000)
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  if (source === null) return <p className="text-xs text-text-subtle">{t('themes.loading')}</p>

  return (
    <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
      {/* Compact by default. The JSON is usually authored elsewhere (an AI, an
          editor) and pasted in, so this is more a drop target than a writing
          surface -- and at full height it pushed the reference below the fold,
          which is what people actually need on screen while editing. */}
      <Textarea
        value={source}
        onChange={(e) => {
          setSource(e.target.value)
          setDirty(true)
          setError('')
        }}
        onKeyDown={(e) => {
          // Cmd/Ctrl+S is what anyone editing a config file will reach for.
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault()
            void save()
          }
        }}
        rows={expanded ? Math.min(30, Math.max(12, lineCount + 1)) : 4}
        className="font-mono text-xs leading-relaxed"
        spellCheck={false}
        autoComplete="off"
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      {warnings.map((w, i) => (
        <p key={i} className="text-xs text-warning">
          {w}
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? t('themes.saving') : status || t('themes.save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('themes.close')}
        </Button>
        {/* Only offer this when there is something to reveal -- a 4-line theme
            is already fully visible, and a toggle that does nothing is noise. */}
        {lineCount > 4 && (
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? (
              <>
                <ChevronsDownUp className="h-3.5 w-3.5" /> {t('themes.collapse')}
              </>
            ) : (
              <>
                <ChevronsUpDown className="h-3.5 w-3.5" /> {t('themes.expand')}
                <span className="text-text-subtle">
                  {t('themes.lineCount', { count: lineCount })}
                </span>
              </>
            )}
          </Button>
        )}
        {/* Hidden on narrow layouts: beside the reference panel this column is
            ~380px and the hint collapsed to one word per line, which looked
            broken. It is the least important thing in the row, so it drops out
            rather than wrapping into a vertical stripe. */}
        <span className="ml-auto hidden shrink-0 text-[11px] text-text-subtle lg:inline">
          {t('themes.reappliesHint')}
        </span>
      </div>
    </div>
  )
}

/**
 * What can go in a theme file.
 *
 * Two shapes for two situations. `collapsed` is the standalone accordion shown
 * on the page; `panel` is always-open and sits beside the editor, because while
 * you are typing JSON the answer to "what does surface-2 paint?" needs to be on
 * screen, not one click and a scroll away.
 *
 * The Copy prompt button is the point of the whole panel. Everything here is
 * generated from the token registry by `buildThemePrompt()`, so what you paste
 * into an LLM is the same spec the validator enforces — it cannot drift, and a
 * model given it emits a file that saves without warnings.
 */
function ThemeReference({
  variant = 'collapsed'
}: {
  variant?: 'collapsed' | 'panel'
}): JSX.Element {
  const { t } = useTranslation()
  const isPanel = variant === 'panel'
  const [open, setOpen] = useState(isPanel)
  const [copied, setCopied] = useState(false)
  const groups = useMemo(
    () => [
      { id: 'surfaces', label: t('themes.groupSurfaces') },
      { id: 'text', label: t('themes.groupText') },
      { id: 'accents', label: t('themes.groupAccents') },
      { id: 'polarity', label: t('themes.groupPolarity') }
    ],
    [t]
  )

  const copyPrompt = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildThemePrompt())
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard denied — leave the label alone rather than claim success.
    }
  }

  // Pulled into a variable so it can render at the TOP in the side panel and at
  // the BOTTOM full-width, without duplicating the markup.
  const aiBlock = (
    <div className={cn(!isPanel && 'border-t border-border pt-4')}>
      <div className="text-sm font-medium text-text">{t('themes.buildWithAi')}</div>
      <p className="mt-0.5 text-xs text-text-muted">{t('themes.buildWithAiBody')}</p>
      <Button
        variant={copied ? 'secondary' : 'primary'}
        onClick={() => void copyPrompt()}
        className="mt-3 w-full"
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5" /> {t('themes.copiedToClipboard')}
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" /> {t('themes.copyPrompt')}
          </>
        )}
      </Button>
    </div>
  )

  const body = (
    <div className="flex flex-col gap-4 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
      {/* Order flips with the layout. Beside the editor this leads, because
          "hand it to an AI" is the fastest route to a theme and the panel is
          narrow enough that everything below is a scroll away anyway. Read
          full-width the reference IS the content, so a call-to-action wedged
          above it would only push the documentation you came for down. */}
      {isPanel && aiBlock}

      <div className={cn(isPanel && 'border-t border-border pt-4')}>
        <div className="text-sm font-medium text-text">{t('themes.colors')}</div>
        <p className="mt-0.5 text-xs text-text-muted">
          <Trans i18nKey="themes.colorsBody" />
        </p>
      </div>
      {groups.map((g) => (
        <div key={g.id}>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
            {g.label}
          </div>
          <div className={cn('grid grid-cols-1 gap-1.5', !isPanel && 'sm:grid-cols-2')}>
            {THEME_COLOR_TOKENS.filter((tok) => tok.group === g.id).map((tok) => (
              <div key={tok.key} className="flex items-baseline gap-2 text-xs">
                <code className="shrink-0 text-text">{tok.key}</code>
                {/* Wraps in the side panel: the polarity hints are the most
                    important text here and truncating them loses the warning.

                    Deliberately NOT translated: these hints are the same strings
                    `buildThemePrompt()` ships to a model, and the validator
                    enforces the English token vocabulary they describe. */}
                <span className={cn('text-text-subtle', !isPanel && 'truncate')} title={tok.hint}>
                  {tok.hint}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div>
        <div className="text-sm font-medium text-text">{t('themes.fonts')}</div>
        <p className="mt-0.5 text-xs text-text-muted">
          <Trans i18nKey="themes.fontsBody" />
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {FONT_PRESETS.mono.map((f) => (
            <code
              key={f}
              className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-subtle"
            >
              {f}
            </code>
          ))}
        </div>
      </div>
      <div>
        <div className="text-sm font-medium text-text">{t('themes.example')}</div>
        <pre className="mt-1.5 overflow-x-auto sq sq-lg rounded-lg bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text-muted">
          {EXAMPLE}
        </pre>
      </div>

      {!isPanel && aiBlock}
    </div>
  )

  // Beside the editor: no toggle, and sticky so it stays put while scrolling a
  // long theme file.
  if (isPanel) return <div className="xl:sticky xl:top-4">{body}</div>

  return (
    <section>
      <button
        onClick={() => setOpen(!open)}
        className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle hover:text-text"
      >
        {open ? t('themes.hideReference') : t('themes.showReference')}
      </button>
      {open && body}
    </section>
  )
}

/**
 * A minimal theme, produced by the SAME serializer that writes theme files.
 *
 * Hand-writing this block would make it the one piece of documentation on the
 * page that can silently go stale - it would keep claiming a shape the parser
 * had stopped accepting. Generating it means the example is always literally
 * valid, and demonstrates the two things worth showing: `extends` letting a
 * theme be three colors long, and `mono` taking an explicit stack.
 */
const EXAMPLE = serializeTheme({
  id: 'my-theme',
  name: 'My Theme',
  appearance: 'dark',
  extends: DEFAULT_THEME_ID,
  colors: {
    bg: '#0d0b14',
    surface: '#141020',
    accent: 'oklch(0.72 0.19 305)'
  },
  fonts: { sans: 'system', mono: ['Berkeley Mono', 'JetBrains Mono'] }
}).trim()
