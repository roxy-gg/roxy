/**
 * Icons for the canvas transcript.
 *
 * The DOM transcript uses lucide-react, which renders an <svg> per icon. Canvas
 * cannot mount a React component, so the same icons are carried here as their
 * raw geometry — lifted verbatim from `lucide-react@1.21.0`'s icon nodes (ISC,
 * same package the app already depends on) so a card's icon is identical to the
 * one it replaces rather than a lookalike.
 *
 * Each icon is a 24x24 stroked outline: `stroke-width: 2`, round caps and
 * joins, no fill. That is lucide's contract, and reproducing it exactly is what
 * makes these read as the same icon set at 14px.
 *
 * Path2D is built once per icon and cached. Building it per frame would reparse
 * the path data on every scroll tick.
 */

/** One primitive from a lucide icon node. */
type Shape =
  | { k: 'p'; d: string }
  | { k: 'c'; cx: number; cy: number; r: number }
  | { k: 'e'; cx: number; cy: number; rx: number; ry: number }
  | { k: 'r'; x: number; y: number; w: number; h: number; rx: number }
  | { k: 'l'; x1: number; y1: number; x2: number; y2: number }

const p = (d: string): Shape => ({ k: 'p', d })
const c = (cx: number, cy: number, r: number): Shape => ({ k: 'c', cx, cy, r })
const e = (cx: number, cy: number, rx: number, ry: number): Shape => ({ k: 'e', cx, cy, rx, ry })
const r = (x: number, y: number, w: number, h: number, rx = 0): Shape => ({
  k: 'r',
  x,
  y,
  w,
  h,
  rx
})
const l = (x1: number, y1: number, x2: number, y2: number): Shape => ({ k: 'l', x1, y1, x2, y2 })

/**
 * The icon set. Names match the lucide component the DOM used, so a tool's icon
 * can be traced back to `TOOL_ICON` in the old ToolCall without guesswork.
 */
const ICONS = {
  terminal: [p('M12 19h8'), p('m4 17 6-6-6-6')],
  fileText: [
    p(
      'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z'
    ),
    p('M14 2v5a1 1 0 0 0 1 1h5'),
    p('M10 9H8'),
    p('M16 13H8'),
    p('M16 17H8')
  ],
  code: [p('m16 18 6-6-6-6'), p('m8 6-6 6 6 6')],
  listTree: [
    p('M8 5h13'),
    p('M13 12h8'),
    p('M13 19h8'),
    p('M3 10a2 2 0 0 0 2 2h3'),
    p('M3 5v12a2 2 0 0 0 2 2h3')
  ],
  search: [p('m21 21-4.34-4.34'), c(11, 11, 8)],
  globe: [c(12, 12, 10), p('M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'), p('M2 12h20')],
  hammer: [
    p('m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9'),
    p('m18 15 4-4'),
    p(
      'm21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5'
    )
  ],
  camera: [
    p(
      'M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z'
    ),
    c(12, 13, 3)
  ],
  scanText: [
    p('M3 7V5a2 2 0 0 1 2-2h2'),
    p('M17 3h2a2 2 0 0 1 2 2v2'),
    p('M21 17v2a2 2 0 0 1-2 2h-2'),
    p('M7 21H5a2 2 0 0 1-2-2v-2'),
    p('M7 8h8'),
    p('M7 12h10'),
    p('M7 16h6')
  ],
  repeat: [
    p('m17 2 4 4-4 4'),
    p('M3 11v-1a4 4 0 0 1 4-4h14'),
    p('m7 22-4-4 4-4'),
    p('M21 13v1a4 4 0 0 1-4 4H3')
  ],
  wrench: [
    p(
      'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z'
    )
  ],
  chevronRight: [p('m9 18 6-6-6-6')],
  check: [p('M20 6 9 17l-5-5')],
  square: [r(3, 3, 18, 18, 2)],
  triangleAlert: [
    p('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'),
    p('M12 9v4'),
    p('M12 17h.01')
  ],
  brain: [
    p('M12 18V5'),
    p('M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4'),
    p('M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5'),
    p('M17.997 5.125a4 4 0 0 1 2.526 5.77'),
    p('M18 18a4 4 0 0 0 2-7.464'),
    p('M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517'),
    p('M6 18a4 4 0 0 1-2-7.464'),
    p('M6.003 5.125a4 4 0 0 0-2.526 5.77')
  ],
  user: [p('M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'), c(12, 7, 4)],
  image: [r(3, 3, 18, 18, 2), c(9, 9, 2), p('m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21')],
  filePen: [
    p(
      'M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34'
    ),
    p('M14 2v5a1 1 0 0 0 1 1h5'),
    p(
      'M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z'
    )
  ],
  folderOpen: [
    p(
      'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'
    )
  ],
  link: [
    p('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'),
    p('M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71')
  ],
  clock: [c(12, 12, 10), p('M12 6v6l4 2')],
  database: [e(12, 5, 9, 3), p('M3 5V19A9 3 0 0 0 21 19V5'), p('M3 12A9 3 0 0 0 21 12')],
  gitBranch: [p('M15 6a9 9 0 0 0-9 9V3'), c(18, 6, 3), c(6, 18, 3)],
  copy: [r(8, 8, 14, 14, 2), p('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')],
  externalLink: [
    p('M15 3h6v6'),
    p('M10 14 21 3'),
    p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')
  ],
  circleAlert: [c(12, 12, 10), l(12, 8, 12, 12), l(12, 16, 12.01, 16)],
  info: [c(12, 12, 10), p('M12 16v-4'), p('M12 8h.01')],
  sparkles: [
    p(
      'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z'
    ),
    p('M20 2v4'),
    p('M22 4h-4'),
    c(4, 20, 2)
  ],
  bot: [
    p('M12 8V4H8'),
    r(4, 8, 16, 12, 2),
    p('M2 14h2'),
    p('M20 14h2'),
    p('M15 13v2'),
    p('M9 13v2')
  ],
  settings: [
    p(
      'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915'
    ),
    c(12, 12, 3)
  ],
  bookOpen: [
    p('M12 7v14'),
    p(
      'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z'
    )
  ],
  network: [
    r(16, 16, 6, 6, 1),
    r(2, 16, 6, 6, 1),
    r(9, 2, 6, 6, 1),
    p('M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3'),
    p('M12 12V8')
  ],
  cpu: [
    p('M12 20v2'),
    p('M12 2v2'),
    p('M17 20v2'),
    p('M17 2v2'),
    p('M2 12h2'),
    p('M2 17h2'),
    p('M2 7h2'),
    p('M20 12h2'),
    p('M20 17h2'),
    p('M20 7h2'),
    p('M7 20v2'),
    p('M7 2v2'),
    r(4, 4, 16, 16, 2),
    r(8, 8, 8, 8, 1)
  ],
  key: [
    p('m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4'),
    p('m21 2-9.6 9.6'),
    c(7.5, 15.5, 5.5)
  ],
  shield: [
    p(
      'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'
    )
  ],
  play: [p('M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z')],
  trash: [
    p('M10 11v6'),
    p('M14 11v6'),
    p('M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'),
    p('M3 6h18'),
    p('M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2')
  ],
  cornerUpLeft: [p('M20 20v-7a4 4 0 0 0-4-4H4'), p('m9 14-5-5 5-5')],
  zap: [
    p(
      'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'
    )
  ]
} satisfies Record<string, Shape[]>

export type IconName = keyof typeof ICONS

const cache = new Map<IconName, Path2D>()

/** The icon as a Path2D in lucide's 24x24 box. Built once, then reused. */
export function iconPath(name: IconName): Path2D {
  const hit = cache.get(name)
  if (hit) return hit
  const path = new Path2D()
  for (const shape of ICONS[name]) {
    if (shape.k === 'p') path.addPath(new Path2D(shape.d))
    else if (shape.k === 'c') {
      const sub = new Path2D()
      sub.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2)
      path.addPath(sub)
    } else if (shape.k === 'e') {
      const sub = new Path2D()
      sub.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2)
      path.addPath(sub)
    } else if (shape.k === 'r') {
      const sub = new Path2D()
      // roundRect is in every Chromium the app ships on; the guard is for the
      // typecheck surface, not for a browser that lacks it.
      if (typeof sub.roundRect === 'function')
        sub.roundRect(shape.x, shape.y, shape.w, shape.h, shape.rx)
      else sub.rect(shape.x, shape.y, shape.w, shape.h)
      path.addPath(sub)
    } else {
      const sub = new Path2D()
      sub.moveTo(shape.x1, shape.y1)
      sub.lineTo(shape.x2, shape.y2)
      path.addPath(sub)
    }
  }
  cache.set(name, path)
  return path
}

/**
 * Draw an icon at `size` px, its top-left at (x, y).
 *
 * The stroke is scaled back by the same factor as the geometry so the outline
 * stays 2px-at-24 — i.e. visually 1.17px at 14px, which is what lucide looks
 * like in the DOM. Scaling the path without correcting the stroke is the usual
 * way canvas icons come out looking fat.
 */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  name: IconName,
  x: number,
  y: number,
  size: number,
  color: string,
  opts: { rotate?: number; opacity?: number } = {}
): void {
  const scale = size / 24
  ctx.save()
  if (opts.opacity !== undefined && opts.opacity < 1) ctx.globalAlpha *= opts.opacity
  if (opts.rotate) {
    ctx.translate(x + size / 2, y + size / 2)
    ctx.rotate(opts.rotate)
    ctx.translate(-size / 2, -size / 2)
  } else {
    ctx.translate(x, y)
  }
  ctx.scale(scale, scale)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke(iconPath(name))
  ctx.restore()
}

/** Filled variant — the cancel button's stop square uses `fill-current`. */
export function fillIcon(
  ctx: CanvasRenderingContext2D,
  name: IconName,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  const scale = size / 24
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(scale, scale)
  ctx.fillStyle = color
  ctx.fill(iconPath(name))
  ctx.restore()
}
