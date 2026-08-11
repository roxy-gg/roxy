/**
 * List windowing — which slice of a long list a scroll viewport can see.
 *
 * Pure math, no DOM, so the invariant that actually matters ("every row the
 * user can see is a row we mounted") can be exercised directly instead of
 * eyeballed in a running app; see test/shared.ts.
 *
 * This exists for the model picker. Gateway providers report 300-600 models
 * each and the picker lists every connected provider at once, so it mounted
 * ~450 rows — roughly 5,000 DOM nodes and ~250ms of blocking work — in the same
 * frame that its open animation started. Windowing makes the cost a function of
 * the VIEWPORT (~20 rows) rather than the catalog.
 *
 * The design constraint is that row heights must be known WITHOUT measuring:
 * measuring means mounting, and mounting everything is the thing we're avoiding.
 * So callers pass a height per row and we prefix-sum it once.
 */

/**
 * Rows to render beyond each edge of the viewport.
 *
 * Enough that a flick-scroll doesn't expose blank space before the next render
 * lands; small enough to stay a rounding error on the mount cost.
 */
export const OVERSCAN = 6

/**
 * Cumulative row offsets: `offsets[i]` is the top of row `i`, and the last
 * entry is the total height. One entry longer than `heights`.
 */
export function rowOffsets(heights: ArrayLike<number>): Float64Array {
  const acc = new Float64Array(heights.length + 1)
  for (let i = 0; i < heights.length; i++) acc[i + 1] = acc[i] + heights[i]
  return acc
}

/** Index of the row containing `y` (the first row whose bottom is past it). */
function rowAt(offsets: Float64Array, count: number, y: number): number {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1] <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The half-open range `[first, last)` of rows to mount for a viewport showing
 * `[scrollTop, scrollTop + viewportHeight)`, widened by `overscan` each way.
 *
 * Guaranteed: every row intersecting the viewport is inside the range, and the
 * range is bounded by the viewport size rather than the list length. Render it
 * between two spacer elements of `offsets[first]` and `total - offsets[last]`
 * so the scrollbar still describes the whole list.
 */
export function visibleRange(
  offsets: Float64Array,
  count: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number = OVERSCAN
): { first: number; last: number } {
  if (count <= 0) return { first: 0, last: 0 }
  // A negative scrollTop is real: macOS rubber-banding reports it, and it must
  // clamp to the top rather than index out of the array.
  const top = Math.max(0, scrollTop)
  const first = Math.max(0, rowAt(offsets, count, top) - overscan)
  const last = Math.min(
    count,
    rowAt(offsets, count, top + Math.max(0, viewportHeight)) + 1 + overscan
  )
  return { first, last }
}
