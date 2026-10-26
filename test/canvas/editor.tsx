import './bridge'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/assets/main.css'
import '../../src/renderer/src/i18n'
import FileEditor from '../../src/renderer/src/components/FileEditor'
import { editorDocuments, monaco } from '../../src/renderer/src/lib/workspace-editor'
import { getTypeScriptWorker } from 'monaco-editor/languages/features/typescript/register.js'

let content = 'const greeting = "hello";\ngreeting.'
let revision = 'first'
let discard = false
Object.assign(window.roxy, {
  workspace: {
    read: async () => ({ ok: true, before: '', after: content, revision }),
    write: async (
      _session: string,
      _root: string,
      _path: string,
      value: string,
      expected: string
    ) => {
      if (revision !== expected) return { ok: false, reason: 'changed' }
      content = value
      revision = crypto.randomUUID()
      return { ok: true, revision }
    },
    confirmDiscard: async () => discard
  }
})
Object.assign(window, {
  __editorRuntime: {
    monaco,
    editorDocuments,
    getTypeScriptWorker,
    content: () => content,
    allowDiscard: () => {
      discard = true
    }
  }
})
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FileEditor
      sessionId="fixture"
      selection={{ rootId: 'fixture', path: 'example.ts', comparison: false }}
      snapshot={null}
      onBack={() => {}}
    />
  </StrictMode>
)
