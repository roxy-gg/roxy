# Canvas Diff Viewer

`DiffViewer` is a read-only comparison of two snapshots. It does not read from the
workspace, write files, or mutate tool history.

```tsx
import { DiffViewer } from './components/diff/DiffViewer'

export function Comparison() {
  return <DiffViewer path="src/example.ts" before={original} after={modified} height={540} />
}
```

The same `layoutDiffViewer` primitive renders inside chat tool cards, including
subagent cards. Both hosts use `CanvasSurface` for pointer handling, selection,
clipboard menus, keyboard scrolling, and native outer scrolling.

- Unified and split projections with aligned line numbers and intraline changes.
- Expand individual unchanged regions or show the full file.
- Wrap long lines by default; optional horizontal scrolling stays inside the diff.
- Wheel, Page Up/Down, Home/End, and draggable scrollbars reach every row.
- Copy the original, modified source, patch, or a selected range.
- Locally bundled, lazy-loaded Shiki tokens with dark/light palettes; plain text
  remains usable if a grammar cannot load.

`model.ts` owns immutable source snapshots and line offsets. It uses jsdiff with
time/edit-distance budgets; an exhausted budget produces a labelled coarse
comparison instead of dropping data or allocating an unbounded edit trace.
`layout.ts` caches measured rows independently of scrolling and paints only the
inner viewport. Changing layout controls increments the view revision; theme,
width, and syntax changes invalidate measurement as needed.

## Validation

- `npm run smoke:diff`: pure model, projections, patch export, selection, links,
  and clipping checks.
- `npm run smoke:canvas`: real Electron mouse/keyboard regression suite; starts
  its own Vite server on 3114 and uses temporary user data. With a harness already
  running, set `CANVAS_TEST_URL=http://localhost:3114/` for that test process.
- `npm run canvas`: interactive transcript and standalone diff fixtures.
