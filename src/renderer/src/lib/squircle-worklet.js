/**
 * Squircle paint worklet.
 *
 * Runs inside the CSS Paint API (Houdini) worklet scope -- a separate, isolated
 * JS realm with no DOM. It is NOT bundled as a module; `lib/squircle.ts` imports
 * this file's *source* with `?raw` and hands it to `CSS.paintWorklet.addModule()`
 * through a blob: URL. That avoids shipping a separate asset and keeps it working
 * identically in `electron-vite dev` (http://) and in production (file://), where
 * a relative worklet URL is fragile.
 *
 * Why a worklet at all: `border-radius` draws a quarter *circle*, which meets the
 * straight edge with a sudden jump in curvature -- the corner reads as "stuck on"
 * and, at the small radii a dense app UI uses, faintly cheap. A superellipse
 * (squircle) ramps curvature in continuously, the same shape Apple uses for icons
 * and sheets. Chromium only gained a native `corner-shape: superellipse()` in 139;
 * this app runs on 130, so we paint the shape ourselves.
 *
 * Two painters, because an element needs one or the other, never both:
 *   paint(squircle-mask) -> `mask-image`. Clips the element to the shape, so every
 *                           existing `bg-*` / `hover:bg-*` utility keeps working
 *                           untouched. Clips descendants and outer shadows too.
 *   paint(squircle-box)  -> `background-image`. Draws the fill (`--sq-fill`) and/or
 *                           the hairline (`--sq-ring`) as the element's own
 *                           background. Nothing is clipped, so this is the one for
 *                           anything with a real `box-shadow` or `overflow-hidden`.
 *
 * Both are painted over the *border* box (`mask-origin` defaults there, and CSS
 * sets `background-origin: border-box`), so `size` is the full border box and the
 * border width can be read straight off the element.
 */

/* Exponent of the superellipse |x/r|^n + |y/r|^n = 1. n=2 is a plain circle;
   Apple's icon grid sits around 5. 4 keeps the corner visibly continuous while
   staying tight enough not to read as a chamfer at the 6-24px radii used here. */
const N = 4

/* Line segments per corner. The curve is flattest near its ends, so 14 is already
   sub-pixel at these radii even at 2x DPR, and Chromium caches the painted image
   per geometry -- this runs on resize, not per frame. */
const STEPS = 14

const EXP = 2 / N

/**
 * Trace a superellipse-cornered rectangle. `inset` shrinks the box on all sides,
 * which is how the hairline gets centred inside the border area rather than half
 * hanging outside it (where a mask, or the element's own edge, would clip it).
 */
function squirclePath(ctx, width, height, radius, inset) {
  const x0 = inset
  const y0 = inset
  const x1 = width - inset
  const y1 = height - inset
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return

  // A radius past half the shorter side has no room left; clamp so short/wide
  // boxes degrade to a pill instead of self-intersecting.
  const r = Math.max(0, Math.min(radius - inset, w / 2, h / 2))

  ctx.beginPath()
  if (r === 0) {
    ctx.rect(x0, y0, w, h)
    ctx.closePath()
    return
  }

  // Unit superellipse offsets. Math.pow of a value in [0,1] stays in [0,1], so
  // both offsets stay within r.
  const dx = (t) => r * Math.pow(Math.cos(t), EXP)
  const dy = (t) => r * Math.pow(Math.sin(t), EXP)
  const step = Math.PI / 2 / STEPS

  ctx.moveTo(x0 + r, y0)
  ctx.lineTo(x1 - r, y0)
  // top-right: sweep from the top edge round to the right edge
  for (let i = STEPS; i >= 0; i--) {
    const t = i * step
    ctx.lineTo(x1 - r + dx(t), y0 + r - dy(t))
  }
  ctx.lineTo(x1, y1 - r)
  // bottom-right
  for (let i = 0; i <= STEPS; i++) {
    const t = i * step
    ctx.lineTo(x1 - r + dx(t), y1 - r + dy(t))
  }
  ctx.lineTo(x0 + r, y1)
  // bottom-left
  for (let i = STEPS; i >= 0; i--) {
    const t = i * step
    ctx.lineTo(x0 + r - dx(t), y1 - r + dy(t))
  }
  ctx.lineTo(x0, y0 + r)
  // top-left
  for (let i = 0; i <= STEPS; i++) {
    const t = i * step
    ctx.lineTo(x0 + r - dx(t), y0 + r - dy(t))
  }
  ctx.closePath()
}

/** Registered `<length>` properties arrive as CSSUnitValue; be defensive anyway,
 *  since an unregistered one would come through as an unparsed token list. */
function px(styleMap, name, fallback) {
  const value = styleMap.get(name)
  if (!value) return fallback
  const n = typeof value.value === 'number' ? value.value : parseFloat(String(value))
  return Number.isFinite(n) ? n : fallback
}

/** Colors serialize to something canvas accepts (`rgb(...)` / `oklab(...)`). */
function color(styleMap, name) {
  const value = styleMap.get(name)
  return value ? String(value).trim() : 'transparent'
}

/**
 * True when a color would actually put ink on the canvas.
 *
 * `transparent` computes to `rgba(0, 0, 0, 0)`, but a `color-mix()` landing on
 * zero alpha serializes as `color(srgb 0 0 0 / 0)` instead, so comparing against
 * the two spellings of "transparent" misses it and we pay for a stroke that
 * paints nothing. Match the alpha component instead of the whole string.
 */
function opaque(value) {
  if (!value || value === 'transparent' || value === 'none') return false
  return !/(?:\/|,)\s*0(?:\.0*)?\s*\)$/.test(value)
}

/**
 * Blend two colors without parsing either.
 *
 * Canvas has no color API, but it accepts any CSS color *string*, and
 * `color-mix()` is a CSS color. So the arithmetic can be handed to the engine,
 * which also means it works for every form the Typed OM produces (`rgba()`,
 * `color(srgb ...)`, `oklch()`) rather than just the ones a hand-written parser
 * would cover. Chromium shipped `color-mix()` in 111; this app runs on 130.
 *
 * `srgb` specifically, not `oklab`: this mixes a translucent highlight into a
 * translucent hairline, and sRGB is what the CSS tokens were authored against.
 */
function mix(a, b, percent) {
  return `color-mix(in srgb, ${a} ${percent}%, ${b})`
}

/* `registerPaint` throws on a duplicate name, which happens when the dev server
   hot-reloads (the worklet scope outlives the page's JS). Swallowing it stops HMR
   from turning into an unhandled rejection that silently kills squircles. */
function register(name, ctor) {
  try {
    registerPaint(name, ctor)
  } catch {
    /* already registered */
  }
}

register(
  'squircle-mask',
  class {
    static get inputProperties() {
      return ['--sq-r']
    }
    paint(ctx, size, styleMap) {
      squirclePath(ctx, size.width, size.height, px(styleMap, '--sq-r', 8), 0)
      // Any opaque color does -- only the alpha channel is read as the mask.
      ctx.fillStyle = '#fff'
      ctx.fill()
    }
  }
)

register(
  'squircle-box',
  class {
    static get inputProperties() {
      return [
        '--sq-r',
        '--sq-fill',
        '--sq-ring',
        '--sq-dash',
        '--sq-bevel',
        '--sq-bevel-span',
        'border-top-width'
      ]
    }
    paint(ctx, size, styleMap) {
      const r = px(styleMap, '--sq-r', 12)

      // Skipped when `--sq-fill` is left at its `transparent` default, i.e. the
      // element is keeping its own `bg-*` and only wants the hairline.
      const fill = color(styleMap, '--sq-fill')
      if (opaque(fill)) {
        squirclePath(ctx, size.width, size.height, r, 0)
        ctx.fillStyle = fill
        ctx.fill()
      }

      const w = px(styleMap, 'border-top-width', 0)
      if (w <= 0) return
      // Centre the stroke on the inner half of the border area so the whole
      // hairline lands inside the shape -- a stroke centred on the outline would
      // lose its outer half and render at half opacity.
      squirclePath(ctx, size.width, size.height, r, w / 2)
      ctx.lineWidth = w
      // `border-style: dashed` is painted by the UA along the *rectangle*, so its
      // dashes get sliced by the shape at every corner. `--sq-dash` re-creates it
      // along the squircle path instead. 0 (the default) means a solid stroke.
      const dash = px(styleMap, '--sq-dash', 0)
      if (dash > 0) ctx.setLineDash([dash, dash])

      /* The edge is painted with exactly ONE stroke, and that is the whole
       * trick.
       *
       * The obvious way to add a top-lit bevel is a second stroke over the same
       * path. It looks right in the middle of a straight edge and wrong
       * everywhere else, because the two strokes' anti-aliased coverage
       * COMPOSITES: a boundary pixel the rasteriser gives 50% coverage gets
       * painted twice and ends up far more opaque than either color asked for.
       * On straight runs every pixel is either fully in or fully out, so nothing
       * shows; around a corner almost every pixel is partial, so the corner
       * silently darkens and the curve reads as chunky and stair-stepped.
       * Measured on an `sq-lg` corner: peak alpha 26 -> 44, i.e. 69% brighter
       * than the tokens specify, and the pixel-to-pixel roughness along the arc
       * rose from 36 to 55.
       *
       * Blending the two colors FIRST and stroking once fixes it exactly:
       * coverage is applied a single time, so anti-aliasing works as designed
       * and the painted color is the one the CSS actually names.
       *
       * The gradient therefore runs from bevel-over-ring at the top edge to the
       * plain ring by `--sq-bevel-span`, rather than from bevel to transparent.
       * `--sq-bevel` is pre-mixed over `--sq-ring` at its own alpha so the top
       * still reads as "ring plus highlight", which is what the two-stroke
       * version was approximating before it over-applied it.
       *
       * The span is a length, not a percentage, on purpose: the highlight should
       * die out over roughly the same physical distance on a 32px button as on a
       * 300px card, the way real light does. A percentage would stretch it and
       * make tall panels look uniformly frosted. */
      const ring = color(styleMap, '--sq-ring')
      const bevel = color(styleMap, '--sq-bevel')
      const ringVisible = opaque(ring)
      const bevelVisible = opaque(bevel)
      if (!ringVisible && !bevelVisible) return

      const span = px(styleMap, '--sq-bevel-span', 0)
      // 0 means "no explicit span" -> fade across the whole element.
      const end = span > 0 ? Math.min(span, size.height) : size.height

      if (!bevelVisible || end <= 0) {
        // No highlight (a recessed control, or a light theme): a plain hairline.
        ctx.strokeStyle = ring
      } else {
        const base = ringVisible ? ring : `rgb(from ${bevel} r g b / 0)`
        const ramp = ctx.createLinearGradient(0, 0, 0, end)
        // 60/40 rather than a flat over-composite: the highlight is strongest
        // right at the lit edge and most of it is gone within the span, which is
        // how a real surface falls off. Ending ON the ring color (not on
        // transparent) is what keeps this a single stroke.
        ramp.addColorStop(0, mix(bevel, base, 60))
        ramp.addColorStop(1, base)
        ctx.strokeStyle = ramp
      }
      ctx.stroke()
    }
  }
)
