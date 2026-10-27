import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, RotateCcw, Save, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceSnapshot } from '@shared/workspace-inspector'
import { api } from '../lib/api'
import { observeTheme, readTheme, type CanvasTheme } from '../canvas/theme'
import {
  editorDocumentKey,
  editorDocuments,
  hasMixedEol,
  monaco,
  openEditorDocument,
  releaseEditorDocument,
  saveEditorDocument,
  type EditorDocument
} from '../lib/workspace-editor'
import type { WorkspaceSelection } from './WorkspaceInspector'
import { FileIcon } from './FileIcon'

export default function FileEditor({
  sessionId,
  selection,
  snapshot,
  onBack
}: {
  sessionId: string
  selection: WorkspaceSelection
  snapshot: WorkspaceSnapshot | null
  onBack: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const key = editorDocumentKey(sessionId, selection.rootId, selection.path)
  const [entry, setEntry] = useState<EditorDocument | null>(() => editorDocuments.get(key) ?? null)
  const [, render] = useState(0)
  const [failure, setFailure] = useState<'unavailable' | 'tooLarge' | 'binary' | 'unsafe' | null>(
    null
  )
  const [copied, setCopied] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const label = useRef(t('inspector.editorLabel', { path: selection.path }))

  useEffect(() => {
    let cancelled = false
    const current = editorDocuments.get(key)
    const revision = current?.revision
    void api.workspace
      .read(sessionId, selection.rootId, selection.path, false)
      .then((result) => {
        if (cancelled) return
        if (!result.ok || !result.revision) {
          setFailure(result.ok ? 'unavailable' : result.reason)
          return
        }
        const document = editorDocuments.get(key)
        // A save completed while this read was in flight. Its result takes precedence.
        if (document?.saving || document?.reloading || (document && document.revision !== revision))
          return
        setFailure(null)
        if (document) {
          if (document.revision !== result.revision) {
            if (document.dirty) document.error = 'changed'
            else {
              document.model.setValue(result.after)
              document.model.detectIndentation(
                true,
                document.model.getLanguageId() === 'python' ? 4 : 2
              )
              document.baseline = document.model.getValue(undefined, true)
              document.revision = result.revision
              document.mixedEol = hasMixedEol(result.after)
              document.dirty = false
              document.error = null
              editor.current?.updateOptions({ readOnly: document.mixedEol })
            }
            document.changed()
          }
        } else
          setEntry(
            openEditorDocument(
              sessionId,
              selection.rootId,
              selection.path,
              result.after,
              result.revision
            )
          )
      })
      .catch(() => {
        if (!cancelled) setFailure('unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, selection.rootId, selection.path, key, snapshot])

  useEffect(() => {
    if (!entry || !host.current) return
    entry.mounted = true
    entry.changed = () => render((value) => value + 1)
    const instance = monaco.editor.create(host.current, {
      model: entry.model,
      automaticLayout: true,
      fontSize: 12,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
      autoIndent: 'full',
      detectIndentation: true,
      readOnly: entry.mixedEol || entry.reloading,
      ariaLabel: label.current,
      renderLineHighlight: 'gutter',
      overviewRulerBorder: false,
      stickyScroll: { enabled: false },
      fixedOverflowWidgets: true,
      unicodeHighlight: { ambiguousCharacters: false },
      bracketPairColorization: { enabled: true }
    })
    editor.current = instance
    const theme = (value: CanvasTheme): void => {
      const canvas = document
        .createElement('canvas')
        .getContext('2d', { willReadFrequently: true })!
      const color = (value: string): string => {
        canvas.fillStyle = value
        canvas.fillRect(0, 0, 1, 1)
        return (
          '#' +
          Array.from(canvas.getImageData(0, 0, 1, 1).data)
            .slice(0, 3)
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
        )
      }
      const p = value.palette
      monaco.editor.defineTheme('roxy', {
        base: value.appearance === 'light' ? 'vs' : 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': color(p.bg),
          'editor.foreground': color(p.text),
          'editorLineNumber.foreground': color(p.textSubtle),
          'editorLineNumber.activeForeground': color(p.textMuted),
          'editorCursor.foreground': color(p.accent),
          'editor.selectionBackground': color(p.accent) + '44',
          'editorWidget.background': color(p.surface),
          'editorWidget.border': color(p.border)
        }
      })
      monaco.editor.setTheme('roxy')
      instance.updateOptions({ fontFamily: value.mono })
    }
    theme(readTheme())
    const stopTheme = observeTheme(theme)
    instance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => void saveEditorDocument(entry)
    )
    if (entry.viewState) instance.restoreViewState(entry.viewState)
    instance.focus()
    return () => {
      entry.viewState = instance.saveViewState()
      entry.changed = () => {}
      entry.mounted = false
      stopTheme()
      instance.dispose()
      editor.current = null
      releaseEditorDocument(entry)
    }
  }, [entry, key])

  useEffect(() => {
    if (entry) editor.current?.updateOptions({ readOnly: entry.mixedEol || entry.reloading })
  }, [entry, entry?.mixedEol, entry?.reloading])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  const reload = async (): Promise<void> => {
    if (!entry || entry.saving || entry.reloading) return
    if (
      entry.dirty &&
      !(await api.workspace.confirmDiscard(
        t('inspector.discardConfirm'),
        t('inspector.discard'),
        t('common.cancel')
      ))
    )
      return
    // Lock edits during the asynchronous reload, so typing cannot be discarded by a late read.
    entry.reloading = true
    entry.changed()
    editor.current?.updateOptions({ readOnly: true })
    try {
      const result = await api.workspace.read(sessionId, selection.rootId, selection.path, false)
      if (!result.ok || !result.revision) {
        setFailure(result.ok ? 'unavailable' : result.reason)
        return
      }
      entry.model.setValue(result.after)
      entry.model.detectIndentation(true, entry.model.getLanguageId() === 'python' ? 4 : 2)
      entry.baseline = entry.model.getValue(undefined, true)
      entry.revision = result.revision
      entry.dirty = false
      entry.error = null
      entry.mixedEol = hasMixedEol(result.after)
      editor.current?.updateOptions({ readOnly: entry.mixedEol })
      setFailure(null)
      entry.changed()
      editor.current?.focus()
    } catch {
      setFailure('unavailable')
    } finally {
      entry.reloading = false
      editor.current?.updateOptions({ readOnly: entry.mixedEol })
      entry.changed()
      releaseEditorDocument(entry)
    }
  }

  return (
    <div
      data-workspace-canvas
      data-workspace-editor
      className="absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col bg-bg"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation()
          onBack()
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          if (entry) void saveEditorDocument(entry)
        }
      }}
    >
      <div className="workspace-file-toolbar titlebar reserve-controls-right flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
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
        {entry?.dirty && (
          <span
            role="status"
            title={t('inspector.unsaved')}
            aria-label={t('inspector.unsaved')}
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
          />
        )}
        {entry && (
          <>
            <button
              type="button"
              disabled={entry.saving || entry.reloading}
              title={t('inspector.reload')}
              aria-label={t('inspector.reload')}
              onClick={() => void reload()}
              className="press-scale shrink-0 rounded p-1 text-text-muted hover:bg-white/5 disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={t('inspector.copy')}
              aria-label={t('inspector.copy')}
              onClick={() =>
                void navigator.clipboard
                  .writeText(entry.model.getValue(undefined, true))
                  .then(() => setCopied(true))
                  .catch(() => {})
              }
              className="press-scale shrink-0 rounded p-1 text-text-muted hover:bg-white/5"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              disabled={!entry.dirty || entry.saving || entry.reloading || entry.mixedEol}
              title={t('inspector.saveShortcut')}
              aria-label={t('inspector.save')}
              onClick={() => void saveEditorDocument(entry)}
              className="press-scale shrink-0 rounded p-1 text-text-muted hover:bg-white/5 disabled:opacity-40"
            >
              {entry.saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
            </button>
          </>
        )}
      </div>
      {(failure || entry?.error || entry?.mixedEol) && (
        <p role="status" className="shrink-0 border-b border-border px-3 py-2 text-xs text-warning">
          {entry?.error === 'changed'
            ? t('inspector.fileChanged')
            : entry?.error
              ? t('inspector.saveFailed', { reason: t(`inspector.${entry.error}`) })
              : failure
                ? t(`inspector.${failure}`)
                : t('inspector.mixedEol')}
        </p>
      )}
      {!entry && !failure && (
        <p className="p-4 text-xs text-text-subtle">{t('inspector.loading')}</p>
      )}
      <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
      {entry && (
        <div className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border px-3 text-[10px] text-text-subtle">
          <span className="min-w-0 truncate">
            {t(
              entry.saving
                ? 'inspector.saving'
                : entry.dirty
                  ? 'inspector.draftRetained'
                  : 'inspector.saved'
            )}
          </span>
          <span className="shrink-0 font-mono">
            {entry.model.getLanguageId()} | {entry.model.getEOL() === '\r\n' ? 'CRLF' : 'LF'}
          </span>
        </div>
      )}
    </div>
  )
}
