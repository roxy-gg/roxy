import { memo } from 'react'
import { MultiFileDiff } from '@pierre/diffs/react'
import type { ToolDiff } from '@shared/types'

/**
 * The diff renders inside a shadow root, so the app's global scrollbar rules in
 * `main.css` never reach it and @pierre/diffs' own handle stays transparent
 * until the diff is hovered — on a narrow pane that reads as "no scrollbar".
 * This restores the app's scrollbar look inside the shadow root using the same
 * tokens, so themes stay defined in one place. Only the handle is restyled; the
 * track sizing is the library's.
 */
const SCROLLBAR_CSS = `
  [data-code]::-webkit-scrollbar-thumb {
    background: var(--color-border-strong);
    border-radius: 9999px;
    border: 2px solid transparent;
    background-clip: content-box;
  }
  [data-code]::-webkit-scrollbar-thumb:hover {
    background: var(--color-text-subtle);
    background-clip: content-box;
  }
`

/**
 * Before/after file diff for a write/edit tool card, rendered with
 * @pierre/diffs (Shiki syntax highlighting, isolated in shadow DOM). This is a
 * default export so it can be lazy-loaded — Shiki only ships when a diff card
 * is actually expanded. Wrapped in `memo` so it never re-highlights on an
 * unrelated parent re-render (its props are plain strings).
 */
function FileDiffView({ path, before, after }: ToolDiff): JSX.Element {
  const name = path.split(/[\\/]/).pop() || path
  return (
    <div style={{ ['--diffs-font-size' as string]: '12px' }}>
      <MultiFileDiff
        oldFile={{ name, contents: before }}
        newFile={{ name, contents: after }}
        // Highlight synchronously on the main thread. The default worker pool
        // can't bundle/spawn its worker in the Electron + Vite renderer, and its
        // async init was racing on first mount — the card opened blank until you
        // re-clicked it. Our content is size-capped upstream, so main-thread
        // highlighting is a bounded, one-time cost on expand.
        disableWorkerPool
        options={{
          theme: { dark: 'pierre-dark', light: 'pierre-light' },
          themeType: 'dark',
          diffStyle: 'unified',
          diffIndicators: 'bars',
          // The tool card already shows the file name — drop the diff's own header.
          disableFileHeader: true,
          // Long lines scroll sideways instead of wrapping, so line numbers and
          // +/- indicators stay aligned in a narrow pane.
          overflow: 'scroll',
          // Performance for large files: render only the changed hunks (+ a few
          // context lines) instead of every unchanged line, and bound how much
          // Shiki tokenizes (huge / minified files degrade to plain text
          // instead of locking up).
          expandUnchanged: false,
          collapsedContextThreshold: 3,
          tokenizeMaxLineLength: 2000,
          tokenizeMaxLength: 200_000,
          unsafeCSS: SCROLLBAR_CSS
        }}
      />
    </div>
  )
}

export default memo(FileDiffView)
