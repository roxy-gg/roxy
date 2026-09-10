import { useCallback } from 'react'
import { CanvasSurface, type CanvasLayoutContext } from '../../canvas/CanvasSurface'
import { Builder } from '../../canvas/builder'
import { layoutDiffViewer } from './layout'
import { createDiffState } from './model'

export interface DiffViewerProps {
  path: string
  before: string
  after: string
  height?: number
}

/** Read-only historical comparison. No file/store dependency and no implicit saves. */
export function DiffViewer({ path, before, after, height = 540 }: DiffViewerProps): JSX.Element {
  const buildScene = useCallback(
    (context: CanvasLayoutContext) => {
      let state = context.view.diffs.get('diff')
      if (
        !state ||
        state.document.before !== before ||
        state.document.after !== after ||
        state.document.path !== path
      ) {
        state = createDiffState(path, before, after)
        context.view.diffs.set('diff', state)
      }
      const builder = new Builder(context.metrics, context.theme, { value: 0 }, context.t)
      const used = layoutDiffViewer(
        builder,
        'diff',
        state,
        context.view,
        0,
        0,
        context.width,
        Math.max(80, context.height - 110)
      )
      return { width: context.width, height: used, blocks: [builder.finish('diff', 0, used)] }
    },
    [path, before, after]
  )
  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border"
      style={{ height }}
    >
      <CanvasSurface sceneKey={path} buildScene={buildScene} followTail={false} />
    </div>
  )
}
