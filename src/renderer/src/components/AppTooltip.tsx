import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * The surface every tooltip shares: the app's popover recipe (squircle frame +
 * `edge` hairline + `bg-elevated` + `shadow-float`), the same one as
 * `ContextMenuSurface` and the inference pickers. Every colour in it is a theme
 * token, so a tooltip follows the active theme -- light or dark -- with no
 * per-theme code. Anything that draws its own tooltip (e.g. the composer's
 * keycap one) must start from this constant rather than copy the classes.
 */
export const TOOLTIP_SURFACE =
  'sq-frame sq-lg sq-fill-elevated sq-ring edge edge-strong edge-panel rounded-lg border border-border bg-elevated shadow-float'

/** First tooltip after the pointer settles on something. */
const SHOW_DELAY = 450
/** Moving straight to a neighbour within this window skips the delay. */
const WARM_MS = 300
/** Gap between the trigger and the tooltip, and keep-off distance from the window edge. */
const GAP = 8
const EDGE = 8

const TRIGGER = '[title],[data-app-tip]'

interface Shown {
  text: string
  rect: DOMRect
}

/**
 * Replaces the browser's native `title` tooltip, app-wide, with a themed one.
 *
 * A native tooltip is drawn by the OS: it ignores the theme (a white box on a
 * dark theme), the squircle corners and the app font. Rather than rewrite the
 * ~120 `title=` props across the renderer, this listens once at the document
 * and takes over whichever element the pointer or keyboard focus lands on, so
 * existing and future `title=`s get the styled version for free.
 *
 * How it hands over: while a title is being shown it is moved from `title` to
 * `data-app-tip` (so the native one never appears), and put back the moment the
 * tooltip closes. Restoring matters: for an icon-only button the `title` is its
 * accessible name, and it must be there for assistive tech the rest of the time.
 *
 * Mounted once per React root, beside `AppContextMenu`.
 */
export function AppTooltip(): JSX.Element | null {
  const [shown, setShown] = useState<Shown | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current: HTMLElement | null = null
    // The element the user just pressed: it stays quiet until the pointer
    // leaves, or moving within a button you have just clicked re-opens its tip.
    let dismissed: HTMLElement | null = null
    let timer: number | undefined
    let lastHidden = 0

    const restore = (): void => {
      if (!current) return
      const text = current.dataset.appTip
      // React may have written a newer `title` while we held the old one.
      if (text !== undefined && !current.hasAttribute('title')) current.setAttribute('title', text)
      delete current.dataset.appTip
    }
    const hide = (): void => {
      window.clearTimeout(timer)
      if (current) {
        restore()
        current = null
        lastHidden = performance.now()
      }
      setShown(null)
    }
    const arm = (el: HTMLElement, immediate: boolean): void => {
      hide()
      const text = el.getAttribute('title')?.trim()
      if (!text) return
      current = el
      el.dataset.appTip = text
      el.removeAttribute('title')
      const open = (): void => {
        if (current === el && el.isConnected) setShown({ text, rect: el.getBoundingClientRect() })
      }
      if (immediate || performance.now() - lastHidden < WARM_MS) open()
      else timer = window.setTimeout(open, SHOW_DELAY)
    }
    const triggerOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>(TRIGGER) : null

    const onOver = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      const el = triggerOf(e.target)
      if (!el) {
        dismissed = null
        if (current) hide()
        return
      }
      if (el === dismissed || el === current) return
      dismissed = null
      arm(el, false)
    }
    const onDown = (): void => {
      dismissed = current
      hide()
    }
    const onFocusIn = (e: FocusEvent): void => {
      const el = triggerOf(e.target)
      // Keyboard focus only: a click also focuses, and that must not pop a tip.
      if (el && e.target instanceof Element && e.target.matches(':focus-visible')) arm(el, true)
    }
    const onAnyDismiss = (): void => hide()
    // A re-render can unmount the trigger without a pointer event ever firing.
    const poll = window.setInterval(() => {
      if (current && !current.isConnected) hide()
    }, 300)

    document.addEventListener('pointerover', onOver, true)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onAnyDismiss, true)
    document.addEventListener('keydown', onAnyDismiss, true)
    document.addEventListener('scroll', onAnyDismiss, true)
    document.addEventListener('wheel', onAnyDismiss, { capture: true, passive: true })
    window.addEventListener('blur', onAnyDismiss)
    window.addEventListener('resize', onAnyDismiss)
    return () => {
      window.clearInterval(poll)
      hide()
      document.removeEventListener('pointerover', onOver, true)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onAnyDismiss, true)
      document.removeEventListener('keydown', onAnyDismiss, true)
      document.removeEventListener('scroll', onAnyDismiss, true)
      document.removeEventListener('wheel', onAnyDismiss, true)
      window.removeEventListener('blur', onAnyDismiss)
      window.removeEventListener('resize', onAnyDismiss)
    }
  }, [])

  // Place before paint, once the box has a size: below the trigger, flipped
  // above when the window runs out, clamped so it never leaves the screen. The
  // composer's buttons sit at the bottom edge, so the flip is the common case.
  useLayoutEffect(() => {
    if (!shown || !box.current) {
      setPos(null)
      return
    }
    const { rect } = shown
    const w = box.current.offsetWidth
    const h = box.current.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const cx = rect.left + rect.width / 2
    const left = Math.max(EDGE, Math.min(cx - w / 2, vw - EDGE - w))
    const below = rect.bottom + GAP
    const above = rect.top - GAP - h
    const flip = below + h > vh - EDGE && above >= EDGE
    setPos({
      left,
      top: flip ? above : below,
      origin: `${Math.max(0, Math.min(cx - left, w))}px ${flip ? '100%' : '0'}`
    })
  }, [shown])

  if (!shown) return null
  return createPortal(
    <div
      ref={box}
      role="tooltip"
      dir="auto"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        transformOrigin: pos?.origin,
        visibility: pos ? 'visible' : 'hidden'
      }}
      // Above every popover (the pickers sit at z-[100]), and never in the way
      // of the pointer: the tooltip is information, not a target.
      className={`${TOOLTIP_SURFACE} ${pos ? 'animate-pop-in' : ''} pointer-events-none fixed z-[110] w-max max-w-[18rem] whitespace-pre-line break-words px-2.5 py-1.5 text-[11px] leading-snug text-text`}
    >
      {shown.text}
    </div>,
    document.body
  )
}
