/**
 * Keeps an anchored popover inside the window.
 *
 * The menus in the workstream strip and the composer footer are absolutely
 * positioned children of their triggers, pinned to one edge (`left-0` /
 * `right-0`) at a fixed width. Nothing in that arrangement knows where the
 * window ends, so a trigger near an edge pushes its menu off screen — and since
 * the app root is `overflow: hidden`, it is silently cut rather than scrolled
 * into reach.
 *
 * This measures the trigger against the viewport and hands back a style that
 * nudges the menu back inside, plus a `maxHeight` so a long list can't run off
 * the top either. The menu stays a positioned CHILD (the returned `left` is an
 * offset from the trigger, not a viewport coordinate), which means it keeps
 * tracking its trigger between measurements instead of detaching from it the
 * way a portal would.
 *
 * The geometry itself lives in lib/anchor.ts, pure and tested.
 */
import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import {
  alignMenu,
  MARGIN,
  MAX_MENU_H,
  menuMaxHeight,
  placeOutsidePanel,
  type MenuAlign,
  type MenuSide
} from './anchor'

interface Options {
  /** Which trigger edge to line up with when there's room. */
  align?: MenuAlign
  /** Which way the menu opens. */
  side?: MenuSide
  /** Space reserved between menu and trigger — must match the menu's own padding. */
  gap?: number
  /**
   * Ceiling on the menu height, overriding the shared MAX_MENU_H. Raise it for
   * a menu whose content genuinely earns more vertical space. There is no way
   * to opt out of a ceiling entirely, which is the point.
   */
  maxHeight?: number
  /** Rendered menu uses viewport coordinates rather than trigger-relative offsets. */
  fixed?: boolean
  /** Prefer placing the fixed menu immediately outside this surface. */
  outsideRef?: RefObject<HTMLElement>
}

/**
 * `ref` is the POSITIONED wrapper (the `relative` element that contains both
 * trigger and menu), `open` gates the work, and `width` is the menu's fixed
 * width in px. Returns styles to spread onto the menu.
 */
export function useMenuAnchor(
  ref: RefObject<HTMLElement>,
  open: boolean,
  width: number,
  {
    align = 'start',
    side = 'top',
    gap = 6,
    maxHeight = MAX_MENU_H,
    fixed = false,
    outsideRef
  }: Options = {}
): CSSProperties {
  // Start with the un-nudged position so the FIRST paint is already anchored:
  // measuring in an effect means one frame exists before we know better, and a
  // menu that visibly jumps sideways on open is worse than one slightly off.
  // The height ceiling is in here for the same reason -- it does not depend on
  // the measurement, and leaving it out let a long list paint at full height for
  // one frame and then snap shorter.
  const [style, setStyle] = useState<CSSProperties>({
    width: `min(${width}px, calc(100vw - ${MARGIN * 2}px))`,
    maxHeight
  })

  const measure = useCallback((): void => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const menuWidth = Math.min(width, window.innerWidth - MARGIN * 2)
    const alignedLeft = r.left + alignMenu(r.left, r.width, menuWidth, window.innerWidth, align)
    const outside = outsideRef?.current?.getBoundingClientRect()
    const fixedLeft =
      fixed && outside
        ? placeOutsidePanel(
            alignedLeft,
            outside.left,
            outside.right,
            menuWidth,
            window.innerWidth,
            gap
          )
        : alignedLeft
    setStyle({
      width: menuWidth,
      left: fixed ? fixedLeft : alignedLeft - r.left,
      ...(fixed
        ? {
            [side === 'top' ? 'bottom' : 'top']:
              side === 'top' ? window.innerHeight - r.top + gap : r.bottom + gap
          }
        : {}),
      maxHeight: menuMaxHeight(r.top, r.bottom, window.innerHeight, side, gap, maxHeight)
    })
  }, [ref, width, align, side, gap, maxHeight, fixed, outsideRef])

  useLayoutEffect(() => {
    if (!open) return
    measure()
    // Resizing the window and dragging the sidebar's edge both move the trigger
    // without remounting the menu, so re-measure rather than close: the user is
    // mid-interaction and closing their menu for them would be rude.
    window.addEventListener('resize', measure)
    if (fixed) window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      if (fixed) window.removeEventListener('scroll', measure, true)
    }
  }, [open, measure, fixed])

  return style
}
