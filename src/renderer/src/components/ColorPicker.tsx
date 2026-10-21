import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { isSafeCssValue } from '@shared/theme'
import { formatColor, hsvaToRgba, parseCssColor, rgbaToHsva, type Hsva } from '../lib/color'
import { useMenuAnchor } from '../lib/useMenuAnchor'
import { cn } from '../lib/cn'

const POPOVER_W = 232

/** Shown behind translucent colors so alpha reads as alpha, not as a muddy fill. */
const CHECKER =
  'repeating-conic-gradient(rgba(128,128,128,0.35) 0% 25%, transparent 0% 50%) 0 0 / 8px 8px'

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

/**
 * A draggable 2D/1D surface. Pointer capture keeps the drag alive when the
 * cursor leaves the element, which is what makes a small slider usable.
 */
function useDrag(onMove: (x: number, y: number) => void): {
  ref: React.RefObject<HTMLDivElement>
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
  }
} {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const report = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    onMove(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height))
  }
  return {
    ref,
    handlers: {
      onPointerDown: (e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        report(e)
      },
      onPointerMove: (e) => {
        if (dragging.current) report(e)
      },
      onPointerUp: (e) => {
        dragging.current = false
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    }
  }
}

/**
 * A color swatch that opens a picker.
 *
 * `value` is any CSS color a theme may hold. The picker emits `#rrggbb` (or
 * `rgba()` once opacity drops below 1) -- the formats theme files already use --
 * but a value typed into the text field is passed through untouched, so someone
 * who wants `oklch(...)` keeps it.
 */
export function ColorPicker({
  value,
  label,
  onChange,
  shape = 'square'
}: {
  value: string
  /** Names the control for assistive tech and the hover title. */
  label: string
  onChange: (next: string) => void
  /** `dot` matches the small round swatches on a theme card. */
  shape?: 'square' | 'dot'
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const anchor = useMenuAnchor(rootRef, open, POPOVER_W, {
    gap: 8,
    side: 'bottom',
    maxHeight: 380,
    fixed: true
  })

  // HSV is held locally rather than re-derived from `value` on every render:
  // hue is undefined for greys and saturation for black, so a round trip
  // through hex would snap the hue handle to red the moment you drag to the
  // edge of the square.
  const [hsva, setHsva] = useState<Hsva>(() =>
    rgbaToHsva(parseCssColor(value) ?? { r: 0, g: 0, b: 0, a: 1 })
  )
  const emitted = useRef(value)
  const [draft, setDraft] = useState(value)

  // Follow outside changes (the JSON was edited, a different theme loaded) but
  // not the echo of our own emit, which would fight the drag in progress.
  useEffect(() => {
    if (value === emitted.current) return
    emitted.current = value
    setDraft(value)
    const parsed = parseCssColor(value)
    if (parsed) setHsva(rgbaToHsva(parsed))
  }, [value])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const emit = (next: Hsva): void => {
    setHsva(next)
    const text = formatColor(hsvaToRgba(next))
    emitted.current = text
    setDraft(text)
    onChange(text)
  }

  const commitDraft = (): void => {
    const text = draft.trim()
    if (!text || !isSafeCssValue(text)) {
      setDraft(value)
      return
    }
    const parsed = parseCssColor(text)
    if (!parsed) {
      setDraft(value)
      return
    }
    setHsva(rgbaToHsva(parsed))
    if (text !== value) {
      emitted.current = text
      onChange(text)
    }
  }

  const sv = useDrag((x, y) => emit({ ...hsva, s: x, v: 1 - y }))
  const hue = useDrag((x) => emit({ ...hsva, h: x * 360 }))
  const alpha = useDrag((x) => emit({ ...hsva, a: Math.round(x * 100) / 100 }))

  const pure = formatColor(hsvaToRgba({ h: hsva.h, s: 1, v: 1, a: 1 }))
  const opaque = formatColor(hsvaToRgba({ ...hsva, a: 1 }))

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        title={label}
        aria-label={t('themes.pickColor', { name: label })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'press-scale block cursor-pointer overflow-hidden border outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          shape === 'dot'
            ? 'h-4 w-4 rounded-full border-border hover:border-border-strong'
            : 'h-6 w-6 rounded-md border-border-strong'
        )}
        style={{ background: CHECKER }}
      >
        <span className="block h-full w-full" style={{ background: value }} />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="dialog"
            aria-label={t('themes.pickColor', { name: label })}
            className="animate-pop-in fixed z-[100] flex origin-top-left flex-col gap-3 overflow-y-auto sq-frame sq-xl sq-fill-elevated sq-ring edge edge-strong edge-panel rounded-xl border border-border bg-elevated p-3 shadow-float"
            style={anchor}
          >
            {/* Saturation (x) / brightness (y) */}
            <div
              ref={sv.ref}
              {...sv.handlers}
              className="relative h-32 w-full cursor-crosshair touch-none rounded-lg"
              style={{
                backgroundColor: pure,
                backgroundImage:
                  'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)'
              }}
            >
              <span
                className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
                style={{
                  left: `${hsva.s * 100}%`,
                  top: `${(1 - hsva.v) * 100}%`,
                  background: opaque
                }}
              />
            </div>

            <Slider
              label={t('themes.colorHue')}
              drag={hue}
              position={hsva.h / 360}
              track="linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)"
              thumb={pure}
              now={Math.round(hsva.h)}
              max={360}
            />
            <Slider
              label={t('themes.colorOpacity')}
              drag={alpha}
              position={hsva.a}
              track={`linear-gradient(to right, transparent, ${opaque}), ${CHECKER}`}
              thumb={formatColor(hsvaToRgba(hsva))}
              now={Math.round(hsva.a * 100)}
              max={100}
            />

            <input
              value={draft}
              spellCheck={false}
              autoComplete="off"
              aria-label={t('themes.colorValue')}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitDraft()
                }
              }}
              className={cn(
                'h-8 w-full rounded-lg border border-border bg-surface-2 px-2 font-mono text-xs text-text outline-none',
                'focus:border-accent/70'
              )}
            />
          </div>,
          document.body
        )}
    </div>
  )
}

function Slider({
  label,
  drag,
  position,
  track,
  thumb,
  now,
  max
}: {
  label: string
  drag: ReturnType<typeof useDrag>
  position: number
  track: string
  thumb: string
  now: number
  max: number
}): JSX.Element {
  return (
    <div
      ref={drag.ref}
      {...drag.handlers}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={now}
      className="relative h-3 w-full cursor-pointer touch-none rounded-full"
      style={{ background: track }}
    >
      <span
        className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
        style={{ left: `${position * 100}%`, background: thumb }}
      />
    </div>
  )
}
