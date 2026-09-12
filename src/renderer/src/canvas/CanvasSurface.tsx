import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  visibleImages,
  type HitAction,
  type HitRegion,
  type Scene,
  type ScrollRegion,
  type ViewState
} from './scene'
import { TextMetrics } from './text'
import { observeTheme, readTheme, type CanvasTheme } from './theme'
import {
  contains,
  hasAnimation,
  hitTest,
  hitText,
  paintScene,
  selectionCollapsed,
  selectionText,
  wordSelection,
  type SelectionRange
} from './renderer'
import { CanvasMenu, type CanvasMenuItem } from './CanvasMenu'
import { openLink } from './links'
import { diffPatch } from '../components/diff/model'
import { prefersReducedMotion, subscribeMotion } from '../lib/motion'
import { PromptHistoryRail } from './PromptHistoryRail'
import { activePrompt, PROMPT_OFFSET, type PromptAnchor, type PromptEntry } from './prompt-history'

const NO_PROMPTS: PromptEntry[] = []

export interface CanvasLayoutContext {
  width: number
  height: number
  metrics: TextMetrics
  theme: CanvasTheme
  view: ViewState
  t: TFunction
  now: number
  language: string
  viewport: {
    top: number
    height: number
    tail: boolean
    targetId?: string
    selectionKeys?: string[]
  }
}

export interface CanvasProbe {
  debug: {
    frames: number
    layouts: number
    layoutMs: number
    paintMs: number
    firstPaint: { top: number; bottom: number; at: number } | null
  }
  scene: () => Scene
  size: () => { width: number; height: number }
  selection: () => SelectionRange | null
}

type Press = {
  pointerId: number
  x: number
  y: number
  action?: HitAction
  anchor: ReturnType<typeof hitText>
  dragged: boolean
  touch: boolean
  wordSelected: boolean
  scrollbar?: {
    region: ScrollRegion
    axis: 'x' | 'y'
    origin: number
    offset: number
    ratio: number
  }
}

/** Shared viewport/input host for the transcript and standalone canvas components. */
export function CanvasSurface({
  sceneKey,
  buildScene,
  onAction,
  pinSignal = 0,
  followTail = true,
  onScrollStateChange,
  prompts = NO_PROMPTS
}: {
  sceneKey: string
  buildScene: (context: CanvasLayoutContext) => Scene
  onAction?: (action: HitAction) => void
  pinSignal?: number
  followTail?: boolean
  onScrollStateChange?: (atBottom: boolean) => void
  prompts?: PromptEntry[]
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const scroller = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const spacer = useRef<HTMLDivElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const [theme, setTheme] = useState<CanvasTheme>(readTheme)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [status, setStatus] = useState('')
  const [activePromptId, setActivePromptId] = useState<string | null>(null)
  const activePromptRef = useRef<string | null>(null)
  const promptAnchors = useRef<PromptAnchor[]>([])
  const [image, setImage] = useState<string | null>(null)
  const imageDialog = useRef<HTMLDialogElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: CanvasMenuItem[] } | null>(null)
  const metrics = useMemo(() => new TextMetrics(theme), [theme])
  const view = useRef<ViewState>({
    open: new Set(),
    startedAt: new Map(),
    images: new Map(),
    diffs: new Map(),
    scroll: new Map()
  })
  const scene = useRef<Scene>({ width: 0, height: 0, blocks: [] })
  const selection = useRef<SelectionRange | null>(null)
  const press = useRef<Press | null>(null)
  const lastClick = useRef<{
    at: number
    x: number
    y: number
    anchor: NonNullable<ReturnType<typeof hitText>>
  } | null>(null)
  const hovered = useRef<HitRegion | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const focusedScroll = useRef<string | null>(null)
  const stick = useRef(followTail)
  const initialPosition = useRef(true)
  const ownScrollTop = useRef<number | null>(null)
  const frame = useRef(0)
  const drawRef = useRef<(position?: boolean) => void>(() => {})
  const layoutRef = useRef<(targetId?: string) => void>(() => {})
  const mounted = useRef(false)
  const reducedMotion = useRef(false)
  const syntaxPending = useRef(new WeakSet<object>())
  const debug = useRef<CanvasProbe['debug']>({
    frames: 0,
    layouts: 0,
    layoutMs: 0,
    paintMs: 0,
    firstPaint: null
  })

  const updatePrompt = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const current = activePrompt(
      promptAnchors.current,
      el.scrollTop,
      el.scrollTop >= el.scrollHeight - el.clientHeight - 1
    )
    if (activePromptRef.current !== current) {
      activePromptRef.current = current
      setActivePromptId(current)
    }
  }, [])

  const jumpToPrompt = useCallback(
    (id: string) => {
      const el = scroller.current
      const block = scene.current.blocks.find((candidate) => candidate.id === id)
      if (!el || !block) return
      // Read live geometry: expanding a tool or loading a font may have moved this prompt.
      stick.current = false
      selection.current = null
      press.current = null
      hovered.current = null
      pointer.current = null
      focusedScroll.current = null
      setMenu(null)
      if (scene.current.window) {
        layoutRef.current(id)
        return
      }
      el.scrollTo({ top: Math.max(0, block.y - PROMPT_OFFSET), behavior: 'instant' })
      ownScrollTop.current = el.scrollTop
      updatePrompt()
      drawRef.current()
    },
    [updatePrompt]
  )

  const requestPaint = useCallback(() => {
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        drawRef.current()
      })
  }, [])

  const updateHover = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const pos = pointer.current
    const inside =
      pos && pos.x >= 0 && pos.x < el.clientWidth && pos.y >= 0 && pos.y < el.clientHeight
    const region = inside ? hitTest(scene.current, pos.x, pos.y + el.scrollTop) : null
    hovered.current = region
    const textHit =
      inside && !region && hitText(scene.current, pos.x, pos.y + el.scrollTop, metrics)
    el.style.cursor = region?.cursor ?? (textHit || press.current?.dragged ? 'text' : 'default')
    el.title = region?.title ?? ''
  }, [metrics])

  useEffect(() => observeTheme(setTheme), [])
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void =>
      setSize((old) =>
        old.width === el.clientWidth && old.height === el.clientHeight
          ? old
          : { width: el.clientWidth, height: el.clientHeight }
      )
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    view.current = {
      open: new Set(),
      startedAt: new Map(),
      images: new Map(),
      diffs: new Map(),
      scroll: new Map()
    }
    selection.current = null
    press.current = null
    lastClick.current = null
    hovered.current = null
    focusedScroll.current = null
    stick.current = followTail
    initialPosition.current = true
    ownScrollTop.current = null
    debug.current.firstPaint = null
    promptAnchors.current = []
    activePromptRef.current = null
    setActivePromptId(null)
    setMenu(null)
    setStatus('')
  }, [sceneKey, followTail])

  useLayoutEffect(() => {
    mounted.current = true
    reducedMotion.current = prefersReducedMotion()
    const resume = (): void => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      if (!document.hidden) requestPaint()
    }
    const motionChanged = (): void => {
      reducedMotion.current = prefersReducedMotion()
      resume()
    }
    const stopMotion = subscribeMotion(motionChanged)
    document.addEventListener('visibilitychange', resume)
    return () => {
      mounted.current = false
      stopMotion()
      document.removeEventListener('visibilitychange', resume)
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [requestPaint])

  useLayoutEffect(() => {
    const draw = (position = false): void => {
      const el = scroller.current
      const target = canvas.current
      const range = spacer.current
      if (!el || !target || !range || !size.width || !size.height) return
      // Commit the scroll range and initial offset together, before painting any messages.
      range.style.height = `${Math.max(0, scene.current.height - size.height)}px`
      if (el.clientWidth !== size.width || el.clientHeight !== size.height) {
        setSize({ width: el.clientWidth, height: el.clientHeight })
        return
      }
      const measured = scene.current.window
      if (
        !position &&
        measured &&
        (el.scrollTop < measured.start || el.scrollTop + size.height > measured.end)
      ) {
        layoutRef.current()
        return
      }
      const pin = followTail && stick.current
      if ((pin && position) || initialPosition.current || (position && measured)) {
        const top = pin
          ? Math.max(0, el.scrollHeight - el.clientHeight)
          : (measured?.scrollTop ?? 0)
        if (el.scrollTop !== top) {
          el.scrollTo({ top, behavior: 'instant' })
          ownScrollTop.current = el.scrollTop
        }
      }
      if (scene.current.blocks.length) initialPosition.current = false
      updatePrompt()
      updateHover()
      // Mirror only what can be read here. Hidden tool output can be megabytes, even for one turn.
      let accessible = ''
      const visibleSources = visibleImages(scene.current, el.scrollTop, size.height)
      for (const block of scene.current.blocks) {
        if (block.y > el.scrollTop + size.height || block.y + block.height < el.scrollTop) continue
        for (const line of block.selectable) {
          if (line.y + line.height < el.scrollTop || line.y > el.scrollTop + size.height) continue
          if (
            line.clip &&
            (line.y >= line.clip.y + line.clip.h || line.y + line.height <= line.clip.y)
          )
            continue
          if (accessible.length < 20000)
            accessible += line.text.slice(0, 20000 - accessible.length) + '\n'
        }
      }
      if (mirror.current && mirror.current.textContent !== accessible)
        mirror.current.textContent = accessible
      const imageMap = view.current.images
      for (const src of visibleSources) {
        if (imageMap.has(src)) continue
        const image = new Image()
        imageMap.set(src, image)
        image.src = src
        void image
          .decode()
          .then(() => {
            if (mounted.current && view.current.images === imageMap && imageMap.get(src) === image)
              requestPaint()
          })
          .catch(() => {})
      }
      if (imageMap.size > 24)
        for (const src of imageMap.keys()) {
          if (imageMap.size <= 24) break
          if (src !== '__roxy__' && !visibleSources.has(src)) imageMap.delete(src)
        }
      const ctx = target.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(size.width * dpr)
      const h = Math.round(size.height * dpr)
      if (target.width !== w || target.height !== h) {
        target.width = w
        target.height = h
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (import.meta.env.DEV && !debug.current.firstPaint && scene.current.blocks.length) {
        debug.current.firstPaint = {
          top: el.scrollTop,
          bottom: Math.max(0, scene.current.height - el.clientHeight),
          at: performance.now()
        }
      }
      const paintStarted = import.meta.env.DEV ? performance.now() : 0
      paintScene(scene.current, {
        ctx,
        theme,
        metrics,
        scrollTop: el.scrollTop,
        viewportHeight: size.height,
        now: performance.now(),
        reducedMotion: reducedMotion.current,
        hovered: hovered.current,
        selection: selection.current,
        images: view.current.images
      })
      if (import.meta.env.DEV && debug.current.frames === 0 && debug.current.firstPaint)
        debug.current.firstPaint.at = performance.now()
      if (import.meta.env.DEV) debug.current.paintMs += performance.now() - paintStarted
      debug.current.frames++
      // Reduced motion removes rotation, not the essential indication that work is continuing.
      if (!document.hidden && hasAnimation(scene.current, el.scrollTop, size.height)) requestPaint()
    }
    drawRef.current = draw
    const layout = (targetId?: string): void => {
      if (!size.width || !size.height) return
      const previous = scene.current
      const selected = selection.current
      const pinnedLines = selected && !selected.all ? [selected.startLine, selected.endLine] : []
      if (press.current?.anchor) pinnedLines.push(press.current.anchor.line)
      const selectionKeys = pinnedLines.flatMap((index) => {
        const line = previous.blocks
          .flatMap((block) => block.selectable)
          .find((line) => line.index === index)
        return line?.key ? [line.key] : []
      })
      const layoutStarted = import.meta.env.DEV ? performance.now() : 0
      const next = buildScene({
        ...size,
        metrics,
        theme,
        view: view.current,
        t,
        now: performance.now(),
        language: i18n.resolvedLanguage || i18n.language,
        viewport: {
          top: scroller.current?.scrollTop ?? 0,
          height: size.height,
          tail: followTail && stick.current,
          targetId,
          selectionKeys
        }
      })
      if (import.meta.env.DEV) debug.current.layoutMs += performance.now() - layoutStarted
      // Preserve a history selection while streaming elsewhere; never copy stale line ordinals.
      if (selection.current) {
        const s = selection.current
        const rows = next.blocks.flatMap((block) => block.selectable)
        const remap = (index: number): number | null => {
          const oldBlock = previous.blocks.find((block) =>
            block.selectable.some((line) => line.index === index)
          )
          const local = oldBlock?.selectable.findIndex((line) => line.index === index) ?? -1
          const original = oldBlock?.selectable[local]
          const nextBlock = next.blocks.find((block) => block.id === oldBlock?.id)
          const row = original?.key
            ? nextBlock?.selectable.find((line) => line.key === original.key)
            : nextBlock?.selectable[local]
          return row && row.text === oldBlock?.selectable[local]?.text ? row.index : null
        }
        const start = remap(s.startLine)
        const end = remap(s.endLine)
        selection.current =
          s.all && rows.length
            ? {
                startLine: rows[0].index,
                startChar: 0,
                endLine: rows[rows.length - 1].index,
                endChar: rows[rows.length - 1].text.length,
                all: true
              }
            : start !== null && end !== null
              ? { ...s, startLine: start, endLine: end }
              : null
      }
      if (press.current?.anchor) {
        const anchor = press.current.anchor
        const old = previous.blocks
          .flatMap((block) => block.selectable)
          .find((line) => line.index === anchor.line)
        const nextLine = old?.key
          ? next.blocks.flatMap((block) => block.selectable).find((line) => line.key === old.key)
          : undefined
        if (nextLine) press.current.anchor = { ...anchor, line: nextLine.index }
        else if (old?.key) press.current = null
      }
      scene.current = next
      const ids = new Set(prompts.map((prompt) => prompt.id))
      promptAnchors.current = next.blocks
        .filter((block) => ids.has(block.id))
        .map(({ id, y }) => ({ id, y }))
      debug.current.layouts++
      draw(true)
      for (const [id, state] of view.current.diffs) {
        if (state.syntax || syntaxPending.current.has(state)) continue
        syntaxPending.current.add(state)
        void import('../components/diff/syntax')
          .then(({ highlightDiff }) => highlightDiff(state.document))
          .then((syntax) => {
            if (!mounted.current || view.current.diffs.get(id) !== state) return
            state.syntax = syntax
            state.revision++
            layoutRef.current()
          })
          .catch(() => {
            /* Plain text remains fully navigable if highlighting fails. */
          })
      }
    }
    layoutRef.current = layout
    layout()
  }, [
    buildScene,
    size,
    theme,
    metrics,
    t,
    i18n.language,
    updateHover,
    requestPaint,
    sceneKey,
    followTail,
    prompts,
    updatePrompt
  ])

  useLayoutEffect(() => {
    if (followTail) {
      stick.current = true
      drawRef.current(true)
    }
  }, [pinSignal, followTail])

  // Dev-only observations for real pointer/bitmap regression tests, not a production global.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const root = window as Window & { __canvasTranscript?: CanvasProbe }
    const probe = {
      debug: debug.current,
      scene: () => scene.current,
      size: () => size,
      selection: () => selection.current
    }
    root.__canvasTranscript = probe
    return () => {
      if (root.__canvasTranscript === probe) delete root.__canvasTranscript
    }
  }, [size])

  const copy = (value: string): void => {
    void navigator.clipboard.writeText(value).then(
      () => setStatus(t('chat.copied')),
      () => setStatus(t('transcript.copyFailed'))
    )
  }
  const selectAll = (): void => {
    const rows = scene.current.blocks.flatMap((block) => block.selectable)
    if (!rows.length) return
    selection.current = {
      startLine: rows[0].index,
      startChar: 0,
      endLine: rows[rows.length - 1].index,
      endChar: rows[rows.length - 1].text.length,
      all: true
    }
    requestPaint()
  }
  const closeMenu = useCallback(() => {
    setMenu(null)
    if (document.hasFocus() && document.activeElement?.closest('[data-canvas-menu]'))
      scroller.current?.focus({ preventScroll: true })
  }, [])

  useLayoutEffect(() => {
    if (image && !imageDialog.current?.open) imageDialog.current?.showModal()
  }, [image])

  const scrollAt = (x: number, y: number): ScrollRegion | undefined => {
    const regions = scene.current.blocks.flatMap((block) => block.scrollRegions)
    return regions
      .reverse()
      .find((region) =>
        contains({ ...region, h: region.h + (region.contentWidth > region.w ? 10 : 0) }, x, y)
      )
  }
  const setScroll = useCallback((region: ScrollRegion, left: number, top: number): boolean => {
    const position = {
      left: Math.max(0, Math.min(left, region.contentWidth - region.w)),
      top: Math.max(0, Math.min(top, region.contentHeight - region.h))
    }
    if (position.left === region.left && position.top === region.top) return false
    view.current.scroll.set(region.id, position)
    layoutRef.current()
    return true
  }, [])

  const act = (action: HitAction): void => {
    if (action.type === 'toggle') {
      stick.current = false
      selection.current = null
      if (view.current.open.has(action.id)) view.current.open.delete(action.id)
      else view.current.open.add(action.id)
      layoutRef.current()
    } else if (action.type === 'diff') {
      const state = view.current.diffs.get(action.id)
      if (!state) return
      if (action.command === 'patch') {
        const patch = diffPatch(state.document)
        if (patch !== null) copy(patch)
        else setStatus(t('diff.patchTooLarge'))
        return
      }
      selection.current = null
      if (action.command === 'unified' || action.command === 'split') state.mode = action.command
      if (action.command === 'wrap') state.wrap = !state.wrap
      if (action.command === 'context') state.showAll = !state.showAll
      if (action.command === 'gap' && action.gap !== undefined) state.expanded.add(action.gap)
      state.revision++
      layoutRef.current()
    } else if (action.type === 'scroll') {
      const region = scene.current.blocks
        .flatMap((b) => b.scrollRegions)
        .find((r) => r.id === action.id)
      if (region) setScroll(region, action.left, action.top)
    } else if (action.type === 'copy') copy(action.text)
    else if (action.type === 'link') openLink(action.href)
    else if (action.type === 'image') setImage(action.src)
    else onAction?.(action)
  }

  // Non-passive wheel handler: only consume scrolling that the inner viewport can use.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const wheel = (event: WheelEvent): void => {
      if (event.ctrlKey) return
      const rect = el.getBoundingClientRect()
      const region = scene.current.blocks
        .flatMap((b) => b.scrollRegions)
        .reverse()
        .find((r) =>
          contains(r, event.clientX - rect.left, event.clientY - rect.top + el.scrollTop)
        )
      if (!region) return
      const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? region.h : 1
      const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit
      const dy = event.shiftKey ? 0 : event.deltaY * unit
      if (setScroll(region, region.left + dx, region.top + dy)) {
        event.preventDefault()
        focusedScroll.current = region.id
        setMenu(null)
      }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [setScroll])

  const point = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const el = scroller.current!
    const rect = el.getBoundingClientRect()
    return {
      x: event.clientX - rect.left - el.clientLeft,
      y: event.clientY - rect.top - el.clientTop
    }
  }

  return (
    <>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-canvas-viewport>
        <div
          ref={scroller}
          data-canvas-surface
          tabIndex={0}
          role="region"
          aria-label={t('transcript.history')}
          className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto outline-none"
          style={{ overflowAnchor: 'none', scrollBehavior: 'auto', userSelect: 'none' }}
          onScroll={() => {
            const el = scroller.current!
            // A self-write is not user intent to detach from the live tail.
            if (ownScrollTop.current === null || Math.abs(el.scrollTop - ownScrollTop.current) > 1)
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            ownScrollTop.current = null
            onScrollStateChange?.(stick.current)
            updatePrompt()
            updateHover()
            requestPaint()
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return
            const pos = point(event)
            const el = event.currentTarget
            if (pos.x >= el.clientWidth || pos.y >= el.clientHeight || pos.x < 0 || pos.y < 0)
              return
            if (event.pointerType !== 'touch') event.preventDefault()
            el.focus({ preventScroll: true })
            setMenu(null)
            const y = pos.y + el.scrollTop
            const region = hitTest(scene.current, pos.x, y)
            const inner = scrollAt(pos.x, y)
            focusedScroll.current = inner?.id ?? null
            const anchor = hitText(scene.current, pos.x, y, metrics)
            const previousClick = lastClick.current
            const doubleClick =
              !!anchor &&
              !!previousClick &&
              event.pointerType !== 'touch' &&
              event.timeStamp - previousClick.at <= 500 &&
              Math.hypot(pos.x - previousClick.x, pos.y - previousClick.y) <= 4 &&
              anchor.line === previousClick.anchor.line &&
              anchor.group === previousClick.anchor.group
            const pending: Press = {
              pointerId: event.pointerId,
              ...pos,
              action: region?.action,
              anchor,
              dragged: false,
              touch: event.pointerType === 'touch',
              wordSelected: false
            }
            if (inner) {
              const vertical = pos.x >= inner.x + inner.w - 10 && inner.contentHeight > inner.h
              const horizontal = y >= inner.y + inner.h && inner.contentWidth > inner.w
              if (vertical || horizontal) {
                const extent = vertical ? inner.h : inner.w - 16
                const content = vertical ? inner.contentHeight : inner.contentWidth
                const viewport = vertical ? inner.h : inner.w
                const thumb = Math.max(24, (extent * viewport) / content)
                const offset = vertical ? inner.top : inner.left
                const travel = Math.max(1, extent - thumb)
                const ratio = (content - viewport) / travel
                const coordinate = vertical ? y - inner.y : pos.x - inner.x - 4
                const start = offset / ratio
                const next =
                  coordinate < start || coordinate > start + thumb
                    ? (coordinate - thumb / 2) * ratio
                    : offset
                pending.scrollbar = {
                  region: inner,
                  axis: vertical ? 'y' : 'x',
                  origin: vertical ? pos.y : pos.x,
                  offset: next,
                  ratio
                }
                setScroll(inner, vertical ? inner.left : next, vertical ? next : inner.top)
              }
            }
            const selectedWord =
              doubleClick && !pending.action && !pending.scrollbar && anchor
                ? wordSelection(scene.current, anchor)
                : null
            pending.wordSelected = !!selectedWord
            press.current = pending
            selection.current = selectedWord
            if (!pending.touch) el.setPointerCapture(event.pointerId)
            requestPaint()
          }}
          onPointerMove={(event) => {
            const pos = point(event)
            pointer.current = pos
            const pending = press.current
            if (pending?.pointerId === event.pointerId) {
              if (Math.hypot(pos.x - pending.x, pos.y - pending.y) >= 4) pending.dragged = true
              if (pending.scrollbar) {
                const { region, axis, origin, offset, ratio } = pending.scrollbar
                const next = offset + ((axis === 'y' ? pos.y : pos.x) - origin) * ratio
                const current =
                  scene.current.blocks
                    .flatMap((b) => b.scrollRegions)
                    .find((r) => r.id === region.id) ?? region
                setScroll(
                  current,
                  axis === 'x' ? next : current.left,
                  axis === 'y' ? next : current.top
                )
              } else if (pending.dragged && pending.anchor && !pending.touch) {
                const end = hitText(
                  scene.current,
                  pos.x,
                  pos.y + event.currentTarget.scrollTop,
                  metrics,
                  { nearest: true, group: pending.anchor.group }
                )
                if (end)
                  selection.current = {
                    startLine: pending.anchor.line,
                    startChar: pending.anchor.char,
                    endLine: end.line,
                    endChar: end.char,
                    group: pending.anchor.group
                  }
              }
            }
            updateHover()
            requestPaint()
          }}
          onPointerUp={(event) => {
            const pending = press.current
            if (event.button !== 0 || !pending || pending.pointerId !== event.pointerId) return
            press.current = null
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
            if (!pending.dragged && !pending.scrollbar && pending.action) {
              const pos = point(event)
              const released = hitTest(scene.current, pos.x, pos.y + event.currentTarget.scrollTop)
              if (released && JSON.stringify(released.action) === JSON.stringify(pending.action))
                act(pending.action)
            }
            if (
              !pending.dragged &&
              !pending.scrollbar &&
              !pending.action &&
              !pending.touch &&
              pending.anchor
            )
              lastClick.current = {
                at: event.timeStamp,
                x: pending.x,
                y: pending.y,
                anchor: pending.anchor
              }
            else lastClick.current = null
            if (selection.current && selectionCollapsed(selection.current)) selection.current = null
            updateHover()
            requestPaint()
          }}
          onPointerCancel={() => {
            press.current = null
            requestPaint()
          }}
          onLostPointerCapture={() => {
            press.current = null
          }}
          onPointerLeave={() => {
            pointer.current = null
            updateHover()
            requestPaint()
          }}
          onBlur={() => {
            press.current = null
          }}
          onCopy={(event) => {
            if (!selection.current || selectionCollapsed(selection.current)) return
            event.clipboardData.setData(
              'text/plain',
              selectionText(scene.current, selection.current)
            )
            event.preventDefault()
          }}
          onKeyDown={(event) => {
            if (event.target !== scroller.current) return
            const modifier = event.ctrlKey || event.metaKey
            if (modifier && event.key.toLowerCase() === 'a') {
              event.preventDefault()
              selectAll()
            }
            if (
              modifier &&
              event.key.toLowerCase() === 'c' &&
              selection.current &&
              !selectionCollapsed(selection.current)
            ) {
              event.preventDefault()
              copy(selectionText(scene.current, selection.current))
            }
            if (event.key === 'Escape') {
              selection.current = null
              requestPaint()
            }
            const inner = scene.current.blocks
              .flatMap((b) => b.scrollRegions)
              .find((r) => r.id === focusedScroll.current)
            if (!inner || modifier) return
            const delta =
              event.key === 'ArrowDown'
                ? 20
                : event.key === 'ArrowUp'
                  ? -20
                  : event.key === 'PageDown'
                    ? inner.h * 0.8
                    : event.key === 'PageUp'
                      ? -inner.h * 0.8
                      : 0
            if (delta && setScroll(inner, inner.left, inner.top + delta)) event.preventDefault()
            if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault()
              setScroll(inner, inner.left, event.key === 'Home' ? 0 : inner.contentHeight)
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            press.current = null
            event.currentTarget.focus({ preventScroll: true })
            const pos = point(event)
            const y = pos.y + event.currentTarget.scrollTop
            const hit = hitTest(scene.current, pos.x, y)
            const selected =
              selection.current && !selectionCollapsed(selection.current)
                ? selectionText(scene.current, selection.current)
                : ''
            const inner = scrollAt(pos.x, y)
            const block = scene.current.blocks.find((b) => y >= b.y && y < b.y + b.height)
            const modifier = document.documentElement.dataset.platform === 'darwin' ? 'Cmd' : 'Ctrl'
            const items: CanvasMenuItem[] = []
            if (selected)
              items.push({
                label: t('transcript.copySelection'),
                run: () => copy(selected),
                accelerator: `${modifier}+C`
              })
            if (hit?.action.type === 'link') {
              const href = hit.action.href
              items.push(
                { label: t('transcript.openLink'), run: () => openLink(href) },
                { label: t('remote.copyLink'), run: () => copy(href) }
              )
            }
            if (inner?.copyActions) {
              items.push(
                ...inner.copyActions.map(({ label, text }) => ({ label, run: () => copy(text) }))
              )
              const doc = view.current.diffs.get(inner.id)?.document
              if (doc)
                items.push({
                  label: t('diff.copyPatch'),
                  run: () => {
                    const patch = diffPatch(doc)
                    if (patch !== null) copy(patch)
                    else setStatus(t('diff.patchTooLarge'))
                  }
                })
            } else if (block?.copyText)
              items.push({ label: t('transcript.copyMessage'), run: () => copy(block.copyText!()) })
            items.push({
              label: t('transcript.selectAll'),
              run: selectAll,
              disabled: !scene.current.blocks.some((b) => b.selectable.length),
              accelerator: `${modifier}+A`
            })
            setMenu({ x: event.clientX, y: event.clientY, items })
          }}
        >
          <canvas
            ref={canvas}
            aria-hidden
            style={{
              position: 'sticky',
              top: 0,
              display: 'block',
              width: size.width,
              maxWidth: '100%',
              height: size.height,
              pointerEvents: 'none'
            }}
          />
          <div ref={spacer} aria-hidden style={{ width: 1 }} />
          <div
            ref={mirror}
            className="sr-only"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 1,
              height: 1,
              overflow: 'hidden',
              clipPath: 'inset(50%)',
              whiteSpace: 'pre-wrap'
            }}
          />
          <div className="sr-only" role="status">
            {status}
          </div>
        </div>
        {prompts.length > 0 && (
          <PromptHistoryRail
            key={sceneKey}
            entries={prompts}
            activeId={activePromptId}
            height={size.height}
            onJump={jumpToPrompt}
          />
        )}
      </div>
      {menu && <CanvasMenu {...menu} onClose={closeMenu} />}
      {image && (
        <dialog
          ref={imageDialog}
          className="m-auto max-h-[90vh] max-w-[90vw] rounded-xl border border-border bg-surface p-3 text-text backdrop:bg-black/60"
          aria-label={t('transcript.openImage')}
          onClose={() => setImage(null)}
          onClick={(event) => {
            if (event.target === event.currentTarget) event.currentTarget.close()
          }}
        >
          <button
            type="button"
            className="mb-2 ml-auto block rounded px-2 py-1 text-xs hover:bg-white/5"
            onClick={() => imageDialog.current?.close()}
          >
            {t('common.close')}
          </button>
          <img
            src={image}
            alt={t('transcript.openImage')}
            className="max-h-[78vh] max-w-full object-contain"
          />
        </dialog>
      )}
    </>
  )
}
