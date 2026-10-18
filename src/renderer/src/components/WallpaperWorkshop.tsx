import { useEffect, useRef, useState } from 'react'
import { Search, Play, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  Wallpaper,
  WallpaperPage,
  WallpaperQuery,
  WallpaperSubmission
} from '@shared/wallpapers'
import { api } from '../lib/api'
import { useMotion } from '../lib/motion'
import { Button } from './ui'

export function WallpaperWorkshop({
  image,
  disabled,
  active = true
}: {
  image: string | null
  disabled: boolean
  active?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const { reduced } = useMotion()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<WallpaperQuery['kind']>('all')
  const [sort, setSort] = useState<WallpaperQuery['sort']>('featured')
  const [page, setPage] = useState<WallpaperPage>({ entries: [], nextCursor: null })
  const [selected, setSelected] = useState<Wallpaper | null>(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [form, setForm] = useState<WallpaperSubmission>({
    title: '',
    description: '',
    tags: '',
    credit: '',
    license: '',
    rightsConsent: false
  })
  const request = useRef(0)
  const lock = useRef(false)
  const activeImage = useRef(image)
  const consentImage = useRef<string | null>(null)
  activeImage.current = image
  useEffect(() => {
    setForm((previous) => ({ ...previous, rightsConsent: false }))
    consentImage.current = null
    setNotice('')
  }, [image])

  useEffect(() => {
    const version = ++request.current
    if (!open || !active) return
    setLoading(true)
    setError('')
    setSelected(null)
    setPage({ entries: [], nextCursor: null })
    const timer = setTimeout(() => {
      void api.background
        .search({ q: query, kind, sort })
        .then((result) => {
          if (request.current !== version) return
          if (result.ok) setPage(result.value)
          else setError(t(`wallpapers.errors.${result.error}`))
        })
        .catch(() => {
          if (request.current === version) setError(t('wallpapers.errors.unavailable'))
        })
        .finally(() => {
          if (request.current === version) setLoading(false)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      request.current++
    }
  }, [open, active, query, kind, sort, retry, t])

  const more = async (): Promise<void> => {
    if (loading || !page.nextCursor) return
    const version = request.current
    setLoading(true)
    setError('')
    try {
      const result = await api.background.search({ q: query, kind, sort, cursor: page.nextCursor })
      if (version !== request.current) return
      if (result.ok)
        setPage((previous) => ({
          entries: [
            ...previous.entries,
            ...result.value.entries.filter(
              (item) => !previous.entries.some((existing) => existing.id === item.id)
            )
          ],
          nextCursor: result.value.nextCursor
        }))
      else setError(t(`wallpapers.errors.${result.error}`))
    } catch {
      if (version === request.current) setError(t('wallpapers.errors.unavailable'))
    } finally {
      if (version === request.current) setLoading(false)
    }
  }
  const act = async (submit: boolean): Promise<void> => {
    if (lock.current || disabled || !active) return
    lock.current = true
    setWorking(true)
    setError('')
    setNotice('')
    try {
      if (submit) {
        const snapshot = consentImage.current
        if (!snapshot || activeImage.current !== snapshot || !form.rightsConsent) return
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot))
        const expectedImageHash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0')
        ).join('')
        const result = await api.background.submit({ ...form, expectedImageHash })
        if (result.ok) {
          setNotice(t('wallpapers.submitted', { id: result.value.id }))
          setSubmitOpen(false)
          setForm((previous) => ({ ...previous, rightsConsent: false }))
        } else setError(t(`wallpapers.errors.${result.error}`))
      } else if (selected) {
        const result = await api.background.applyCatalog(selected.id)
        if (!result.ok) setError(t(`wallpapers.errors.${result.error}`))
        else if (result.value && !result.value.ok)
          setError(t(`background.errors.${result.value.error}`))
        else if (result.value) setNotice(t('wallpapers.applied'))
      }
    } catch {
      setError(t('wallpapers.errors.unavailable'))
    } finally {
      lock.current = false
      setWorking(false)
    }
  }
  const inputClass =
    'w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs text-text outline-accent'
  return (
    <div
      className="mt-5 overflow-hidden rounded-xl border border-border bg-surface"
      aria-labelledby="wallpaper-workshop-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 flex-1">
          <h3 id="wallpaper-workshop-heading" className="text-sm font-medium">
            {t('wallpapers.title')}
          </h3>
          <p className="mt-1 max-w-lg text-xs text-text-muted">{t('wallpapers.description')}</p>
        </div>
        <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? 'wallpapers.close' : 'wallpapers.browse')}
        </Button>
      </div>
      {open && active && (
        <div className="space-y-4 border-t border-border p-4">
          <div className="flex flex-wrap gap-2">
            <label className="relative min-w-40 flex-1">
              <Search aria-hidden className="absolute top-2.5 left-3 h-3.5 w-3.5 text-text-muted" />
              <span className="sr-only">{t('wallpapers.search')}</span>
              <input
                type="search"
                value={query}
                maxLength={120}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('wallpapers.search')}
                className={`${inputClass} pl-9`}
              />
            </label>
            <select
              aria-label={t('wallpapers.type')}
              value={kind}
              onChange={(event) => setKind(event.target.value as WallpaperQuery['kind'])}
              className={`${inputClass} w-auto`}
            >
              {(['all', 'image', 'video'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`wallpapers.kinds.${value}`)}
                </option>
              ))}
            </select>
            <select
              aria-label={t('wallpapers.sort')}
              value={sort}
              onChange={(event) => setSort(event.target.value as WallpaperQuery['sort'])}
              className={`${inputClass} w-auto`}
            >
              <option value="featured">{t('wallpapers.featured')}</option>
              <option value="newest">{t('wallpapers.newest')}</option>
            </select>
          </div>
          <div
            aria-busy={loading}
            className="grid grid-cols-2 gap-2 @min-[560px]:grid-cols-3 @min-[800px]:grid-cols-4"
          >
            {page.entries.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={selected?.id === item.id}
                onClick={() => setSelected(item)}
                className={`group overflow-hidden rounded-lg border text-left focus-visible:outline-2 focus-visible:outline-accent ${selected?.id === item.id ? 'border-accent' : 'border-border hover:border-text-subtle'}`}
              >
                <div className="relative aspect-video bg-bg">
                  <img
                    src={item.posterUrl}
                    alt=""
                    loading="lazy"
                    onError={() => setError(t('wallpapers.errors.unavailable'))}
                    referrerPolicy="no-referrer"
                    crossOrigin="anonymous"
                    className="h-full w-full object-cover"
                  />
                  {item.kind === 'video' && (
                    <Play
                      aria-hidden
                      className="absolute right-2 bottom-2 h-5 w-5 rounded bg-black/60 p-1 text-white"
                    />
                  )}
                </div>
                <span className="block truncate px-2 pt-2 text-xs font-medium">{item.title}</span>
                <span className="block truncate px-2 pt-1 pb-2 text-[10px] text-text-muted">
                  {t('wallpapers.dimensions', {
                    kind: t(`wallpapers.kinds.${item.kind}`),
                    width: item.width,
                    height: item.height
                  })}
                </span>
              </button>
            ))}
          </div>
          {loading && (
            <p role="status" className="text-xs text-text-muted">
              {t('wallpapers.loading')}
            </p>
          )}
          {!loading && !page.entries.length && !error && (
            <p className="py-6 text-center text-xs text-text-muted">{t('wallpapers.empty')}</p>
          )}
          {selected && (
            <div className="overflow-hidden rounded-lg border border-border bg-bg">
              {selected.kind === 'video' && !reduced ? (
                <video
                  key={selected.id}
                  aria-label={selected.title}
                  src={selected.mediaUrl}
                  poster={selected.posterUrl}
                  muted
                  loop
                  controls
                  playsInline
                  preload="none"
                  onError={() => setError(t('wallpapers.errors.unavailable'))}
                  crossOrigin="anonymous"
                  className="aspect-video max-h-72 w-full object-contain"
                />
              ) : (
                <img
                  src={selected.posterUrl}
                  alt={selected.title}
                  referrerPolicy="no-referrer"
                  crossOrigin="anonymous"
                  className="aspect-video max-h-72 w-full object-contain"
                />
              )}
              <div className="space-y-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-sm font-medium">{selected.title}</h4>
                  <Button size="sm" disabled={working || disabled} onClick={() => void act(false)}>
                    {t(working ? 'wallpapers.working' : 'wallpapers.use')}
                  </Button>
                </div>
                {selected.description && (
                  <p className="text-xs text-text-muted">{selected.description}</p>
                )}
                <p className="text-[11px] break-words text-text-subtle">
                  {selected.credit} {selected.license}
                </p>
                <p className="text-[11px] text-text-subtle">{selected.tags}</p>
              </div>
            </div>
          )}
          {page.nextCursor && (
            <Button size="sm" disabled={loading} onClick={() => void more()}>
              {t('wallpapers.more')}
            </Button>
          )}
          {error && (
            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => setRetry(retry + 1)}
            >
              {t('wallpapers.retry')}
            </Button>
          )}
        </div>
      )}
      <div className="border-t border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-xs text-text-muted">{t('wallpapers.publishHint')}</p>
          <Button
            size="sm"
            disabled={!image || disabled || working}
            aria-expanded={submitOpen}
            onClick={() => setSubmitOpen(!submitOpen)}
          >
            <Upload aria-hidden className="h-3.5 w-3.5" />
            {t('wallpapers.submit')}
          </Button>
        </div>
        {submitOpen && (
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void act(true)
            }}
          >
            <p className="text-xs text-text-muted">{t('wallpapers.privacy')}</p>
            {(['title', 'description', 'tags', 'credit', 'license'] as const).map((key) => (
              <label key={key} className="block space-y-1 text-xs">
                <span>{t(`wallpapers.fields.${key}`)}</span>
                <input
                  className={inputClass}
                  required={key === 'title' || key === 'license'}
                  maxLength={
                    { title: 100, description: 500, tags: 200, credit: 100, license: 500 }[key]
                  }
                  value={form[key]}
                  onChange={(event) => setForm({ ...form, [key]: event.target.value })}
                />
              </label>
            ))}
            <label className="flex items-start gap-2 text-xs text-text-muted">
              <input
                type="checkbox"
                className="mt-0.5 accent-accent"
                checked={form.rightsConsent}
                onChange={(event) => {
                  consentImage.current = event.target.checked ? image : null
                  setForm({ ...form, rightsConsent: event.target.checked })
                }}
                required
              />
              <span>{t('wallpapers.consent')}</span>
            </label>
            <Button
              size="sm"
              type="submit"
              disabled={
                working ||
                disabled ||
                !image ||
                !form.rightsConsent ||
                !form.title.trim() ||
                !form.license.trim()
              }
            >
              {t(working ? 'wallpapers.working' : 'wallpapers.send')}
            </Button>
          </form>
        )}
      </div>
      {error && (
        <p role="alert" className="px-4 pb-4 text-xs text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="px-4 pb-4 text-xs text-text-muted">
          {notice}
        </p>
      )}
      {working && (
        <p role="status" className="px-4 pb-4 text-xs text-text-muted">
          {t('wallpapers.working')}
        </p>
      )}
    </div>
  )
}
