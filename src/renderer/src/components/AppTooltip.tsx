import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type ButtonHTMLAttributes
} from 'react'
import { createPortal } from 'react-dom'

const TOOLTIP_SURFACE =
  'sq-frame sq-lg sq-fill-elevated sq-ring edge edge-strong edge-panel rounded-lg border border-border bg-elevated shadow-float'

const EVENT = 'app-tooltip'
const EDGE = 8
interface TooltipRequest {
  target: HTMLElement
  key: unknown
  content: ReactNode
  rect: DOMRect
  immediate?: boolean
}

/** Virtual canvas regions and rich DOM tips share the delegated title lifecycle. */
export function updateTooltip(
  target: HTMLElement,
  tip: Omit<TooltipRequest, 'target'> | null
): void {
  document.dispatchEvent(new CustomEvent(EVENT, { detail: { target, tip } }))
}

export function Tooltip({
  children,
  content
}: {
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>
  content: ReactNode
}): JSX.Element {
  const id = useId()
  const wrapper = useRef<HTMLSpanElement>(null)
  const active = useRef(false)
  const show = (immediate = false): void => {
    if (!wrapper.current) return
    active.current = true
    updateTooltip(wrapper.current, {
      key: wrapper.current,
      content,
      rect: wrapper.current.getBoundingClientRect(),
      immediate
    })
  }
  const hide = (): void => {
    active.current = false
    if (wrapper.current) updateTooltip(wrapper.current, null)
  }
  useLayoutEffect(() => {
    if (active.current) show()
  })
  useEffect(() => {
    const target = wrapper.current
    return () => {
      if (target) updateTooltip(target, null)
    }
  }, [])
  return (
    <span
      ref={wrapper}
      className="inline-flex"
      data-app-tip=""
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') show()
      }}
      onPointerMove={(event) => {
        if (event.pointerType !== 'touch') show()
      }}
      onPointerLeave={hide}
      onFocus={(event) => {
        if (event.target.matches(':focus-visible')) show(true)
      }}
      onBlur={hide}
    >
      {cloneElement(children, {
        'aria-describedby': [children.props['aria-describedby'], id].filter(Boolean).join(' ')
      })}
      <span id={id} className="sr-only">
        {content}
      </span>
    </span>
  )
}

/** Mounted once per window, so existing and future title props need no migration. */
export function AppTooltip(): JSX.Element | null {
  const id = useId()
  const [shown, setShown] = useState<TooltipRequest | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current: TooltipRequest | null = null
    let dismissed: { target: HTMLElement; key: unknown } | null = null
    let timer: number | undefined
    let visible = false
    let lastHidden = -Infinity
    let restore: (() => void) | undefined
    const hide = (): void => {
      window.clearTimeout(timer)
      if (visible) lastHidden = performance.now()
      visible = false
      restore?.()
      restore = undefined
      current = null
      setShown(null)
    }
    const dismiss = (): void => {
      if (current) dismissed = { target: current.target, key: current.key }
      hide()
    }
    const arm = (request: TooltipRequest): void => {
      if (dismissed?.target === request.target && dismissed.key === request.key) return
      if (current?.target === request.target && current.key === request.key) {
        if (
          current.content === request.content &&
          current.rect.x === request.rect.x &&
          current.rect.y === request.rect.y &&
          current.rect.width === request.rect.width &&
          current.rect.height === request.rect.height
        )
          return
        current = request
        if (visible) setShown(request)
        return
      }
      hide()
      dismissed = null
      current = request
      const open = (): void => {
        if (!current?.target.isConnected) {
          hide()
          return
        }
        visible = true
        setShown(current)
      }
      if (request.immediate || performance.now() - lastHidden < 300) open()
      else timer = window.setTimeout(open, 450)
    }
    const triggerOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>('[title],[data-app-tip]') : null
    const fromTitle = (target: HTMLElement, immediate = false): void => {
      if (current?.target === target || dismissed?.target === target) return
      const title = target.getAttribute('title')
      const text = (title ?? target.dataset.appTip)?.trim()
      if (!text) return
      arm({ target, key: target, content: text, rect: target.getBoundingClientRect(), immediate })
      // An empty title suppresses inherited native tips too. Keep the accessible
      // name, and observe React writes rather than restoring an obsolete title.
      let latestTitle = title
      let label: string | null = null
      const describe = target.getAttribute('aria-describedby')
      let description: string | null = describe
      const setLabel = (value: string): void => {
        if (
          (label !== null && target.getAttribute('aria-label') === label) ||
          (!target.hasAttribute('aria-label') &&
            !target.hasAttribute('aria-labelledby') &&
            !target.textContent?.trim())
        ) {
          label = value
          target.setAttribute('aria-label', value)
        }
      }
      setLabel(text)
      const setDescription = (value: string): void => {
        const labelledBy = target.getAttribute('aria-labelledby')
        const name = labelledBy
          ? labelledBy
              .split(/\s+/)
              .map((key) => document.getElementById(key)?.textContent ?? '')
              .join(' ')
          : (target.getAttribute('aria-label') ?? target.textContent ?? '')
        const next = name.trim() === value ? describe : [describe, id].filter(Boolean).join(' ')
        if (target.getAttribute('aria-describedby') === description) {
          if (next === null) target.removeAttribute('aria-describedby')
          else target.setAttribute('aria-describedby', next)
          description = next
        }
      }
      setDescription(text)
      target.setAttribute('title', '')
      const observer = new MutationObserver((records) => {
        if (!current || current.target !== target) return
        if (records.some((record) => record.attributeName === 'title'))
          latestTitle = target.getAttribute('title')
        const next = (latestTitle ?? target.dataset.appTip)?.trim()
        if (!next) {
          hide()
          return
        }
        target.setAttribute('title', '')
        observer.takeRecords()
        setLabel(next)
        setDescription(next)
        current = { ...current, content: next, rect: target.getBoundingClientRect() }
        if (visible) setShown(current)
      })
      observer.observe(target, { attributes: true, attributeFilter: ['title', 'data-app-tip'] })
      restore = () => {
        if (observer.takeRecords().some((record) => record.attributeName === 'title'))
          latestTitle = target.getAttribute('title')
        observer.disconnect()
        if (latestTitle === null) target.removeAttribute('title')
        else target.setAttribute('title', latestTitle)
        if (label !== null && target.getAttribute('aria-label') === label)
          target.removeAttribute('aria-label')
        if (target.getAttribute('aria-describedby') === description) {
          if (describe === null) target.removeAttribute('aria-describedby')
          else target.setAttribute('aria-describedby', describe)
        }
      }
    }
    const onOver = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return
      const target = triggerOf(event.target)
      if (target) fromTitle(target)
    }
    const onOut = (event: PointerEvent): void => {
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null
      if (current && !current.target.contains(next)) hide()
      if (dismissed && !dismissed.target.contains(next)) dismissed = null
    }
    const onFocus = (event: FocusEvent): void => {
      const target = triggerOf(event.target)
      if (target && event.target instanceof Element && event.target.matches(':focus-visible')) {
        dismissed = null
        fromTitle(target, true)
      }
    }
    const onScroll = (event: Event): void => {
      if (
        current &&
        (event.target === document ||
          (event.target instanceof Node && event.target.contains(current.target)))
      )
        hide()
    }
    const onRequest = (event: Event): void => {
      const { target, tip } = (
        event as CustomEvent<{ target: HTMLElement; tip: Omit<TooltipRequest, 'target'> | null }>
      ).detail
      if (tip) arm({ target, ...tip })
      else {
        if (current?.target === target) hide()
        if (dismissed?.target === target) dismissed = null
      }
    }
    const poll = window.setInterval(() => {
      if (current && !current.target.isConnected) hide()
    }, 300)
    document.addEventListener(EVENT, onRequest)
    document.addEventListener('pointerover', onOver, true)
    document.addEventListener('pointermove', onOver, true)
    document.addEventListener('pointerout', onOut, true)
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('pointercancel', dismiss, true)
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('focusout', hide, true)
    document.addEventListener('keydown', dismiss, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('wheel', dismiss, { capture: true, passive: true })
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    return () => {
      window.clearInterval(poll)
      hide()
      document.removeEventListener(EVENT, onRequest)
      document.removeEventListener('pointerover', onOver, true)
      document.removeEventListener('pointermove', onOver, true)
      document.removeEventListener('pointerout', onOut, true)
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('pointercancel', dismiss, true)
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('focusout', hide, true)
      document.removeEventListener('keydown', dismiss, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('wheel', dismiss, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
    }
  }, [id])

  useLayoutEffect(() => {
    if (!shown || !box.current) {
      setPos(null)
      return
    }
    const element = box.current
    const place = (): void => {
      const bounds = shown.target.closest('[data-tooltip-bounds]')?.getBoundingClientRect()
      const minY = Math.max(EDGE, (bounds?.top ?? 0) + EDGE)
      const maxY = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight) - EDGE
      const maxHeight = Math.max(0, maxY - minY)
      element.style.maxHeight = `${maxHeight}px`
      const { offsetWidth: width, offsetHeight: height } = element
      const rect = shown.rect
      const below = rect.bottom + 8
      const top = below + height <= maxY ? below : rect.top - 8 - height
      setPos({
        left: Math.max(
          EDGE,
          Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - EDGE - width)
        ),
        top: Math.max(minY, Math.min(top, maxY - height)),
        maxHeight
      })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    return () => observer.disconnect()
  }, [shown])

  if (!shown) return null
  return createPortal(
    <div
      ref={box}
      id={id}
      role="tooltip"
      dir="auto"
      data-app-tooltip
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        maxHeight: pos?.maxHeight,
        visibility: pos ? 'visible' : 'hidden'
      }}
      className={`${TOOLTIP_SURFACE} pointer-events-none fixed z-[200] w-max max-w-[min(24rem,calc(100vw-16px))] overflow-hidden whitespace-pre-line break-words px-2.5 py-1.5 text-[11px] leading-snug text-text`}
    >
      {shown.content}
    </div>,
    shown.target.closest('dialog[open]') ?? document.body
  )
}
