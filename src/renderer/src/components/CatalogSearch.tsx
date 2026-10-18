import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, FileText, Plug, Search } from 'lucide-react'
import type { McpServerView, SkillView } from '@shared/api'
import type {
  CatalogEntry,
  CatalogKind,
  CatalogMcpOption,
  CatalogMcpSetup,
  CatalogSearchResult,
  CatalogSkillDetail
} from '@shared/catalog'
import { api } from '../lib/api'
import { Badge, Button, Input } from './ui'

export type CatalogSearchProps =
  | {
      kind: 'skills'
      active: boolean
      installedSkills: SkillView[]
      onSkillsInstalled: (skills: SkillView[]) => void
    }
  | {
      kind: 'mcp'
      active: boolean
      installedServers: McpServerView[]
      onMcpInstalled: (servers: McpServerView[]) => void
    }

// An inset focus ring survives the squircle mask, unlike an outer box shadow.
const FOCUS = 'focus-visible:inset-ring-2 focus-visible:inset-ring-accent/70'
const SELECT = `sq sq-lg sq-ring h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text outline-none ${FOCUS}`

function safeSource(url: string | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : null
  } catch {
    return null
  }
}

function nameInUse(props: CatalogSearchProps, entry: CatalogEntry): boolean {
  const name = entry.name.toLowerCase()
  return props.kind === 'skills'
    ? props.installedSkills.some((skill) => skill.name.toLowerCase() === name)
    : props.installedServers.some((server) => server.id.toLowerCase() === entry.id.toLowerCase())
}

function CatalogIcon({ entry }: { entry: CatalogEntry }): JSX.Element {
  const [failed, setFailed] = useState(false)
  // Main admits only this relay's hashed icon route, never publisher URLs.
  // The relay serves cached raster bytes; lazy images cannot delay search.
  let cached = false
  try {
    const url = new URL(entry.iconUrl ?? '')
    cached =
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/api\/catalog\/icons\/[a-f0-9]{64}$/.test(url.pathname) &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  } catch {
    /* A missing or malformed icon uses the local fallback. */
  }
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center sq sq-lg rounded-lg bg-white/5 text-text-muted">
      {cached && !failed ? (
        <img
          src={entry.iconUrl!}
          alt=""
          width={24}
          height={24}
          className="h-6 w-6 object-contain"
          loading="lazy"
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : entry.kind === 'skills' ? (
        <FileText aria-hidden="true" className="h-4 w-4" />
      ) : (
        <Plug aria-hidden="true" className="h-4 w-4" />
      )}
    </span>
  )
}

function SourceLink({ entry }: { entry: CatalogEntry }): JSX.Element {
  const { t } = useTranslation()
  const [error, setError] = useState(false)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const url = safeSource(entry.url)
  if (!url) return <p className="text-xs text-text-subtle">{t('catalog.sourceUnavailable')}</p>

  const open = async (): Promise<void> => {
    setError(false)
    try {
      await api.system.openExternal(url)
    } catch {
      if (alive.current) setError(true)
    }
  }
  return (
    <div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={FOCUS}
        onClick={() => void open()}
        aria-label={t('catalog.sourceNamed', { name: entry.name })}
      >
        <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
        {t('catalog.source')}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {t('catalog.openFailed')}
        </p>
      )}
    </div>
  )
}

/** Each query owns a generation; pagination shares that generation, not its errors. */
function useCatalogResults(kind: CatalogKind, active: boolean, query: string) {
  const [result, setResult] = useState<CatalogSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [moreLoading, setMoreLoading] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const morePending = useRef(false)
  const current = useRef({ kind, active, query })
  useLayoutEffect(() => {
    current.current = { kind, active, query }
    // Invalidate synchronously on commit, before a pending promise can render
    // results for a hidden settings section or an obsolete query.
    generation.current++
    return () => {
      generation.current++
    }
  }, [kind, active, query, attempt])

  useEffect(() => {
    const version = generation.current
    let alive = true
    morePending.current = false
    setMoreLoading(false)
    setMoreError(false)
    setResult(null)
    setError(false)
    const eligible = active && (query.length === 0 || query.length >= 2)
    setLoading(eligible)
    if (!eligible) return
    const timer = window.setTimeout(
      () => {
        if (!current.current.active || generation.current !== version) return
        const run = async (): Promise<void> => {
          try {
            const response = await api.catalog.search(kind, query)
            if (alive && generation.current === version) setResult(response)
          } catch {
            if (alive && generation.current === version) setError(true)
          } finally {
            if (alive && generation.current === version) setLoading(false)
          }
        }
        void run()
      },
      query ? 300 : 0
    )
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [kind, active, query, attempt])

  const loadMore = async (): Promise<void> => {
    if (!active || !result?.nextCursor || loading || morePending.current) return
    const version = generation.current
    const context = current.current
    if (!context.active || context.kind !== kind || context.query !== query) return
    morePending.current = true
    setMoreLoading(true)
    setMoreError(false)
    try {
      const response = await api.catalog.search(kind, query, result.nextCursor)
      if (generation.current !== version) return
      setResult((previous) => {
        if (!previous) return response
        const entries = new Map(previous.entries.map((entry) => [entry.id, entry]))
        response.entries.forEach((entry) => entries.set(entry.id, entry))
        return {
          ...response,
          entries: [...entries.values()],
          stale: previous.stale || response.stale
        }
      })
    } catch {
      if (generation.current === version) setMoreError(true)
    } finally {
      if (generation.current === version) {
        morePending.current = false
        setMoreLoading(false)
      }
    }
  }
  return {
    result,
    loading,
    error,
    moreLoading,
    moreError,
    loadMore,
    retry: () => setAttempt((n) => n + 1)
  }
}

/** Shared catalog surface; installations only happen after an explicit review. */
export function CatalogSearch(props: CatalogSearchProps): JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CatalogEntry | null>(null)
  const [installed, setInstalled] = useState<string | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const alive = useRef(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef(false)
  const trimmed = query.trim()
  const { result, loading, error, moreLoading, moreError, loadMore, retry } = useCatalogResults(
    props.kind,
    props.active,
    trimmed
  )

  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!props.active) {
      setSelected(null)
      setReviewBusy(false)
    }
  }, [props.active])

  useLayoutEffect(() => {
    if (!selected && !reviewBusy && restoreFocus.current && props.active) {
      restoreFocus.current = false
      if (trigger.current?.isConnected) trigger.current.focus()
      else searchInput.current?.focus()
    }
  }, [selected, reviewBusy, props.active])

  const close = (): void => {
    restoreFocus.current = true
    setSelected(null)
  }

  return (
    <section aria-labelledby={`${id}-title`} className="@container flex flex-col gap-3">
      <div>
        <h2
          id={`${id}-title`}
          className="text-xs font-semibold uppercase tracking-wide text-text-subtle"
        >
          {props.kind === 'skills' ? t('catalog.skillsTitle') : t('catalog.mcpTitle')}
        </h2>
        <p className="mt-1 text-xs text-text-muted">
          {props.kind === 'skills' ? t('catalog.skillsBody') : t('catalog.mcpBody')}
        </p>
      </div>
      <div className="relative">
        <label className="sr-only" htmlFor={`${id}-query`}>
          {props.kind === 'skills' ? t('catalog.skillsQuery') : t('catalog.mcpQuery')}
        </label>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-2.5 z-10 h-4 w-4 text-text-subtle"
        />
        <Input
          ref={searchInput}
          id={`${id}-query`}
          type="search"
          maxLength={120}
          value={query}
          disabled={!props.active || reviewBusy}
          className="pl-9"
          placeholder={props.kind === 'skills' ? t('catalog.skillsQuery') : t('catalog.mcpQuery')}
          aria-describedby={`${id}-hint`}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p id={`${id}-hint`} className="text-xs text-text-subtle">
        {t('catalog.queryHint')}
      </p>
      {installed && (
        <p role="status" className="text-xs text-success">
          {t('catalog.installed', { name: installed })}
        </p>
      )}
      {props.active && selected && (
        <CatalogReview
          key={`${props.kind}:${selected.id}`}
          catalog={props}
          entry={selected}
          onClose={close}
          onBusy={(busy) => {
            if (alive.current) setReviewBusy(busy)
          }}
          onDone={(name) => {
            setReviewBusy(false)
            setInstalled(name)
            close()
          }}
        />
      )}
      <div aria-live="polite" aria-atomic="true" className="text-xs text-text-muted">
        {loading && <p role="status">{trimmed ? t('catalog.searching') : t('catalog.browsing')}</p>}
        {!loading && !error && result?.entries.length === 0 && <p>{t('catalog.empty')}</p>}
        {result?.stale && <p className="text-warning">{t('catalog.stale')}</p>}
      </div>
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
          <p>{t('catalog.searchFailed')}</p>
          <Button
            type="button"
            size="sm"
            onClick={retry}
            className={FOCUS}
            disabled={!props.active}
          >
            {t('catalog.retry')}
          </Button>
        </div>
      )}
      {result && result.entries.length > 0 && (
        <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2">
          {result.entries.map((entry) => (
            <article
              key={entry.id}
              className="flex min-w-0 flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4"
            >
              <div className="flex items-start gap-3">
                <CatalogIcon key={entry.iconUrl} entry={entry} />
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-sm font-medium text-text">{entry.name}</h3>
                  <p className="mt-1 break-words text-[11px] text-text-subtle">
                    {t('catalog.publisher', { source: entry.source })}
                  </p>
                </div>
              </div>
              <p className="line-clamp-3 break-words text-xs text-text-muted">
                {entry.description || t('catalog.noDescription')}
              </p>
              <div className="flex flex-wrap gap-2">
                {props.kind === 'skills' && entry.installs !== null && (
                  <Badge>{t('catalog.installs', { count: entry.installs })}</Badge>
                )}
                {props.kind === 'mcp' && entry.version && (
                  <Badge>{t('catalog.version', { version: entry.version })}</Badge>
                )}
                {nameInUse(props, entry) && <Badge>{t('catalog.collision')}</Badge>}
              </div>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-1">
                <SourceLink entry={entry} />
                <Button
                  type="button"
                  size="sm"
                  className={FOCUS}
                  disabled={!props.active || reviewBusy}
                  aria-label={t('catalog.reviewNamed', { name: entry.name })}
                  aria-expanded={selected?.id === entry.id}
                  onClick={(event) => {
                    trigger.current = event.currentTarget
                    setSelected(entry)
                  }}
                >
                  {props.kind === 'skills' ? t('catalog.reviewSkill') : t('catalog.review')}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {moreError && (
        <p role="alert" className="text-xs text-danger">
          {t('catalog.loadMoreFailed')}
        </p>
      )}
      {result?.nextCursor && (
        <div className="flex justify-center">
          <Button
            type="button"
            size="sm"
            className={FOCUS}
            onClick={() => void loadMore()}
            disabled={!props.active || loading || moreLoading}
          >
            {moreLoading
              ? t('catalog.loadingMore')
              : moreError
                ? t('catalog.retry')
                : t('catalog.loadMore')}
          </Button>
        </div>
      )}
    </section>
  )
}

function defaults(option: CatalogMcpOption | undefined): Record<string, string> {
  return Object.fromEntries(option?.fields.map((field) => [field.key, field.default ?? '']) ?? [])
}

function CatalogReview({
  catalog,
  entry,
  onClose,
  onDone,
  onBusy
}: {
  catalog: CatalogSearchProps
  entry: CatalogEntry
  onClose: () => void
  onDone: (name: string) => void
  onBusy: (busy: boolean) => void
}): JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const alive = useRef(false)
  const installing = useRef(false)
  const detailRequest = useRef(0)
  const current = useRef(catalog)
  const [skill, setSkill] = useState<CatalogSkillDetail | null>(null)
  const [selectedFile, setSelectedFile] = useState('SKILL.md')
  const [setup, setSetup] = useState<CatalogMcpSetup | null>(null)
  const [optionId, setOptionId] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  useLayoutEffect(() => {
    current.current = catalog
  })
  useLayoutEffect(() => {
    alive.current = true
    heading.current?.focus()
    return () => {
      alive.current = false
    }
  }, [])
  useLayoutEffect(() => {
    detailRequest.current++
    return () => {
      detailRequest.current++
    }
  }, [catalog.kind, catalog.active, entry.id, attempt])

  useEffect(() => {
    if (!catalog.active) return
    let valid = true
    const version = detailRequest.current
    const usable = (): boolean =>
      valid && alive.current && current.current.active && detailRequest.current === version
    setLoading(true)
    setError(false)
    setSkill(null)
    setSelectedFile('SKILL.md')
    setSetup(null)
    setValues({})
    const load = async (): Promise<void> => {
      try {
        if (catalog.kind === 'skills') {
          const detail = await api.catalog.skillDetail(entry.id)
          if (usable()) setSkill(detail)
        } else {
          const detail = await api.catalog.mcpSetup(entry.id)
          if (usable()) {
            setSetup(detail)
            setOptionId(detail.options[0]?.id ?? '')
            setValues(defaults(detail.options[0]))
          }
        }
      } catch {
        if (usable()) setError(true)
      } finally {
        if (usable()) setLoading(false)
      }
    }
    void load()
    return () => {
      valid = false
    }
  }, [catalog.kind, catalog.active, entry.id, attempt])

  const reviewed = skill?.entry ?? setup?.entry ?? entry
  const option = setup?.options.find((item) => item.id === optionId)
  const skillFile = skill?.files?.find((file) => /(^|\/)SKILL\.md$/i.test(file.path))
  const previewFile = skill?.files?.find((file) => file.path === selectedFile) ?? skillFile
  const missingFields =
    option?.fields.some((field) => {
      const value = values[field.key] ?? ''
      return (
        (field.required && !value.trim()) ||
        (Boolean(value) && field.choices && !field.choices.includes(value))
      )
    }) ?? false
  const collision = nameInUse(catalog, reviewed)
  const canInstall =
    !loading &&
    !error &&
    !collision &&
    (catalog.kind === 'skills'
      ? Boolean(skillFile && skill?.files?.length)
      : Boolean(option && !missingFields))

  const install = async (): Promise<void> => {
    if (!current.current.active || !canInstall || installing.current) return
    installing.current = true
    setBusy(true)
    onBusy(true)
    setInstallError(null)
    try {
      if (catalog.kind === 'skills') {
        const skills = await api.catalog.installSkill(entry.id, skill!.reviewId)
        if (alive.current && current.current.kind === 'skills') {
          current.current.onSkillsInstalled(skills)
          onDone(reviewed.name)
        }
      } else if (option) {
        const servers = await api.catalog.installMcp({
          id: entry.id,
          reviewId: setup!.reviewId,
          optionId: option.id,
          values
        })
        if (alive.current && current.current.kind === 'mcp') {
          current.current.onMcpInstalled(servers)
          onDone(reviewed.name)
        }
      }
    } catch (err) {
      if (alive.current)
        setInstallError(err instanceof Error ? err.message : t('catalog.installFailed'))
    } finally {
      installing.current = false
      if (alive.current) {
        onBusy(false)
        setBusy(false)
      }
    }
  }

  return (
    <div
      role="region"
      aria-labelledby={`${id}-title`}
      aria-busy={loading || busy}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation()
          onClose()
        }
      }}
      className="flex min-w-0 flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border-strong bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h3
          ref={heading}
          id={`${id}-title`}
          tabIndex={-1}
          className="min-w-0 break-words text-sm font-medium text-text outline-none focus-visible:underline"
        >
          {t('catalog.reviewTitle', { name: reviewed.name })}
        </h3>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={FOCUS}
          onClick={onClose}
          disabled={busy}
        >
          {t('common.close')}
        </Button>
      </div>
      <p className="break-words text-xs text-text-subtle">
        {t('catalog.publisher', { source: reviewed.source })}
      </p>
      <p className="text-xs leading-relaxed text-warning">
        {catalog.kind === 'skills' ? t('catalog.skillWarning') : t('catalog.mcpWarning')}
      </p>
      <SourceLink entry={reviewed} />
      {loading && (
        <p role="status" className="text-xs text-text-muted">
          {t('catalog.detailLoading')}
        </p>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
          <p>{t('catalog.detailFailed')}</p>
          <Button
            type="button"
            size="sm"
            className={FOCUS}
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t('catalog.retry')}
          </Button>
        </div>
      )}
      {!loading &&
        !error &&
        catalog.kind === 'skills' &&
        (skillFile && skill?.files ? (
          <>
            <p className="text-xs text-text-muted">
              {t('catalog.fileCount', { count: skill.files.length })}
            </p>
            <ul className="max-h-32 overflow-auto text-xs text-text-subtle">
              {skill.files.map((file) => (
                <li key={file.path} className="break-all font-mono">
                  {file.path}
                </li>
              ))}
            </ul>
            <label htmlFor={`${id}-file`} className="text-xs font-medium text-text-muted">
              {t('catalog.filePreview')}
            </label>
            <select
              id={`${id}-file`}
              className={SELECT}
              value={previewFile?.path ?? ''}
              onChange={(event) => setSelectedFile(event.target.value)}
            >
              {skill.files.map((file) => (
                <option key={file.path} value={file.path}>
                  {file.path}
                </option>
              ))}
            </select>
            {/* React text children intentionally escape all upstream markdown/HTML. */}
            <pre
              tabIndex={0}
              aria-label={t('catalog.fileContents', { path: previewFile?.path })}
              className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed text-text ${FOCUS}`}
            >
              {previewFile?.contents}
            </pre>
          </>
        ) : (
          <p role="status" className="text-xs text-warning">
            {t('catalog.filesUnavailable')}
          </p>
        ))}
      {!loading &&
        !error &&
        catalog.kind === 'mcp' &&
        setup &&
        (setup.options.length === 0 ? (
          <p role="status" className="text-xs text-warning">
            {t('catalog.unsupported')}
          </p>
        ) : (
          <>
            <div>
              <label htmlFor={`${id}-option`} className="mb-1 block text-xs text-text-muted">
                {t('catalog.setupOption')}
              </label>
              <select
                id={`${id}-option`}
                className={SELECT}
                value={optionId}
                disabled={busy}
                onChange={(event) => {
                  setOptionId(event.target.value)
                  setValues(defaults(setup.options.find((item) => item.id === event.target.value)))
                  setInstallError(null)
                }}
              >
                {setup.options.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            {option?.fields.map((field, index) => {
              const fieldId = `${id}-field-${index}`
              return (
                <div key={`${option.id}:${field.key}`}>
                  <label htmlFor={fieldId} className="mb-1 block text-xs text-text-muted">
                    {field.required ? t('catalog.required', { label: field.label }) : field.label}
                  </label>
                  {field.choices?.length && !field.secret ? (
                    <select
                      id={fieldId}
                      className={SELECT}
                      value={values[field.key] ?? ''}
                      required={field.required}
                      disabled={busy}
                      aria-describedby={field.description ? `${fieldId}-description` : undefined}
                      onChange={(event) =>
                        setValues((previous) => ({ ...previous, [field.key]: event.target.value }))
                      }
                    >
                      <option value="">{t('catalog.chooseValue')}</option>
                      {field.choices.map((choice) => (
                        <option key={choice} value={choice}>
                          {choice}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={fieldId}
                      type={field.secret ? 'password' : 'text'}
                      value={values[field.key] ?? ''}
                      required={field.required}
                      disabled={busy}
                      placeholder={field.placeholder}
                      spellCheck={false}
                      autoComplete="off"
                      aria-describedby={field.description ? `${fieldId}-description` : undefined}
                      onChange={(event) =>
                        setValues((previous) => ({ ...previous, [field.key]: event.target.value }))
                      }
                    />
                  )}
                  {field.description && (
                    <p
                      id={`${fieldId}-description`}
                      className="mt-1 break-words text-xs text-text-subtle"
                    >
                      {field.description}
                    </p>
                  )}
                </div>
              )
            })}
            {option && (
              <div className="min-w-0">
                <p id={`${id}-preview`} className="mb-1 text-xs font-medium text-text-muted">
                  {t('catalog.preview')}
                </p>
                <pre
                  tabIndex={0}
                  aria-labelledby={`${id}-preview`}
                  className={`max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs text-text ${FOCUS}`}
                >
                  {option.preview}
                </pre>
                <p className="mt-2 text-xs text-text-subtle">{t('catalog.previewBody')}</p>
              </div>
            )}
            {missingFields && (
              <p className="text-xs text-text-muted">{t('catalog.requiredHint')}</p>
            )}
          </>
        ))}
      {collision && <p className="text-xs text-warning">{t('catalog.collision')}</p>}
      {installError && (
        <p role="alert" className="break-words text-xs text-danger">
          {installError}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="primary"
          className={FOCUS}
          disabled={!catalog.active || !canInstall || busy}
          onClick={() => void install()}
        >
          <Download aria-hidden="true" className="h-3.5 w-3.5" />
          {busy
            ? t('catalog.installing')
            : catalog.kind === 'skills'
              ? t('catalog.installSkill')
              : t('catalog.installMcp')}
        </Button>
      </div>
    </div>
  )
}
