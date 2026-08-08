import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  Globe,
  Copy,
  ExternalLink,
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldAlert,
  X
} from 'lucide-react'
import type { PendingSnapshot, RelayImportResult, RelayStatus } from '@shared/relay'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

/**
 * Session Relay — the Settings surface.
 *
 * Two jobs: walk the user through installing the browser extension (which is
 * genuinely four manual steps in a browser we don't control), and be the place
 * a queued transfer gets approved.
 *
 * The approval prompt shows COUNTS, never values. Main deliberately keeps the
 * credentials until the user says yes, so there is nothing here to leak.
 */
export function SessionRelay(): JSX.Element {
  const [status, setStatus] = useState<RelayStatus | null>(null)
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async () => setStatus(await api.relay.status()), [])

  useEffect(() => {
    void refresh()
    // Main pushes on every state change (pairing, heartbeat, queued snapshot),
    // so the panel is live without polling.
    return api.relay.onState(setStatus)
  }, [refresh])

  const pending = status?.pending ?? []

  return (
    <div className="overflow-hidden sq sq-xl sq-ring rounded-xl border border-border bg-surface">
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-text">Session Relay</div>
            {status?.paired && (
              <span className="flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                {status.browser ?? 'Browser'} connected
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            Send a site&apos;s live session from Chrome, Edge or Brave into Roxy&apos;s browser, so
            you can debug a signed-in page without signing in again. Nothing transfers until you
            click send in the extension, and nothing is applied until you approve it here.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="press-scale shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          {status?.paired ? 'Manage' : 'Connect browser'}
        </button>
      </div>

      {pending.length > 0 && (
        <div className="border-t border-border">
          {pending.map((p) => (
            <PendingCard key={p.id} snapshot={p} />
          ))}
        </div>
      )}

      {open && (
        <SetupDialog
          status={status}
          onClose={() => setOpen(false)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  )
}

/** One queued transfer, awaiting yes/no. */
function PendingCard({ snapshot }: { snapshot: PendingSnapshot }): JSX.Element {
  const [choice, setChoice] = useState({
    cookies: true,
    localStorage: true,
    sessionStorage: snapshot.sessionStorageCount > 0
  })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RelayImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setResult(await api.relay.apply(snapshot.id, choice))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    const bits = [
      result.cookiesImported ? `${result.cookiesImported} cookies` : null,
      result.localStorageImported ? `${result.localStorageImported} localStorage` : null,
      result.sessionStorageImported ? `${result.sessionStorageImported} sessionStorage` : null
    ].filter(Boolean)
    return (
      <div className="p-4 text-xs">
        <div className="flex items-center gap-1.5 text-success">
          <Check className="h-3.5 w-3.5" />
          Imported {bits.length ? bits.join(', ') : 'nothing'} for {snapshot.origin}.
        </div>
        {result.cookiesSkippedPartitioned > 0 && (
          <p className="mt-1.5 text-text-muted">
            {result.cookiesSkippedPartitioned} partitioned{' '}
            {result.cookiesSkippedPartitioned === 1 ? 'cookie was' : 'cookies were'} skipped —
            Electron cannot store these in the right partition, so importing them would put them in
            the wrong one.
          </p>
        )}
        {result.errors.map((e, i) => (
          <p key={i} className="mt-1 text-danger">
            {e}
          </p>
        ))}
      </div>
    )
  }

  return (
    <div className="p-4">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-text">
            {snapshot.browser} wants to send a session to Roxy
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
            {snapshot.origin}
          </div>
        </div>
      </div>

      <div className="mt-2.5 space-y-1">
        <Pick
          label="Cookies"
          count={snapshot.cookieCount}
          checked={choice.cookies}
          onChange={(v) => setChoice((c) => ({ ...c, cookies: v }))}
        />
        <Pick
          label="Local storage"
          count={snapshot.localStorageCount}
          checked={choice.localStorage}
          onChange={(v) => setChoice((c) => ({ ...c, localStorage: v }))}
        />
        <Pick
          label="Session storage"
          count={snapshot.sessionStorageCount}
          checked={choice.sessionStorage}
          onChange={(v) => setChoice((c) => ({ ...c, sessionStorage: v }))}
        />
      </div>

      <p className="mt-2 text-[11px] text-text-subtle">
        Values are hidden and stay in Roxy&apos;s main process until you import.
      </p>

      {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void apply()}
          disabled={busy}
          className="press-scale flex-1 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-white/90 disabled:opacity-40"
        >
          {busy ? 'Importing…' : 'Import into Roxy'}
        </button>
        <button
          type="button"
          onClick={() => void api.relay.reject(snapshot.id)}
          disabled={busy}
          className="press-scale rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
        >
          Discard
        </button>
      </div>
    </div>
  )
}

function Pick({
  label,
  count,
  checked,
  onChange
}: {
  label: string
  count: number
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <label
      className={cn(
        'flex cursor-default items-center gap-2 text-xs',
        count === 0 ? 'text-text-subtle' : 'text-text-muted'
      )}
    >
      <input
        type="checkbox"
        checked={checked && count > 0}
        disabled={count === 0}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-[var(--color-accent)]"
      />
      {label}
      <span className="ml-auto font-mono text-[11px] tabular-nums">{count}</span>
    </label>
  )
}

/** Which browser's extensions page to send the user to. */
const BROWSERS = [
  { name: 'Chrome', url: 'chrome://extensions' },
  { name: 'Edge', url: 'edge://extensions' },
  { name: 'Brave', url: 'brave://extensions' }
] as const

/**
 * The four-step install, plus pairing.
 *
 * The steps are manual because loading an unpacked extension is: we cannot
 * click through another browser's UI. So the job here is to make each step
 * unambiguous and to do the parts we CAN automate (copying the folder,
 * revealing it, minting the code).
 */
function SetupDialog({
  status,
  onClose,
  onChanged
}: {
  status: RelayStatus | null
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  const [installed, setInstalled] = useState<{ path: string; version: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null)
  const [copied, setCopied] = useState(false)

  const paired = status?.paired ?? false

  const install = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setInstalled(await api.relay.installExtension())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const startPairing = async (): Promise<void> => {
    setError(null)
    try {
      const r = await api.relay.beginPairing()
      setPairing({ code: r.code, expiresAt: r.expiresAt })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // The code is short-lived; stop showing a dead one.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!pairing) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pairing])
  const secondsLeft = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0
  useEffect(() => {
    if (pairing && secondsLeft === 0) setPairing(null)
  }, [pairing, secondsLeft])

  // Pairing completing is pushed from main; close the code once it lands.
  useEffect(() => {
    if (paired && pairing) setPairing(null)
  }, [paired, pairing])

  const relayNotListening = status && !status.listening

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="max-h-full w-full max-w-lg overflow-y-auto sq sq-xl sq-ring rounded-xl border border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Globe className="h-4 w-4 text-text-muted" />
          <div className="text-sm font-medium text-text">
            {paired ? 'Session Relay' : 'Connect a browser'}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press-scale ml-auto flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {relayNotListening && (
          <div className="border-b border-border bg-danger/5 px-4 py-2.5 text-[11px] text-danger">
            The relay could not open port {status?.port}. Another app is probably using it — close
            it and restart Roxy.
          </div>
        )}

        {paired ? (
          <ManageBody status={status} onChanged={onChanged} onClose={onClose} />
        ) : (
          <div className="p-4">
            <Step n={1} title="Save the extension">
              <p className="text-xs text-text-muted">
                Roxy copies it to your Documents folder, where your browser can load it.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Btn onClick={() => void install()} busy={busy} primary={!installed}>
                  {installed ? 'Save again' : 'Save extension'}
                </Btn>
                {installed && (
                  <Btn onClick={() => void api.relay.revealExtension()}>
                    <FolderOpen className="h-3.5 w-3.5" /> Show folder
                  </Btn>
                )}
              </div>
              {installed && (
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-muted">
                    {installed.path}
                  </code>
                  <button
                    type="button"
                    title="Copy path"
                    onClick={() => {
                      void navigator.clipboard.writeText(installed.path)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                    className="press-scale flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              )}
            </Step>

            <Step n={2} title="Open your browser's extensions page">
              <div className="flex flex-wrap gap-2">
                {BROWSERS.map((b) => (
                  <Btn key={b.name} onClick={() => void navigator.clipboard.writeText(b.url)}>
                    <ExternalLink className="h-3.5 w-3.5" /> Copy {b.name} URL
                  </Btn>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-text-subtle">
                Browsers block other apps from opening <code>chrome://</code> pages, so paste the
                copied address into your browser&apos;s address bar.
              </p>
            </Step>

            <Step n={3} title="Turn on Developer mode">
              <p className="text-xs text-text-muted">
                The toggle is in the top-right of that page. It is what allows an extension to be
                loaded from a folder.
              </p>
            </Step>

            <Step n={4} title="Load unpacked, and pick the folder">
              <p className="text-xs text-text-muted">
                Click <strong className="font-medium text-text">Load unpacked</strong> and choose
                the folder from step 1. The Roxy icon appears in your toolbar.
              </p>
            </Step>

            <Step n={5} title="Pair it with Roxy" last>
              {pairing ? (
                <div>
                  <p className="text-xs text-text-muted">
                    Click the Roxy icon in your browser and enter this code:
                  </p>
                  <div className="mt-2 flex items-center gap-3">
                    <div className="rounded-lg border border-border bg-surface-2 px-4 py-2 font-mono text-2xl tracking-[0.3em] text-text">
                      {pairing.code}
                    </div>
                    <div className="text-[11px] text-text-subtle">
                      Expires in {secondsLeft}s
                      <button
                        type="button"
                        onClick={() => void startPairing()}
                        className="mt-1 flex items-center gap-1 text-text-muted hover:text-text"
                      >
                        <RefreshCw className="h-3 w-3" /> New code
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <Btn onClick={() => void startPairing()} primary>
                  Show pairing code
                </Btn>
              )}
            </Step>

            {error && <p className="mt-3 text-[11px] text-danger">{error}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

function ManageBody({
  status,
  onChanged,
  onClose
}: {
  status: RelayStatus | null
  onChanged: () => void
  onClose: () => void
}): JSX.Element {
  const last = status?.lastTransferAt
  const seen = status?.lastSeenAt
  const fmt = (t?: number): string => (t ? new Date(t).toLocaleString() : 'never')

  return (
    <div className="p-4">
      <dl className="space-y-2 text-xs">
        <Row label="Browser" value={status?.browser ?? '—'} />
        <Row label="Extension version" value={status?.extensionVersion || '—'} />
        <Row label="Extension ID" value={status?.extensionId ?? '—'} mono />
        <Row label="Last seen" value={fmt(seen)} />
        <Row label="Last transfer" value={fmt(last)} />
        <Row label="Listening on" value={`127.0.0.1:${status?.port ?? '—'}`} mono />
      </dl>

      <p className="mt-3 text-[11px] text-text-subtle">
        Transfers only happen when you click send in the extension, and only after you approve them
        here.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Btn
          onClick={async () => {
            await api.relay.installExtension()
            onChanged()
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" /> Update extension files
        </Btn>
        <Btn onClick={() => void api.relay.revealExtension()}>
          <FolderOpen className="h-3.5 w-3.5" /> Show folder
        </Btn>
        <Btn
          danger
          onClick={async () => {
            await api.relay.unpair()
            onChanged()
            onClose()
          }}
        >
          Disconnect
        </Btn>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-32 shrink-0 text-text-subtle">{label}</dt>
      <dd className={cn('min-w-0 truncate text-text-muted', mono && 'font-mono text-[11px]')}>
        {value}
      </dd>
    </div>
  )
}

function Step({
  n,
  title,
  children,
  last
}: {
  n: number
  title: string
  children: React.ReactNode
  last?: boolean
}): JSX.Element {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-[11px] font-medium text-text-muted">
          {n}
        </div>
        {!last && <div className="mt-1 w-px flex-1 bg-border" />}
      </div>
      <div className={cn('min-w-0 flex-1', last ? 'pb-0' : 'pb-5')}>
        <div className="text-xs font-medium text-text">{title}</div>
        <div className="mt-1.5">{children}</div>
      </div>
    </div>
  )
}

function Btn({
  children,
  onClick,
  primary,
  danger,
  busy
}: {
  children: React.ReactNode
  onClick: () => void
  primary?: boolean
  danger?: boolean
  busy?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'press-scale inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-40',
        primary
          ? 'bg-white text-black hover:bg-white/90'
          : danger
            ? 'border border-border text-danger hover:bg-danger/10'
            : 'border border-border text-text-muted hover:bg-surface-2 hover:text-text'
      )}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  )
}
