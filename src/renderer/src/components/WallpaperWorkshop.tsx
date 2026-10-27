import { useEffect, useRef, useState } from 'react'
import { Search, Play, Plus, Upload, X, Check, Trash2 } from 'lucide-react'
import type { CustomBackground, BackgroundResult } from '@shared/background'
import { useTranslation } from 'react-i18next'
import type {
  Wallpaper,
  WallpaperPage,
  WallpaperQuery,
  WallpaperSubmission
} from '@shared/wallpapers'
import { api } from '../lib/api'
import { useBackground } from '../lib/background'
import { Button } from './ui'
import { WallpaperPreview } from './WallpaperPreview'

const LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'other'] as const

function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((tag) =>
          tag
            .replace(/[\x00-\x1f\x7f]/g, '')
            .trim()
            .replace(/^#+/, '')
            .replace(/\s+/g, ' ')
            .toLowerCase()
        )
        .filter(Boolean)
    )
  ]
}

export function WallpaperWorkshop({
  image,
  disabled,
  active = true,
  mode = 'browse',
  onAddCustom,
  customUploadVersion = 0,
  customBackground
}: {
  image: string | null
  disabled: boolean
  active?: boolean
  mode?: 'browse' | 'submit'
  onAddCustom?: () => void
  customUploadVersion?: number
  customBackground?: CustomBackground
}): JSX.Element {
  const { t } = useTranslation()
  const background = useBackground()
  const [customs, setCustoms] = useState<CustomBackground[]>([])
  const [customError, setCustomError] = useState('')
  const [selectedCustomId, setSelectedCustomId] = useState<string | null>(null)
  const [customTitle, setCustomTitle] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<WallpaperQuery['kind']>('all')
  const [sort, setSort] = useState<WallpaperQuery['sort']>('mostUsed')
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [page, setPage] = useState<WallpaperPage>({ entries: [], nextCursor: null })
  const [selected, setSelected] = useState<Wallpaper | null>(null)
  const [previewed, setPreviewed] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  const [libraryRetry, setLibraryRetry] = useState(0)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [licenseChoice, setLicenseChoice] = useState('')
  const tagsEdited = useRef(false)
  const [form, setForm] = useState<WallpaperSubmission>({
    title: customBackground?.title ?? '',
    description: '',
    tags: '',
    credit: '',
    license: '',
    rightsConsent: false
  })
  const request = useRef(0)
  const libraryRequest = useRef(0)
  const lock = useRef(false)
  const activeImage = useRef(image)
  const consentImage = useRef<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const focusedDelete = useRef(false)
  activeImage.current = image
  const visibleCustoms = customs.filter(
    (entry) =>
      (kind === 'all' || entry.kind === kind) &&
      (!query || entry.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  )
  const selectedCustom = visibleCustoms.find((entry) => entry.id === selectedCustomId)
  const highlightedCatalog = selected?.id ?? (!selectedCustomId ? background.catalogId : undefined)
  const highlightedCustom = selectedCustomId ?? (!selected ? background.customId : undefined)
  useEffect(() => {
    if (mode !== 'browse') return
    setSelected(null)
    setSelectedCustomId(background.customId ?? null)
    setConfirmDelete(false)
  }, [background.customId, background.catalogId, customUploadVersion, mode])
  useEffect(() => {
    if (customUploadVersion) {
      setQuery('')
      setKind('all')
    }
  }, [customUploadVersion])
  useEffect(() => {
    if (confirmDelete) {
      focusedDelete.current = true
      rootRef.current?.querySelector<HTMLButtonElement>('[data-cancel-delete]')?.focus()
    } else if (focusedDelete.current) {
      focusedDelete.current = false
      ;(
        rootRef.current?.querySelector<HTMLButtonElement>('[data-delete-custom]') ??
        rootRef.current?.querySelector<HTMLButtonElement>('[data-add-custom]')
      )?.focus()
    }
  }, [confirmDelete])
  useEffect(() => {
    setCustomTitle(selectedCustom?.title ?? '')
    setConfirmDelete(false)
  }, [selectedCustom?.id, selectedCustom?.title])
  useEffect(() => {
    if (!active || mode !== 'browse') return
    const version = ++libraryRequest.current
    void api.background
      .listCustom()
      .then((result) => {
        if (libraryRequest.current !== version) return
        if (result.ok) {
          setCustoms(result.value)
          setSelectedCustomId((current) =>
            current && !result.value.some((entry) => entry.id === current) ? null : current
          )
          setCustomError('')
        } else setCustomError(t('wallpapers.libraryFailed'))
      })
      .catch(() => {
        if (libraryRequest.current === version) setCustomError(t('wallpapers.libraryFailed'))
      })
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') setLibraryRetry((value) => value + 1)
    }, 60000)
    window.addEventListener('focus', refreshLibrary)
    function refreshLibrary(): void {
      setLibraryRetry((value) => value + 1)
    }
    return () => {
      libraryRequest.current++
      clearInterval(interval)
      window.removeEventListener('focus', refreshLibrary)
    }
  }, [active, mode, background.libraryVersion, retry, libraryRetry, t])
  const manageCustom = async (operation: () => Promise<BackgroundResult>): Promise<void> => {
    if (lock.current || disabled || !active) return
    lock.current = true
    setWorking(true)
    setCustomError('')
    try {
      const result = await operation()
      if (!result.ok) setCustomError(t(`background.errors.${result.error}`))
    } catch {
      setCustomError(t('wallpapers.libraryFailed'))
    } finally {
      lock.current = false
      setWorking(false)
    }
  }
  const mediaTag =
    customBackground?.kind === 'video' || image?.startsWith('data:video/')
      ? 'video'
      : image?.startsWith('data:image/gif;')
        ? 'gif'
        : 'image'
  const suggestedTags = (title: string): string[] =>
    parseTags(
      [
        mediaTag,
        ...(title.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [])
          .filter(
            (word) =>
              word.length > 2 &&
              !['the', 'and', 'for', 'with', 'from', 'this', 'that'].includes(word)
          )
          .slice(0, 8)
      ].join(', ')
    )
  const tags = parseTags(form.tags)
  const submittedTags = parseTags([form.tags, tagInput].join(', ')).join(', ')
  const tagsTooLong = submittedTags.length > 200
  const commitTags = (value = tagInput): void => {
    if (!value.trim()) return
    tagsEdited.current = true
    const next = parseTags([form.tags, value].join(', ')).join(', ')
    if (next.length > 200) return
    setForm((previous) => ({ ...previous, tags: next }))
    setTagInput('')
  }
  useEffect(() => {
    tagsEdited.current = false
    setTagInput('')
    setForm((previous) => ({
      ...previous,
      tags: suggestedTags(previous.title).join(', '),
      rightsConsent: false
    }))
    consentImage.current = null
    setNotice('')
  }, [image])

  useEffect(() => {
    const version = ++request.current
    if (!active || mode !== 'browse') return
    setLoading(true)
    setError('')
    setSelected(null)
    setPage({ entries: [], nextCursor: null })
    setThumbnails({})
    const timer = setTimeout(() => {
      void api.background
        .search({ q: query, kind, sort, limit: 10 })
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
  }, [active, mode, query, kind, sort, retry, t])

  useEffect(() => {
    if (!active || mode !== 'browse') return
    let disposed = false
    for (const item of page.entries) {
      const key = `${item.id}:${item.sha256}`
      if (thumbnails[key]) continue
      void api.background
        .thumbnail(item.id, item.sha256)
        .then((result) => {
          if (disposed) return
          if (result.ok) setThumbnails((previous) => ({ ...previous, [key]: result.value }))
          else setError(t(`wallpapers.errors.${result.error}`))
        })
        .catch(() => {
          if (!disposed) setError(t('wallpapers.errors.unavailable'))
        })
    }
    return () => {
      disposed = true
    }
    // Requests are keyed by the page; completed thumbnails must not restart sibling requests.
  }, [page, active, mode, t])

  const more = async (): Promise<void> => {
    if (loading || !page.nextCursor) return
    const version = request.current
    if (page.entries.length >= 100) return
    setLoading(true)
    setError('')
    try {
      const result = await api.background.search({
        q: query,
        kind,
        sort,
        cursor: page.nextCursor,
        limit: 10
      })
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
        if (!snapshot || activeImage.current !== snapshot || !form.rightsConsent || tagsTooLong)
          return
        const digest = customBackground
          ? null
          : await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot))
        const expectedImageHash =
          customBackground?.id ??
          Array.from(new Uint8Array(digest!), (byte) => byte.toString(16).padStart(2, '0')).join('')
        const result = await api.background.submit({
          ...form,
          tags: submittedTags,
          expectedImageHash,
          ...(customBackground ? { customId: customBackground.id } : {})
        })
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
      ref={rootRef}
      className={
        mode === 'browse'
          ? 'mb-5 overflow-hidden rounded-xl border border-border bg-surface'
          : 'contents'
      }
      aria-labelledby={mode === 'browse' ? 'wallpaper-workshop-heading' : undefined}
    >
      {mode === 'browse' && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0 flex-1">
              <h3 id="wallpaper-workshop-heading" className="text-sm font-medium">
                {t('wallpapers.title')}
              </h3>
              <p className="mt-1 max-w-lg text-xs text-text-muted">{t('wallpapers.description')}</p>
            </div>
            <Button
              data-add-custom
              size="sm"
              disabled={disabled || working || !active || !onAddCustom}
              onClick={onAddCustom}
            >
              <Plus aria-hidden className="h-3.5 w-3.5" />
              {t('wallpapers.addCustom')}
            </Button>
          </div>
          {active && (
            <div className="space-y-4 border-t border-border p-4">
              <div className="flex flex-wrap gap-2">
                <label className="relative min-w-40 flex-1">
                  <Search
                    aria-hidden
                    className="absolute top-2.5 left-3 h-3.5 w-3.5 text-text-muted"
                  />
                  <span className="sr-only">{t('wallpapers.search')}</span>
                  <input
                    type="search"
                    value={query}
                    maxLength={120}
                    onChange={(event) => {
                      setQuery(event.target.value)
                      setSelectedCustomId(null)
                    }}
                    placeholder={t('wallpapers.search')}
                    className={`${inputClass} pl-9`}
                  />
                </label>
                <select
                  aria-label={t('wallpapers.type')}
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value as WallpaperQuery['kind'])
                    setSelectedCustomId(null)
                  }}
                  className={`${inputClass} !w-auto min-w-0 flex-1 sm:flex-none`}
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
                  className={`${inputClass} !w-auto min-w-0 flex-1 sm:flex-none`}
                >
                  <option value="mostUsed">{t('wallpapers.mostUsed')}</option>
                  <option value="recentApproved">{t('wallpapers.recentApproved')}</option>
                </select>
              </div>
              <div
                aria-busy={loading}
                className="grid grid-cols-2 gap-2 @min-[560px]:grid-cols-3 @min-[800px]:grid-cols-4"
              >
                <button
                  type="button"
                  aria-label={t('wallpapers.addCustom')}
                  disabled={disabled || working || !onAddCustom}
                  onClick={onAddCustom}
                  className="press-scale group overflow-hidden rounded-lg border border-dashed border-text-subtle/50 bg-bg text-center hover:border-accent hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="flex aspect-video flex-col items-center justify-center gap-2 px-2">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-2 text-text-muted group-hover:text-accent">
                      <Plus aria-hidden className="h-5 w-5" />
                    </span>
                    <span className="text-[10px] text-text-muted">
                      {t('wallpapers.customHint')}
                    </span>
                  </span>
                  <span className="block p-2 text-xs font-medium">{t('wallpapers.addOwn')}</span>
                </button>
                {visibleCustoms.map((entry) => (
                  <button
                    type="button"
                    key={`custom:${entry.id}`}
                    data-custom-id={entry.id}
                    aria-pressed={highlightedCustom === entry.id}
                    aria-current={background.customId === entry.id ? 'true' : undefined}
                    onClick={() => {
                      setSelected(null)
                      setSelectedCustomId(entry.id)
                      setPreviewed(`custom:${entry.id}`)
                      setConfirmDelete(false)
                    }}
                    className={`group overflow-hidden rounded-lg border text-left focus-visible:outline-2 focus-visible:outline-accent ${highlightedCustom === entry.id ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-text-subtle'}`}
                  >
                    <div className="relative aspect-video bg-bg">
                      <img
                        src={entry.thumbnail}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                      {!entry.publishedId && (
                        <span className="absolute top-2 left-2 rounded-md bg-black/75 px-2 py-1 text-[10px] font-medium text-white">
                          {t('wallpapers.custom')}
                        </span>
                      )}
                      {background.customId === entry.id && (
                        <span className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-accent px-1.5 py-1 text-[10px] font-medium text-on-accent">
                          <Check aria-hidden className="h-3 w-3" />
                          {t('wallpapers.inUse')}
                        </span>
                      )}
                      {entry.kind === 'video' && (
                        <Play
                          aria-hidden
                          className="absolute right-2 bottom-2 h-5 w-5 rounded bg-black/60 p-1 text-white"
                        />
                      )}
                    </div>
                    <span className="block truncate p-2 text-xs font-medium">
                      {entry.title || t('wallpapers.untitledCustom')}
                    </span>
                  </button>
                ))}
                {page.entries.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    data-catalog-id={item.id}
                    aria-pressed={highlightedCatalog === item.id}
                    aria-current={background.catalogId === item.id ? 'true' : undefined}
                    onClick={() => {
                      setSelectedCustomId(null)
                      setSelected(item)
                      setPreviewed(`catalog:${item.id}`)
                      setConfirmDelete(false)
                    }}
                    className={`group overflow-hidden rounded-lg border text-left focus-visible:outline-2 focus-visible:outline-accent ${highlightedCatalog === item.id ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-text-subtle'}`}
                  >
                    <div className="relative aspect-video bg-bg">
                      {thumbnails[`${item.id}:${item.sha256}`] ? (
                        <img
                          src={thumbnails[`${item.id}:${item.sha256}`]}
                          alt=""
                          loading="lazy"
                          onError={() => setError(t('wallpapers.errors.unavailable'))}
                          referrerPolicy="no-referrer"
                          crossOrigin="anonymous"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span
                          aria-label={t('wallpapers.loading')}
                          className="block h-full w-full bg-elevated"
                        />
                      )}
                      {item.kind === 'video' && (
                        <Play
                          aria-hidden
                          className="absolute right-2 bottom-2 h-5 w-5 rounded bg-black/60 p-1 text-white"
                        />
                      )}
                      {background.catalogId === item.id && (
                        <span className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-accent px-1.5 py-1 text-[10px] font-medium text-on-accent">
                          <Check aria-hidden className="h-3 w-3" />
                          {t('wallpapers.inUse')}
                        </span>
                      )}
                    </div>
                    <span className="block truncate p-2 text-xs font-medium">{item.title}</span>
                  </button>
                ))}
              </div>
              {!!customs.length && (
                <p className="text-[11px] text-text-subtle">{t('wallpapers.myBackgrounds')}</p>
              )}
              {customError && (
                <p role="alert" className="text-xs text-danger">
                  {customError}
                </p>
              )}
              {selectedCustom && (
                <div
                  className="space-y-3 rounded-lg border border-border bg-bg p-3"
                  data-custom-details={selectedCustom.id}
                >
                  <WallpaperPreview
                    key={`custom:${selectedCustom.id}`}
                    id={selectedCustom.id}
                    custom
                    enabled={previewed === `custom:${selectedCustom.id}`}
                    thumbnail={selectedCustom.thumbnail}
                    title={selectedCustom.title || t('wallpapers.untitledCustom')}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="min-w-0 flex-1 break-words text-sm font-medium">
                      {selectedCustom.title || t('wallpapers.untitledCustom')}
                    </h4>
                    <Button
                      size="sm"
                      disabled={working || disabled || background.customId === selectedCustom.id}
                      onClick={() =>
                        void manageCustom(() => api.background.applyCustom(selectedCustom.id))
                      }
                    >
                      {t(
                        background.customId === selectedCustom.id
                          ? 'wallpapers.inUse'
                          : 'wallpapers.use'
                      )}
                    </Button>
                    {!selectedCustom.publishedId && (
                      <WallpaperWorkshop
                        key={selectedCustom.id}
                        image={
                          background.customId === selectedCustom.id
                            ? image
                            : selectedCustom.thumbnail
                        }
                        customBackground={selectedCustom}
                        mode="submit"
                        disabled={working || disabled}
                        active={active}
                      />
                    )}
                  </div>
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void manageCustom(() =>
                        api.background.renameCustom(selectedCustom.id, customTitle)
                      )
                    }}
                  >
                    <label className="min-w-0 flex-1 space-y-1 text-xs">
                      <span>{t('wallpapers.backgroundName')}</span>
                      <input
                        name="customTitle"
                        maxLength={100}
                        required
                        value={customTitle}
                        onChange={(event) => setCustomTitle(event.target.value)}
                        className={inputClass}
                        disabled={working || disabled}
                      />
                    </label>
                    <Button
                      size="sm"
                      type="submit"
                      disabled={
                        working ||
                        disabled ||
                        !customTitle.trim() ||
                        customTitle.trim() === selectedCustom.title
                      }
                    >
                      {t('wallpapers.rename')}
                    </Button>
                  </form>
                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    {confirmDelete ? (
                      <>
                        <p id="wallpaper-delete-hint" className="w-full text-xs text-text-muted">
                          {t('wallpapers.deleteHint')}
                        </p>
                        <Button
                          size="sm"
                          variant="danger"
                          aria-describedby="wallpaper-delete-hint"
                          disabled={working || disabled}
                          onClick={() =>
                            void manageCustom(async () => {
                              const result = await api.background.deleteCustom(selectedCustom.id)
                              if (result.ok) {
                                setSelectedCustomId((current) =>
                                  current === selectedCustom.id ? null : current
                                )
                                setConfirmDelete(false)
                              }
                              return result
                            })
                          }
                        >
                          {t('wallpapers.confirmDelete')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          data-cancel-delete
                          aria-describedby="wallpaper-delete-hint"
                          disabled={working}
                          onClick={() => setConfirmDelete(false)}
                        >
                          {t('wallpapers.cancel')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-delete-custom
                        disabled={working || disabled}
                        onClick={() => setConfirmDelete(true)}
                      >
                        <Trash2 aria-hidden className="h-3.5 w-3.5" />
                        {t('wallpapers.delete')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {loading && (
                <p role="status" className="text-xs text-text-muted">
                  {t('wallpapers.loading')}
                </p>
              )}
              {!loading && !page.entries.length && !visibleCustoms.length && !error && (
                <p className="py-6 text-center text-xs text-text-muted">{t('wallpapers.empty')}</p>
              )}
              {selected && (
                <div className="overflow-hidden rounded-lg border border-border bg-bg">
                  <WallpaperPreview
                    key={`catalog:${selected.id}:${selected.sha256}`}
                    id={selected.id}
                    enabled={
                      previewed === `catalog:${selected.id}` &&
                      (selected.kind === 'video' || selected.mime === 'image/gif')
                    }
                    thumbnail={thumbnails[`${selected.id}:${selected.sha256}`]}
                    title={selected.title}
                  />
                  <div className="space-y-2 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h4 className="text-sm font-medium">{selected.title}</h4>
                      <Button
                        size="sm"
                        disabled={working || disabled || background.catalogId === selected.id}
                        onClick={() => void act(false)}
                      >
                        {t(
                          working
                            ? 'wallpapers.working'
                            : background.catalogId === selected.id
                              ? 'wallpapers.inUse'
                              : 'wallpapers.use'
                        )}
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
              {page.nextCursor && page.entries.length < 100 && (
                <Button size="sm" disabled={loading} onClick={() => void more()}>
                  {t('wallpapers.more')}
                </Button>
              )}
              {(error || customError) && (
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
        </>
      )}
      {mode === 'submit' && image && (
        <>
          <Button
            size="sm"
            disabled={disabled || working || !active}
            title={t('wallpapers.publishHint')}
            aria-expanded={submitOpen}
            onClick={() => setSubmitOpen(!submitOpen)}
          >
            <Upload aria-hidden className="h-3.5 w-3.5" />
            {t('wallpapers.submit')}
          </Button>
          {submitOpen && (
            <form
              className="order-last mt-3 w-full space-y-3 rounded-lg border border-border bg-bg p-3"
              onSubmit={(event) => {
                event.preventDefault()
                void act(true)
              }}
            >
              <p className="text-xs text-text-muted">{t('wallpapers.privacy')}</p>
              <fieldset
                disabled={working || disabled || !active}
                className="min-w-0 space-y-3 disabled:opacity-50"
              >
                {(['title', 'description'] as const).map((key) => (
                  <label key={key} className="block space-y-1 text-xs">
                    <span>{t(`wallpapers.fields.${key}`)}</span>
                    <input
                      name={key}
                      className={inputClass}
                      required={key === 'title'}
                      maxLength={key === 'title' ? 100 : 500}
                      value={form[key]}
                      onChange={(event) => {
                        const value = event.target.value
                        setForm((previous) => ({
                          ...previous,
                          [key]: value,
                          ...(key === 'title' && !tagsEdited.current
                            ? { tags: suggestedTags(value).join(', ') }
                            : {})
                        }))
                      }}
                    />
                  </label>
                ))}
                <div className="space-y-1 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="wallpaper-tags">{t('wallpapers.fields.tags')}</label>
                    <button
                      type="button"
                      className="rounded px-1 py-1 text-xs text-text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
                      onClick={() => {
                        tagsEdited.current = true
                        const next = parseTags(
                          [...tags, ...suggestedTags(form.title)].join(', ')
                        ).join(', ')
                        if (next.length <= 200) setForm((previous) => ({ ...previous, tags: next }))
                      }}
                    >
                      {t('wallpapers.generateTags')}
                    </button>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-bg p-2 focus-within:border-accent">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-2 py-1 pr-1 pl-2"
                      >
                        <span className="min-w-0 break-words">{tag}</span>
                        <button
                          type="button"
                          aria-label={t('wallpapers.removeTag', { tag })}
                          title={t('wallpapers.removeTag', { tag })}
                          className="shrink-0 rounded p-1 text-text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
                          onClick={() => {
                            tagsEdited.current = true
                            setForm((previous) => ({
                              ...previous,
                              tags: tags.filter((value) => value !== tag).join(', ')
                            }))
                          }}
                        >
                          <X aria-hidden className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    <input
                      id="wallpaper-tags"
                      name="tags"
                      value={tagInput}
                      maxLength={200}
                      placeholder={t('wallpapers.tagPlaceholder')}
                      aria-describedby="wallpaper-tags-hint"
                      aria-invalid={tagsTooLong}
                      className="min-w-0 flex-1 basis-32 bg-transparent px-1 py-1.5 text-xs outline-none"
                      onChange={(event) => {
                        tagsEdited.current = true
                        setTagInput(event.target.value)
                      }}
                      onBlur={() => commitTags()}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return
                        if (event.key === 'Enter' || event.key === ',') {
                          event.preventDefault()
                          commitTags()
                        } else if (event.key === 'Backspace' && !tagInput) {
                          tagsEdited.current = true
                          setForm((previous) => ({
                            ...previous,
                            tags: tags.slice(0, -1).join(', ')
                          }))
                        }
                      }}
                      onPaste={(event) => {
                        const value = event.clipboardData.getData('text')
                        if (!/[,\n]/.test(value)) return
                        event.preventDefault()
                        const next = tagInput + value
                        if (parseTags([form.tags, next].join(', ')).join(', ').length > 200) {
                          setTagInput(next)
                        } else commitTags(next)
                      }}
                    />
                  </div>
                  <p
                    id="wallpaper-tags-hint"
                    className={tagsTooLong ? 'text-danger' : 'text-text-muted'}
                  >
                    {t(tagsTooLong ? 'wallpapers.tagsTooLong' : 'wallpapers.tagsHint')}
                  </p>
                </div>
                <label className="block space-y-1 text-xs">
                  <span>{t('wallpapers.fields.credit')}</span>
                  <input
                    name="credit"
                    className={inputClass}
                    maxLength={100}
                    value={form.credit}
                    onChange={(event) => setForm({ ...form, credit: event.target.value })}
                  />
                </label>
                <label className="block space-y-1 text-xs">
                  <span>{t('wallpapers.fields.license')}</span>
                  <select
                    name="license"
                    className={`${inputClass} min-w-0`}
                    required
                    value={licenseChoice}
                    onChange={(event) => {
                      const value = event.target.value
                      setLicenseChoice(value)
                      setForm({ ...form, license: value === 'other' ? '' : value })
                    }}
                  >
                    <option value="" disabled>
                      {t('wallpapers.licenses.placeholder')}
                    </option>
                    {LICENSES.map((license) => (
                      <option key={license} value={license}>
                        {t(`wallpapers.licenses.${license}`)}
                      </option>
                    ))}
                  </select>
                </label>
                {licenseChoice === 'other' && (
                  <label className="block space-y-1 text-xs">
                    <span>{t('wallpapers.permission')}</span>
                    <input
                      name="permission"
                      className={inputClass}
                      required
                      maxLength={500}
                      value={form.license}
                      onChange={(event) => setForm({ ...form, license: event.target.value })}
                    />
                  </label>
                )}
                <p className="text-xs text-text-muted">{t('wallpapers.licenseHint')}</p>
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
                    !active ||
                    tagsTooLong ||
                    !form.rightsConsent ||
                    !form.title.trim() ||
                    !form.license.trim()
                  }
                >
                  {t(working ? 'wallpapers.working' : 'wallpapers.send')}
                </Button>
              </fieldset>
            </form>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="order-last w-full px-4 pb-4 text-xs text-danger">
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
