import { useEffect, useRef, useState } from 'react'
import { RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceInspectorApi } from '@shared/workspace-inspector'
import { api } from '../lib/api'
import type { WorkspaceSelection } from './WorkspaceInspector'
import { FileIcon } from './FileIcon'

export function WorkspaceMediaPreview({
  sessionId,
  selection,
  onBack
}: {
  sessionId: string
  selection: WorkspaceSelection
  onBack: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [result, setResult] = useState<Awaited<
    ReturnType<WorkspaceInspectorApi['preview']>
  > | null>(null)
  const [revision, setRevision] = useState(0)
  const [failed, setFailed] = useState(false)
  const [actualSize, setActualSize] = useState(false)
  const [dimensions, setDimensions] = useState('')
  const back = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    back.current?.focus()
  }, [])
  useEffect(() => {
    let cancelled = false
    setResult(null)
    setFailed(false)
    setDimensions('')
    void api.workspace
      .preview(sessionId, selection.rootId, selection.path)
      .then((value) => {
        if (!cancelled) setResult(value)
      })
      .catch(() => {
        if (!cancelled) setResult({ ok: false, reason: 'unavailable' })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, selection.rootId, selection.path, revision])

  const media = result?.ok ? result : null
  return (
    <div
      data-workspace-canvas
      data-workspace-media
      className="absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col bg-bg"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation()
          onBack()
        }
      }}
    >
      <div className="workspace-file-toolbar titlebar reserve-controls-right flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          ref={back}
          type="button"
          onClick={onBack}
          title={t('common.close')}
          aria-label={t('common.close')}
          className="press-scale shrink-0 rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <FileIcon path={selection.path} />
        <span title={selection.path} className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {selection.path}
        </span>
        {media?.kind === 'image' && !failed && (
          <button
            type="button"
            onClick={() => setActualSize(!actualSize)}
            title={t(actualSize ? 'inspector.fitImage' : 'inspector.actualSize')}
            aria-label={t(actualSize ? 'inspector.fitImage' : 'inspector.actualSize')}
            aria-pressed={actualSize}
            className="press-scale shrink-0 rounded p-1 text-text-muted hover:bg-white/5"
          >
            {actualSize ? <ZoomOut className="h-3.5 w-3.5" /> : <ZoomIn className="h-3.5 w-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => setRevision((value) => value + 1)}
          title={t('inspector.reload')}
          aria-label={t('inspector.reload')}
          className="press-scale shrink-0 rounded p-1 text-text-muted hover:bg-white/5"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
      {selection.comparison && (
        <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-text-subtle">
          {t('inspector.mediaWorkingFile')}
        </p>
      )}
      {!result ? (
        <p className="p-4 text-xs text-text-subtle">{t('inspector.loading')}</p>
      ) : !result.ok || failed ? (
        <p role="status" className="p-4 text-xs text-text-muted">
          {failed ? t('inspector.mediaFailed') : !result.ok && t(`inspector.${result.reason}`)}
        </p>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-media-viewport>
          {result.kind === 'image' ? (
            <div
              className="flex h-full min-h-full min-w-full p-4"
              style={{
                backgroundImage:
                  'conic-gradient(var(--color-border) 25%, transparent 0 50%, var(--color-border) 0 75%, transparent 0)',
                backgroundSize: '16px 16px'
              }}
            >
              <img
                src={result.url}
                alt={selection.path}
                onLoad={(event) =>
                  setDimensions(
                    `${event.currentTarget.naturalWidth} x ${event.currentTarget.naturalHeight}`
                  )
                }
                onError={() => setFailed(true)}
                className={
                  actualSize
                    ? 'm-auto max-w-none shrink-0 object-contain'
                    : 'm-auto max-h-full max-w-full object-contain'
                }
                style={actualSize ? { width: 'auto', height: 'auto' } : undefined}
              />
            </div>
          ) : result.kind === 'pdf' ? (
            <iframe
              src={result.url}
              title={selection.path}
              onError={() => setFailed(true)}
              className="h-full w-full border-0"
            />
          ) : (
            <div className="flex h-full min-h-0 items-center justify-center p-4">
              {result.kind === 'video' ? (
                <video
                  src={result.url}
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={selection.path}
                  onError={() => setFailed(true)}
                  className="max-h-full w-full rounded bg-black"
                />
              ) : (
                <audio
                  src={result.url}
                  controls
                  preload="metadata"
                  aria-label={selection.path}
                  onError={() => setFailed(true)}
                  className="w-full max-w-lg"
                />
              )}
            </div>
          )}
        </div>
      )}
      {media && (
        <div className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border px-3 text-[10px] text-text-subtle">
          <span className="min-w-0 truncate font-mono">
            {media.mime}
            {dimensions && ` | ${dimensions}`}
          </span>
          <span className="shrink-0 tabular-nums">
            {new Intl.NumberFormat(undefined, {
              style: 'unit',
              unit: 'byte',
              unitDisplay: 'narrow',
              notation: 'compact',
              maximumFractionDigits: 1
            }).format(media.size)}
          </span>
        </div>
      )}
    </div>
  )
}
