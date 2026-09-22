import { useEffect, useRef, useState, type DragEventHandler } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  TriangleAlert,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Unplug,
  ArrowUp,
  ArrowDown
} from 'lucide-react'
import type { ConnectedProvider } from '@shared/types'
import { api } from '../lib/api'
import { useRoxyStore } from '../lib/store'
import { ProviderLogo } from '../lib/providerLogos'
import { cn } from '../lib/cn'
import { Button, Input } from './ui'
import { ModelVisibility } from './ModelVisibility'
import { ContextMenuSurface, ContextMenuRow, ContextMenuSeparator } from './ContextMenu'

export function ProviderAccount({
  provider,
  active,
  onAddAccount,
  onReconnect,
  onDragStart,
  onMoveUp,
  onMoveDown
}: {
  provider: ConnectedProvider
  active: boolean
  onAddAccount: () => void
  onReconnect: () => void
  onDragStart: DragEventHandler<HTMLSpanElement>
  onMoveUp?: () => void
  onMoveDown?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const refreshProviders = useRoxyStore((s) => s.refreshProviders)
  const ensureModels = useRoxyStore((s) => s.ensureModels)
  const ensureHiddenModels = useRoxyStore((s) => s.ensureHiddenModels)
  const catalog = useRoxyStore((s) => s.modelCatalog[provider.id])
  const tried = useRoxyStore((s) => s.modelsTried[provider.id])
  const loading = useRoxyStore((s) => s.modelsLoading[provider.id])
  const catalogError = useRoxyStore((s) => s.modelErrors[provider.id])
  const reauth = useRoxyStore((s) => s.copilotNeedsReauthentication[provider.id])
  const hiddenModels = useRoxyStore((s) => s.hiddenModels)
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [name, setName] = useState(provider.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const needsReconnect =
    catalogError === 'authentication' ||
    reauth ||
    (!provider.hasCredential && provider.auth !== 'none')
  const total = catalog?.length ?? 0
  const hidden = catalog?.filter((m) => hiddenModels.has(`${provider.id}:${m.id}`)).length ?? 0
  const summary = needsReconnect
    ? t('settings.providers.needsReconnect')
    : loading || (!catalog && !tried)
      ? t('settings.models.loading')
      : catalogError
        ? t('settings.models.unavailable')
        : total === 0
          ? t('settings.models.noneAvailable')
          : hidden === 0
            ? t('settings.models.allShown', { count: total })
            : t('settings.models.someHidden', { shown: total - hidden, total, hidden })

  useEffect(() => {
    void ensureHiddenModels()
    void ensureModels(provider.id)
  }, [provider, ensureModels, ensureHiddenModels])
  useEffect(() => {
    if (menu) {
      menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    }
  }, [menu])
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
  }, [confirming])

  const closeMenu = (): void => {
    setMenu(null)
  }
  const finishEditing = (): void => {
    setEditing(false)
    headerRef.current?.focus()
  }
  const saveName = async (): Promise<void> => {
    if (busy || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api.providers.rename(provider.id, name.trim())
      await refreshProviders()
      finishEditing()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const disconnect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.providers.disconnect(provider.id)
      await refreshProviders()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-provider-account={provider.id}
      className={cn(
        'overflow-hidden rounded-xl border bg-surface',
        needsReconnect ? 'border-danger/30' : 'border-border'
      )}
    >
      <div className="flex items-center gap-1 px-2">
        <span
          draggable={!!(onMoveUp || onMoveDown)}
          onDragStart={onDragStart}
          title={t('settings.providers.reorder')}
          className={cn(
            'flex h-9 w-5 shrink-0 items-center justify-center text-text-subtle',
            onMoveUp || onMoveDown ? 'cursor-grab active:cursor-grabbing' : 'invisible'
          )}
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <button
          ref={headerRef}
          type="button"
          aria-expanded={open}
          aria-controls={`account-models-${provider.id}`}
          aria-label={t('settings.providers.manageModels', { name: provider.name })}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-4 pr-2 text-left hover:bg-white/[0.025] focus-visible:outline-2 focus-visible:outline-accent/60"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2">
            <ProviderLogo id={provider.seedId} name={provider.name} size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-sm font-medium text-text" title={provider.name}>
                {provider.name}
              </span>
              {active && (
                <span className="text-[10px] font-medium text-text-subtle">
                  {t('settings.providers.active')}
                </span>
              )}
            </span>
            {provider.identity && (
              <span
                className="mt-0.5 block truncate text-xs text-text-muted"
                title={provider.identity}
              >
                {provider.identity}
              </span>
            )}
            {!needsReconnect && (
              <span className="mt-1 block text-xs text-text-subtle">{summary}</span>
            )}
          </span>
          <ChevronRight
            className={cn('h-3.5 w-3.5 shrink-0 text-text-subtle', open && 'rotate-90')}
          />
        </button>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          disabled={busy}
          aria-label={t('settings.providers.accountActions', { name: provider.name })}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenu(menu ? null : { x: rect.right - 208, y: rect.bottom + 4 })
          }}
          className="press-scale flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text focus-visible:outline-2 focus-visible:outline-accent/60"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
      {needsReconnect && !confirming && (
        <div
          role="group"
          aria-labelledby={`account-warning-${provider.id}`}
          className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-danger/20 bg-danger/[0.06] px-4 py-3"
        >
          <div role="status" className="flex min-w-0 flex-[1_1_15rem] items-start gap-2.5">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p id={`account-warning-${provider.id}`} className="text-xs font-medium text-danger">
                {t('settings.providers.needsReconnect')}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-text-muted">
                {t(
                  provider.auth === 'api-key'
                    ? 'settings.providers.reconnectKeyHint'
                    : 'settings.providers.reconnectSignInHint'
                )}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            disabled={busy}
            onClick={onReconnect}
            className="ml-auto shrink-0 border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 focus-visible:outline-2 focus-visible:outline-danger/60"
          >
            {t(
              provider.auth === 'api-key'
                ? 'settings.providers.updateKey'
                : 'settings.providers.reconnect'
            )}
          </Button>
        </div>
      )}
      {menu && (
        <ContextMenuSurface {...menu} height={233} onClose={closeMenu}>
          <div
            ref={menuRef}
            role="menu"
            aria-label={t('settings.providers.accountActions', { name: provider.name })}
            onKeyDown={(e) => {
              const items = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
              )
              const index = items.indexOf(document.activeElement as HTMLButtonElement)
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                e.preventDefault()
                items[
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                ]?.focus()
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                closeMenu()
                triggerRef.current?.focus()
              } else if (e.key === 'Tab') {
                e.preventDefault()
                closeMenu()
                triggerRef.current?.focus()
              }
            }}
          >
            <ContextMenuRow
              label={t('settings.providers.rename')}
              role="menuitem"
              icon={Pencil}
              onSelect={() => {
                closeMenu()
                setName(provider.name)
                setError(null)
                setConfirming(false)
                setEditing(true)
              }}
            />
            <ContextMenuRow
              label={t('settings.providers.reconnect')}
              role="menuitem"
              icon={RefreshCw}
              onSelect={() => {
                closeMenu()
                triggerRef.current?.focus()
                onReconnect()
              }}
            />
            <ContextMenuRow
              label={t('settings.providers.addAnother')}
              role="menuitem"
              icon={Plus}
              onSelect={() => {
                closeMenu()
                triggerRef.current?.focus()
                onAddAccount()
              }}
            />
            {(onMoveUp || onMoveDown) && (
              <>
                <ContextMenuSeparator />
                <ContextMenuRow
                  label={t('settings.providers.moveUp')}
                  role="menuitem"
                  icon={ArrowUp}
                  disabled={!onMoveUp}
                  onSelect={() => {
                    closeMenu()
                    triggerRef.current?.focus()
                    onMoveUp?.()
                  }}
                />
                <ContextMenuRow
                  label={t('settings.providers.moveDown')}
                  role="menuitem"
                  icon={ArrowDown}
                  disabled={!onMoveDown}
                  onSelect={() => {
                    closeMenu()
                    triggerRef.current?.focus()
                    onMoveDown?.()
                  }}
                />
              </>
            )}
            <ContextMenuSeparator />
            <ContextMenuRow
              label={t('settings.providers.disconnect')}
              role="menuitem"
              icon={Unplug}
              danger
              onSelect={() => {
                closeMenu()
                setError(null)
                setEditing(false)
                setConfirming(true)
              }}
            />
          </div>
        </ContextMenuSurface>
      )}
      {editing && (
        <form
          className="flex flex-wrap items-center gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault()
            void saveName()
          }}
        >
          <Input
            autoFocus
            aria-label={t('settings.providers.accountName')}
            value={name}
            maxLength={100}
            disabled={busy}
            className="min-w-32 flex-1"
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !busy) finishEditing()
            }}
          />
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>
            {t('common.save')}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={finishEditing}>
            {t('common.cancel')}
          </Button>
        </form>
      )}
      {confirming && (
        <div
          className="border-t border-border p-4"
          role="group"
          aria-label={t('settings.providers.disconnectTitle', { name: provider.name })}
        >
          <p className="text-sm font-medium text-text">
            {t('settings.providers.disconnectTitle', { name: provider.name })}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">
            {t('settings.providers.disconnectHint')}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              ref={confirmRef}
              disabled={busy}
              onClick={() => {
                setConfirming(false)
                triggerRef.current?.focus()
              }}
              className="rounded-lg px-3 text-xs text-text-muted hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-accent/60"
            >
              {t('common.cancel')}
            </button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void disconnect()}>
              {t('settings.providers.disconnect')}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="px-4 pb-3 text-xs text-danger">
          {error}
        </p>
      )}
      <div hidden={!open} id={`account-models-${provider.id}`} className="border-t border-border">
        {!needsReconnect && (catalogError || total === 0) && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-text-subtle">
            <span role="status">{summary}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => void ensureModels(provider.id)}
            >
              {t('models.retry')}
            </Button>
          </div>
        )}
        {total > 0 && (
          <ModelVisibility
            providerId={provider.id}
            seedId={provider.seedId}
            providerName={provider.name}
            open={open}
          />
        )}
      </div>
    </div>
  )
}
