/** Keep native scrolling and hit targets; only fade the handles' paint. */
export function startAutoHideScrollbars(): () => void {
  const root = document.documentElement
  const nearby = new Set<HTMLElement>()
  const active = new Map<
    HTMLElement,
    { visible: boolean; timer?: ReturnType<typeof setTimeout>; animation?: Animation }
  >()
  root.dataset.autoScrollbars = ''

  const visibility = (element: HTMLElement, visible: boolean): void => {
    let state = active.get(element)
    if (!state) {
      state = { visible: false }
      active.set(element, state)
    }
    if (state.visible === visible) return
    const from = getComputedStyle(element).getPropertyValue('--scrollbar-visibility')
    state.animation?.cancel()
    state.visible = visible
    element.style.setProperty('--scrollbar-visibility', visible ? '1' : '0')
    const animation = element.animate(
      [{ '--scrollbar-visibility': from }, { '--scrollbar-visibility': visible ? '1' : '0' }],
      {
        duration: root.dataset.motion === 'reduced' ? 0 : visible ? 100 : 240,
        easing: 'ease-out'
      }
    )
    state.animation = animation
    animation.onfinish = () => {
      if (!visible && active.get(element) === state && state.animation === animation) {
        element.style.removeProperty('--scrollbar-visibility')
        active.delete(element)
      }
    }
  }
  const hideLater = (element: HTMLElement): void => {
    const state = active.get(element)
    if (!state) return
    clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      if (!nearby.has(element)) visibility(element, false)
    }, 900)
  }
  const onScroll = (event: Event): void => {
    const element = event.target
    if (!(element instanceof HTMLElement)) return
    visibility(element, true)
    hideLater(element)
  }
  const leave = (): void => {
    for (const element of nearby) hideLater(element)
    nearby.clear()
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return
    // A native scrollbar drag can leave its viewport; keep the handle until release.
    if (event.buttons) return
    const next = new Set<HTMLElement>()
    for (const element of event.composedPath()) {
      if (!(element instanceof HTMLElement)) continue
      const vertical = element.scrollHeight > element.clientHeight
      const horizontal = element.scrollWidth > element.clientWidth
      if (!vertical && !horizontal) continue
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      const x = event.clientX
      const y = event.clientY
      const edge = style.direction === 'rtl' ? box.left : box.right
      if (
        (vertical &&
          /^(auto|scroll)$/.test(style.overflowY) &&
          Math.abs(x - edge) <= 24 &&
          y >= box.top &&
          y <= box.bottom) ||
        (horizontal &&
          /^(auto|scroll)$/.test(style.overflowX) &&
          Math.abs(y - box.bottom) <= 24 &&
          x >= box.left &&
          x <= box.right)
      ) {
        next.add(element)
        visibility(element, true)
        clearTimeout(active.get(element)?.timer)
      }
    }
    for (const element of nearby) if (!next.has(element)) hideLater(element)
    nearby.clear()
    for (const element of next) nearby.add(element)
  }
  const onPointerOut = (event: PointerEvent): void => {
    if (!event.relatedTarget && !event.buttons) leave()
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  document.addEventListener('pointerup', onPointerMove, { capture: true, passive: true })
  document.addEventListener('pointerout', onPointerOut, { passive: true })
  window.addEventListener('blur', leave)
  return () => {
    document.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('pointermove', onPointerMove, true)
    document.removeEventListener('pointerup', onPointerMove, true)
    document.removeEventListener('pointerout', onPointerOut)
    window.removeEventListener('blur', leave)
    for (const [element, state] of active) {
      clearTimeout(state.timer)
      state.animation?.cancel()
      element.style.removeProperty('--scrollbar-visibility')
    }
    delete root.dataset.autoScrollbars
  }
}
