import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
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
    onPointerCancel: () => void
    onLostPointerCapture: () => void
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
      },
      // A cancelled gesture (touch interrupted, window blur) or capture taken
      // away never delivers `pointerup`; without these `dragging` would stay
      // true and the next hover would keep moving the handle.
      onPointerCancel: () => {
        dragging.current = false
      },
      onLostPointerCapture: () => {
        dragging.current = false
      }
    }
  }
}

/** Arrow-key step for a slider-like control; Shift moves ten times as far. */
const stepOf = (e: ReactKeyboardEvent, unit: number): number => (e.shiftKey ? unit * 10 : unit)

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
  disabled,
  disabledHint
}: {
  value: string
  /** Names the control for assistive tech and the hover title. */
  label: string
  onChange: (next: string) => void
  /** Show the color but don't open the picker. */
  disabled?: boolean
  /** Replaces the hover title while disabled, so the reason is visible. */
  disabledHint?: string
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

  // The close handlers below are registered once per open, so they would see
  // the `draft` / `value` of the render that opened the popover. Reading the
  // latest through a ref is what lets them commit what was actually typed.
  const latest = useRef({ draft, value, commit: () => {}, revert: () => {} })

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      // Clicking away keeps a typed value. The input's own `blur` would do this,
      // but the popover unmounts on this same event, so it can be gone first.
      latest.current.commit()
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      // Escape cancels: unlike a click away, it throws the pending text out.
      latest.current.revert()
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

  latest.current = { draft, value, commit: commitDraft, revert: () => setDraft(value) }

  const sv = useDrag((x, y) => emit({ ...hsva, s: x, v: 1 - y }))
  const hue = useDrag((x) => emit({ ...hsva, h: x * 360 }))
  const alpha = useDrag((x) => emit({ ...hsva, a: Math.round(x * 100) / 100 }))

  const pure = formatColor(hsvaToRgba({ h: hsva.h, s: 1, v: 1, a: 1 }))
  const opaque = formatColor(hsvaToRgba({ ...hsva, a: 1 }))

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        title={disabled && disabledHint ? disabledHint : label}
        aria-label={t('themes.pickColor', { name: label })}
        aria-haspopup="dialog"
        aria-expanded={open}
        // `aria-disabled` rather than `disabled`: it stays focusable and keeps
        // its hover title, which is where the reason is shown.
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) setOpen((v) => !v)
        }}
        className={cn(
          'block h-4 w-4 overflow-hidden rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          disabled
            ? 'cursor-not-allowed opacity-50'
            : 'press-scale cursor-pointer hover:border-border-strong'
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
              // A 2D control has no ARIA role of its own; `slider` with the
              // value spelled out in `aria-valuetext` is the closest honest one.
              role="slider"
              tabIndex={0}
              aria-label={t('themes.colorSaturation')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(hsva.s * 100)}
              aria-valuetext={t('themes.colorSaturationValue', {
                s: Math.round(hsva.s * 100),
                v: Math.round(hsva.v * 100)
              })}
              onKeyDown={(e) => {
                const step = stepOf(e, 0.01)
                const next = { ...hsva }
                if (e.key === 'ArrowLeft') next.s = clamp01(hsva.s - step)
                else if (e.key === 'ArrowRight') next.s = clamp01(hsva.s + step)
                else if (e.key === 'ArrowUp') next.v = clamp01(hsva.v + step)
                else if (e.key === 'ArrowDown') next.v = clamp01(hsva.v - step)
                else return
                e.preventDefault()
                emit(next)
              }}
              className="relative h-32 w-full cursor-crosshair touch-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
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
              onSet={(h) => emit({ ...hsva, h })}
            />
            <Slider
              label={t('themes.colorOpacity')}
              drag={alpha}
              position={hsva.a}
              track={`linear-gradient(to right, transparent, ${opaque}), ${CHECKER}`}
              thumb={formatColor(hsvaToRgba(hsva))}
              now={Math.round(hsva.a * 100)}
              max={100}
              onSet={(percent) => emit({ ...hsva, a: percent / 100 })}
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
  max,
  onSet
}: {
  label: string
  drag: ReturnType<typeof useDrag>
  position: number
  track: string
  thumb: string
  now: number
  max: number
  /** Called with the new value (0..max) from the keyboard. */
  onSet: (value: number) => void
}): JSX.Element {
  return (
    <div
      ref={drag.ref}
      {...drag.handlers}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={now}
      onKeyDown={(e) => {
        const step = stepOf(e, 1)
        let next: number
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = now - step
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = now + step
        else if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = max
        else return
        e.preventDefault()
        onSet(Math.max(0, Math.min(max, next)))
      }}
      className="relative h-3 w-full cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      style={{ background: track }}
    >
      <span
        className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
        style={{ left: `${position * 100}%`, background: thumb }}
      />
    </div>
  )
}
