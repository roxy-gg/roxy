import * as monaco from 'monaco-editor/editor.js'
import 'monaco-editor/features/register.all.js'
// Monaco's feature barrel does not register these core keyboard/controllers.
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js'
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js'
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/languages/definitions/register.all.js'
import 'monaco-editor/languages/features/json/register.js'
import 'monaco-editor/languages/features/css/register.js'
import 'monaco-editor/languages/features/html/register.js'
import {
  typescriptDefaults,
  javascriptDefaults,
  ScriptTarget,
  JsxEmit
} from 'monaco-editor/languages/features/typescript/register.js'
import type { WorkspaceInspectorApi } from '@shared/workspace-inspector'
import { api } from './api'
import i18n from '../i18n'

self.MonacoEnvironment = {
  async getWorker(_moduleId, label) {
    // Lazy inline workers also work from packaged Electron's file:// renderer.
    const { default: Worker } = await (label === 'typescript' || label === 'javascript'
      ? import('monaco-editor/languages/features/typescript/ts.worker.js?worker&inline')
      : label === 'json'
        ? import('monaco-editor/languages/features/json/json.worker.js?worker&inline')
        : label === 'css' || label === 'scss' || label === 'less'
          ? import('monaco-editor/languages/features/css/css.worker.js?worker&inline')
          : label === 'html' || label === 'handlebars' || label === 'razor'
            ? import('monaco-editor/languages/features/html/html.worker.js?worker&inline')
            : import('monaco-editor/editor/editor.worker.js?worker&inline'))
    return new Worker()
  }
}

for (const defaults of [typescriptDefaults, javascriptDefaults]) {
  defaults.setCompilerOptions({
    target: ScriptTarget.ESNext,
    allowJs: true,
    jsx: JsxEmit.ReactJSX,
    allowNonTsExtensions: true
  })
  // The worker has open documents, not the project's node_modules/tsconfig.
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, onlyVisible: true })
}

export { monaco }

type SaveResult = Awaited<ReturnType<WorkspaceInspectorApi['write']>>
export interface EditorDocument {
  model: monaco.editor.ITextModel
  sessionId: string
  rootId: string
  path: string
  revision: string
  baseline: string
  dirty: boolean
  saving: boolean
  reloading: boolean
  mounted: boolean
  error: Exclude<SaveResult, { ok: true }>['reason'] | null
  mixedEol: boolean
  viewState: monaco.editor.ICodeEditorViewState | null
  changed: () => void
  subscription: monaco.IDisposable
}

// Unsaved documents survive file/session navigation, but never go into localStorage.
export const editorDocuments = new Map<string, EditorDocument>()
let discarding = false
let confirming = false
window.addEventListener('beforeunload', (event) => {
  if (discarding || ![...editorDocuments.values()].some((entry) => entry.dirty || entry.saving))
    return
  event.preventDefault()
  event.returnValue = ''
  if (confirming) return
  confirming = true
  void api.workspace
    .confirmDiscard(
      i18n.t('inspector.closeUnsaved'),
      i18n.t('inspector.closeDiscard'),
      i18n.t('inspector.closeKeep')
    )
    .then((confirmed) => {
      if (confirmed) {
        discarding = true
        window.close()
      }
    })
    .catch(() => {})
    .finally(() => {
      confirming = false
    })
})
export const editorDocumentKey = (sessionId: string, rootId: string, path: string): string =>
  JSON.stringify([sessionId, rootId, path])

export function releaseEditorDocument(entry: EditorDocument): void {
  // Effect cleanup/setup can replay in StrictMode. Evict only after a new mount
  // has had a chance to acquire the model, and never while an operation owns it.
  queueMicrotask(() => {
    if (entry.mounted || entry.dirty || entry.saving || entry.reloading) return
    const key = editorDocumentKey(entry.sessionId, entry.rootId, entry.path)
    if (editorDocuments.get(key) !== entry) return
    editorDocuments.delete(key)
    entry.subscription.dispose()
    entry.model.dispose()
  })
}

export function openEditorDocument(
  sessionId: string,
  rootId: string,
  path: string,
  content: string,
  revision: string
): EditorDocument {
  const key = editorDocumentKey(sessionId, rootId, path)
  const existing = editorDocuments.get(key)
  if (existing) return existing
  const basename = path.split('/').pop()!.toLowerCase()
  const language =
    monaco.languages
      .getLanguages()
      .find(
        (language) =>
          language.filenames?.some((name) => name.toLowerCase() === basename) ||
          language.extensions?.some((extension) => basename.endsWith(extension))
      )?.id ?? (basename === '.editorconfig' ? 'ini' : 'plaintext')
  const model = monaco.editor.createModel(
    content,
    language,
    monaco.Uri.from({
      scheme: 'file',
      path: `/roxy/${encodeURIComponent(sessionId)}/${encodeURIComponent(rootId)}/${path}`
    })
  )
  model.detectIndentation(true, language === 'python' ? 4 : 2)
  const entry: EditorDocument = {
    model,
    sessionId,
    rootId,
    path,
    revision,
    baseline: model.getValue(undefined, true),
    dirty: false,
    saving: false,
    reloading: false,
    mounted: false,
    error: null,
    mixedEol: hasMixedEol(content),
    viewState: null,
    changed: () => {},
    subscription: model.onDidChangeContent(() => {
      entry.dirty = model.getValue(undefined, true) !== entry.baseline
      entry.changed()
    })
  }
  editorDocuments.set(key, entry)
  return entry
}

export function hasMixedEol(content: string): boolean {
  return /\r(?!\n)/.test(content) || (/\r\n/.test(content) && /(?<!\r)\n/.test(content))
}

export async function saveEditorDocument(entry: EditorDocument): Promise<void> {
  if (!entry.dirty || entry.saving || entry.reloading || entry.mixedEol) return
  const content = entry.model.getValue(undefined, true)
  entry.saving = true
  entry.error = null
  entry.changed()
  try {
    const result = await api.workspace.write(
      entry.sessionId,
      entry.rootId,
      entry.path,
      content,
      entry.revision
    )
    if (result.ok) {
      entry.revision = result.revision
      entry.baseline = content
      entry.dirty = entry.model.getValue(undefined, true) !== content
      window.dispatchEvent(new Event('focus'))
    } else entry.error = result.reason
  } catch {
    entry.error = 'unavailable'
  } finally {
    entry.saving = false
    entry.changed()
    releaseEditorDocument(entry)
  }
}
