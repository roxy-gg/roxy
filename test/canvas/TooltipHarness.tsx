import { useState } from 'react'
import { Tooltip, updateTooltip } from '../../src/renderer/src/components/AppTooltip'
import { ContributionGraph } from '../../src/renderer/src/components/ContributionGraph'

export default function TooltipHarness(): JSX.Element {
  const [title, setTitle] = useState<string | undefined>('Initial action')
  Object.assign(window, { __setTooltipTitle: setTitle })
  return (
    <div className="p-4 text-text">
      <div data-tooltip-bounds style={{ height: 80, position: 'fixed', top: 0, right: 0 }}>
        <button id="bounded" title="Browser toolbar action" style={{ marginTop: 45 }}>
          Toolbar
        </button>
      </div>
      <button id="native" title={title}>
        <svg width="24" height="24" />
      </button>
      <div
        id="unrelated-scroll"
        style={{ position: 'fixed', left: 400, top: 220, width: 100, height: 40, overflow: 'auto' }}
      >
        <div style={{ height: 400 }}>Unrelated content</div>
      </div>
      <div
        id="trigger-scroll"
        style={{ position: 'fixed', left: 400, top: 120, width: 200, height: 60, overflow: 'auto' }}
      >
        <button id="scroll-trigger" title="Scrollable action" style={{ height: 40 }}>
          Scroll action
        </button>
        <div style={{ height: 400 }} />
      </div>
      <button
        id="named"
        aria-label="Named action"
        title="Named action"
        style={{ position: 'fixed', left: 280, top: 20 }}
      >
        Named
      </button>
      <span id="existing-description" className="sr-only">
        Existing description
      </span>
      <button
        id="described"
        aria-label="Described action"
        title="Additional detail"
        aria-describedby="existing-description"
        style={{ position: 'fixed', left: 280, top: 60 }}
      >
        Described
      </button>
      <button id="second" title="Second action">
        Second
      </button>
      <dialog id="tooltip-dialog">
        <button id="dialog-trigger" title="Modal action">
          Modal
        </button>
      </dialog>
      <Tooltip
        content={
          <span>
            Rich description <kbd>Ctrl</kbd>
          </span>
        }
      >
        <button id="rich" aria-label="Rich action">
          Rich
        </button>
      </Tooltip>
      <Tooltip content="Disabled description">
        <button id="disabled" disabled>
          Disabled
        </button>
      </Tooltip>
      <div
        id="virtual"
        style={{ width: 240, height: 60, marginTop: 24 }}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const right = event.clientX > rect.left + 120
          updateTooltip(event.currentTarget, {
            key: right ? 'right' : 'left',
            content: right ? 'Right region' : 'Left region',
            rect: new DOMRect(rect.left + (right ? 120 : 0), rect.top, 120, 60)
          })
        }}
        onPointerLeave={(event) => updateTooltip(event.currentTarget, null)}
      >
        Virtual regions
      </div>
      <ContributionGraph
        data={{
          days: [{ date: '2026-10-22', count: 3, level: 1 }],
          total: 3,
          max: 3,
          activeDays: 1,
          longestStreak: 1,
          currentStreak: 1
        }}
      />
      <button
        id="edge"
        title={'Long tooltip '.repeat(60)}
        style={{ position: 'fixed', right: 0, bottom: 0 }}
      >
        Edge
      </button>
    </div>
  )
}
