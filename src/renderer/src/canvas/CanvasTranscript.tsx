/**
 * The canvas transcript.
 *
 * Replaces the DOM message list: one <canvas> that draws the whole conversation
 * and handles its own scrolling, hovering, expanding, selection and copy.
 *
 * Why canvas at all: the DOM transcript's cost grew with the amount of content,
 * not with what was visible. A turn with thirty tool cards is a few hundred
 * elements, each with borders, shadows and a syntax-highlighted body in a shadow
 * root, and every streamed token re-rendered the live turn and re-laid-out the
 * page around it. Canvas makes the cost proportional to the VIEWPORT: layout
 * runs when content changes, paint touches only the blocks the viewport
 * intersects, and a settled message's layout is cached by reference so streaming
 * never re-measures the history above it.
 *
 * What that gives up, and how it is paid back:
 *   - native text selection → reimplemented (drag to select, ⌘/Ctrl+A, copy)
 *   - native scrolling      → a scroller div sized to the scene, with the canvas
 *                             pinned inside it, so the platform scrollbar,
 *                             momentum and trackpad behaviour are all real
 *   - accessibility         → a live text mirror is kept in the DOM for screen
 *                             readers and for the browser's own find-in-page
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message, MessagePart } from '@shared/types'
import { getTool } from '@shared/tools'
import { TextMetrics } from './text'
import { observeTheme, readTheme, type CanvasTheme } from './theme'
import { BlockCache, layoutTranscript, type ViewState } from './transcript'
import {
  hasAnimation,
  hitTest,
  hitText,
  paintScene,
  selectionText,
  type SelectionRange
} from './renderer'
import type { HitRegion, Scene } from './scene'
import roxyLogo from '../assets/roxy.png'

/** What the renderer exposes for tests. See `debug` below. */
export interface CanvasProbe {
  debug: { frames: number; layouts: number }
  scene: () => Scene
  size: () => { width: number; height: number }
}

export interface CanvasTranscriptProps {
  messages: Message[]
  streaming: MessagePart[] | null
  /** Cancel a subagent by its session id (a live `task` card). */
  onCancelSubagent: (subChatId: string) => void
  /** Cancel one tool call by its call id. */
  onCancelTool: (callId: string) => void
  /** Called when the user scrolls, so the parent can track stick-to-bottom. */
  onScrollStateChange?: (atBottom: boolean) => void
  /** Bumped by the parent to force a scroll to the newest message. */
  pinSignal: number
  /** Identity of the session, so view state resets on a switch. */
  chatId: string | null
}

export function CanvasTranscript({
  messages,
  streaming,
  onCancelSubagent,
  onCancelTool,
  onScrollStateChange,
  pinSignal,
  chatId
}: CanvasTranscriptProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { t } = useTranslation()
  const [theme, setTheme] = useState<CanvasTheme>(() => readTheme())
  const [size, setSize] = useState({ width: 0, height: 0 })

  // View state is a ref, not state: expanding a card must trigger a re-layout,
  // but the sets themselves are mutated in place and a paint is requested by
  // hand. Putting them in useState would clone a Set on every toggle for no
  // benefit — nothing renders off them except this canvas.
  const view = useRef<ViewState>({
    open: new Set(),
    openReasoning: new Set(),
    startedAt: new Map(),
    images: new Map()
  })
  const cache = useRef(new BlockCache())
  const sceneRef = useRef<Scene>({ blocks: [], height: 0, width: 0 })
  const hoveredRef = useRef<HitRegion | null>(null)
  const selectionRef = useRef<SelectionRange | null>(null)
  const draggingRef = useRef(false)
  const frameRef = useRef(0)
  const dirtyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const stickRef = useRef(true)
  /**
   * The current frame's draw function.
   *
   * Held so an interaction can paint SYNCHRONOUSLY rather than waiting for the
   * next animation frame. Scrolling and hovering are the cases that matter:
   * a wheel event that only marks the scene dirty leaves the canvas showing the
   * previous offset until rAF runs, which reads as the content lagging a frame
   * behind the scrollbar.
   */
  const paintRef = useRef<((force: boolean) => boolean) | null>(null)

  const metrics = useMemo(() => new TextMetrics(theme), [theme])

  /**
   * A test seam: frame counters and the live scene, hung off `window`.
   *
   * A canvas exposes nothing to the DOM, so from the outside "did this paint,
   * and did it lay out what I expected?" is otherwise unanswerable — which is
   * exactly the class of bug a canvas rewrite produces. Two integers and two
   * getters make the renderer assertable (see `test/canvas`), and cost nothing
   * at runtime.
   */
  const debug = useMemo(() => ({ frames: 0, layouts: 0 }), [])
  useEffect(() => {
    const probe: CanvasProbe = { debug, scene: () => sceneRef.current, size: () => size }
    ;(window as Window & { __canvasTranscript?: CanvasProbe }).__canvasTranscript = probe
  }, [debug, size])

  /**
   * The scene's height, mirrored into state.
   *
   * The scene itself lives in a ref (it is rebuilt inside the frame loop and
   * must not trigger a render), but the SPACER that gives the scrollport its
   * scrollable range is a DOM node, so its height has to go through React. This
   * is set only when the value actually changes, which is what stops the frame
   * loop and the reconciler from driving each other in a circle.
   */
  const [sceneHeight, setSceneHeight] = useState(0)

  // The assistant avatar, decoded once.
  const avatars = useRef<{ assistant: HTMLImageElement | null }>({ assistant: null })
  useEffect(() => {
    const img = new Image()
    img.src = roxyLogo
    img.onload = () => {
      avatars.current.assistant = img
      view.current.images.set('__roxy__', img)
      invalidate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Request a repaint on the next frame. */
  const invalidate = useCallback((): void => {
    dirtyRef.current = true
  }, [])

  /**
   * Re-layout and repaint NOW.
   *
   * Expanding a card is a direct response to a click, so it has to land in the
   * same frame — deferring it to the loop puts a frame of nothing between the
   * click and the card opening, which reads as lag on the one interaction the
   * transcript has.
   */
  const relayout = useCallback((): void => {
    cache.current.clear()
    dirtyRef.current = true
    paintRef.current?.(true)
  }, [])

  // A session switch drops every scrap of view state: expanded cards belong to
  // the transcript they were opened in, and a stale `startedAt` would make a
  // fresh call look like it had already been running for a minute.
  useLayoutEffect(() => {
    view.current.open.clear()
    view.current.openReasoning.clear()
    view.current.startedAt.clear()
    cache.current.clear()
    selectionRef.current = null
    stickRef.current = true
    relayout()
  }, [chatId, relayout])

  useEffect(() => observeTheme(setTheme), [])
  useEffect(() => {
    cache.current.clear()
    invalidate()
  }, [theme, invalidate])

  // Track the scrollport's size. The canvas is sized to the VIEWPORT, not to the
  // scene: a canvas as tall as a long transcript would be tens of thousands of
  // pixels and blow past the maximum texture size, so it stays viewport-sized
  // and the scene is drawn through it at an offset.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observe = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect()
      setSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height }
      )
    })
    observe.observe(el)
    const rect = el.getBoundingClientRect()
    setSize({ width: rect.width, height: rect.height })
    return () => observe.disconnect()
  }, [])

  // Width changes re-wrap everything.
  useEffect(() => {
    cache.current.clear()
    invalidate()
  }, [size.width, invalidate])

  useEffect(() => {
    cache.current.prune(messages)
    invalidate()
  }, [messages, streaming, invalidate])

  /** Whether a running call can actually be cancelled. */
  const canCancel = useCallback((part: Extract<MessagePart, { type: 'tool' }>): boolean => {
    if (part.tool === 'task') return Boolean(part.subChatId)
    // Trust the flag the harness set at tool-start; fall back to the catalog
    // for rows written before it existed.
    if (part.cancellable !== undefined) return part.cancellable && Boolean(part.callId)
    return Boolean(getTool(part.tool)?.interruptible) && Boolean(part.callId)
  }, [])

  /** Build the scene. Called from the frame loop when something changed. */
  const buildScene = useCallback(
    (now: number): Scene => {
      const scene = layoutTranscript(
        {
          messages,
          streaming,
          width: size.width,
          metrics,
          theme,
          view: view.current,
          now,
          canCancel,
          t
        },
        avatars.current,
        cache.current
      )
      sceneRef.current = scene
      debug.layouts++
      setSceneHeight((prev) => (prev === scene.height ? prev : scene.height))
      return scene
    },
    [messages, streaming, size.width, metrics, theme, canCancel, debug, t]
  )

  /**
   * The frame loop.
   *
   * One rAF for the lifetime of the component rather than a scheduled paint per
   * change: a streaming turn changes many times per frame, and coalescing into
   * the frame is both simpler and strictly fewer paints. When nothing is dirty
   * and nothing on screen animates, the loop does no work at all — it is not a
   * busy render loop.
   *
   * The FIRST paint is synchronous, not scheduled. Waiting a frame to draw
   * anything means the pane is empty for the duration of that frame, which is
   * visible as a flash of background every time you switch sessions — and if the
   * window is not being composited at all (an occluded or offscreen window never
   * fires rAF) it would never paint at all. Committing on mount and then handing
   * over to the loop removes both.
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let running = true

    /** Draw one frame. Returns false when there was nothing to do. */
    const draw = (force: boolean): boolean => {
      const now = performance.now()
      const scene = dirtyRef.current || force ? buildScene(now) : sceneRef.current
      const animating = hasAnimation(scene, scrollTopRef.current, size.height)
      if (!dirtyRef.current && !animating && !force) return false
      dirtyRef.current = false
      debug.frames++

      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      const dpr = window.devicePixelRatio || 1
      const targetW = Math.max(1, Math.round(size.width * dpr))
      const targetH = Math.max(1, Math.round(size.height * dpr))
      // Resizing a canvas clears it, so only do it when the size really changed.
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paintScene(scene, {
        ctx,
        theme,
        scrollTop: scrollTopRef.current,
        viewportHeight: size.height,
        now,
        hovered: hoveredRef.current,
        images: view.current.images,
        selection: selectionRef.current
      })
      return true
    }

    paintRef.current = draw
    if (size.width > 0 && size.height > 0) draw(true)

    const tick = (): void => {
      if (!running) return
      frameRef.current = requestAnimationFrame(tick)
      draw(false)
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => {
      running = false
      paintRef.current = null
      cancelAnimationFrame(frameRef.current)
    }
  }, [buildScene, size.width, size.height, theme, debug])

  // Decode images referenced by the scene. Kept out of layout: a decode is
  // async, and layout must be synchronous to produce a frame.
  useEffect(() => {
    const wanted = new Set<string>()
    const collect = (parts: MessagePart[]): void => {
      for (const part of parts) {
        if (part.type === 'image') wanted.add(part.dataUrl)
        else if (part.type === 'tool') {
          if (part.image) wanted.add(part.image)
          if (part.children) collect(part.children)
        }
      }
    }
    for (const message of messages) collect(message.parts)
    if (streaming) collect(streaming)

    for (const src of wanted) {
      if (view.current.images.has(src)) continue
      const img = new Image()
      // Marked present immediately so a slow decode cannot queue the same image
      // once per frame.
      view.current.images.set(src, img)
      img.onload = () => {
        cache.current.clear()
        invalidate()
      }
      img.src = src
    }
  }, [messages, streaming, invalidate])

  // ---- scrolling -----------------------------------------------------------

  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    scrollTopRef.current = el.scrollTop
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stickRef.current = atBottom
    onScrollStateChange?.(atBottom)
    // Painted here rather than left to the next frame: a scroll handler already
    // runs in the frame the browser is compositing, so drawing now puts the
    // content and the scrollbar on the same frame instead of one behind.
    dirtyRef.current = true
    paintRef.current?.(false)
  }, [onScrollStateChange])

  /** Jump to the newest message. */
  const pin = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    scrollTopRef.current = el.scrollTop
    invalidate()
  }, [invalidate])

  useLayoutEffect(() => {
    pin()
  }, [pinSignal, pin])

  // Follow the tail while pinned. Runs on layout so the jump is never a visible
  // frame, and re-pins on the next frame because content settles late (an image
  // decoding is the usual culprit).
  useLayoutEffect(() => {
    if (!stickRef.current) return
    pin()
    const frame = requestAnimationFrame(() => {
      if (stickRef.current) pin()
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, streaming, size.height, pin])

  // ---- pointer -------------------------------------------------------------

  /** Point in transcript space. */
  const pointAt = useCallback(
    (event: {
      clientX: number
      clientY: number
    }): {
      x: number
      y: number
    } => {
      const el = scrollRef.current
      if (!el) return { x: 0, y: 0 }
      const rect = el.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top + el.scrollTop }
    },
    []
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const { x, y } = pointAt(event)
      if (draggingRef.current && selectionRef.current) {
        const hit = hitText(sceneRef.current, x, y)
        if (hit) {
          selectionRef.current = {
            ...selectionRef.current,
            endLine: hit.line,
            endChar: hit.char
          }
          invalidate()
        }
        return
      }
      const region = hitTest(sceneRef.current, x, y)
      if (region !== hoveredRef.current) {
        hoveredRef.current = region
        invalidate()
      }
    },
    [pointAt, invalidate]
  )

  const onPointerLeave = useCallback((): void => {
    if (hoveredRef.current) {
      hoveredRef.current = null
      invalidate()
    }
  }, [invalidate])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      const { x, y } = pointAt(event)
      const region = hitTest(sceneRef.current, x, y)
      // A click on a control is a click, not the start of a selection — but the
      // ACTION fires on pointer-up, so a drag that starts on a card header and
      // ends elsewhere does not toggle it.
      if (region) {
        selectionRef.current = null
        invalidate()
        return
      }
      const hit = hitText(sceneRef.current, x, y)
      if (!hit) return
      draggingRef.current = true
      selectionRef.current = {
        startLine: hit.line,
        startChar: hit.char,
        endLine: hit.line,
        endChar: hit.char
      }
      // Capture so a drag that leaves the pane still tracks.
      ;(event.target as Element).setPointerCapture?.(event.pointerId)
      invalidate()
    },
    [pointAt, invalidate]
  )

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (draggingRef.current) {
        draggingRef.current = false
        // A click with no drag clears the selection rather than leaving a
        // zero-width one that swallows the next copy.
        const s = selectionRef.current
        if (s && s.startLine === s.endLine && s.startChar === s.endChar) {
          selectionRef.current = null
          invalidate()
        }
        return
      }
      const { x, y } = pointAt(event)
      const region = hitTest(sceneRef.current, x, y)
      if (!region) return
      const action = region.action
      if (action.type === 'toggle') {
        // Tool cards and reasoning blocks share one id namespace and one
        // handler; which SET an id belongs to is decided by looking the part up
        // rather than by tagging the region, so layout stays free of view state.
        const open = isReasoningId(action.id, messages, streaming)
          ? view.current.openReasoning
          : view.current.open
        if (open.has(action.id)) open.delete(action.id)
        else open.add(action.id)
        relayout()
        return
      }
      if (action.type === 'cancel') {
        const part = findToolPart(action.id, messages, streaming)
        if (!part) return
        if (part.tool === 'task' && part.subChatId) onCancelSubagent(part.subChatId)
        else if (part.callId) onCancelTool(part.callId)
        return
      }
      if (action.type === 'copy') {
        void navigator.clipboard.writeText(action.text).catch(() => {
          // Clipboard can be denied; the text is still selectable by hand.
        })
        return
      }
      if (action.type === 'link') {
        void window.open(action.href, '_blank', 'noopener,noreferrer')
        return
      }
      if (action.type === 'image') {
        void window.open(action.src, '_blank')
      }
    },
    [pointAt, invalidate, relayout, messages, streaming, onCancelSubagent, onCancelTool]
  )

  // ---- keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey
      if (!meta) return
      // Only claim the key when this pane owns the selection, so ⌘C in the
      // composer still copies what you typed.
      if (event.key === 'c' && selectionRef.current) {
        const text = selectionText(sceneRef.current, selectionRef.current)
        if (!text) return
        event.preventDefault()
        void navigator.clipboard.writeText(text).catch(() => {})
      }
      if (event.key === 'a' && scrollRef.current?.contains(document.activeElement)) {
        const blocks = sceneRef.current.blocks
        const lines = blocks.flatMap((b) => b.selectable)
        if (lines.length === 0) return
        event.preventDefault()
        selectionRef.current = {
          startLine: lines[0].index,
          startChar: 0,
          endLine: lines[lines.length - 1].index,
          endChar: lines[lines.length - 1].text.length
        }
        invalidate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [invalidate])

  const cursor = hoveredRef.current?.cursor ?? 'default'

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      tabIndex={0}
      // overflow-anchor off: this pane does its own scroll math and Chromium's
      // anchoring would apply a second correction on top of it.
      style={{ overflowAnchor: 'none', cursor }}
      className="relative min-h-0 flex-1 overflow-y-auto outline-none"
    >
      {/*
        The canvas is sticky at the top of the scrollport and the spacer below it
        supplies the rest of the scroll range, so the two together are exactly as
        tall as the scene.

        This is what keeps scrolling NATIVE. The platform scrollbar, wheel
        acceleration, trackpad momentum and rubber-banding are all the browser's,
        because the element genuinely is that tall — the canvas just stays put
        while the range moves underneath it. Driving the offset from wheel events
        onto a viewport-sized div is the usual shortcut here, and it is why canvas
        UIs so often feel wrong on a Mac.

        The canvas is also sized to the VIEWPORT, never to the scene: a long
        transcript is tens of thousands of pixels tall, well past the maximum
        texture size, and a canvas that large would fail to allocate.
      */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'sticky',
          top: 0,
          width: size.width,
          height: size.height,
          display: 'block',
          // Pointer events are handled on the scroller so the canvas never
          // swallows a scroll or a drag.
          pointerEvents: 'none'
        }}
      />
      <div style={{ height: Math.max(0, sceneHeight - size.height) }} aria-hidden />
      {/*
        A text mirror of the transcript, for screen readers and for the
        browser's own find-in-page — a canvas is opaque to both.

        Positioned ABSOLUTE rather than left in flow. Tailwind's `sr-only` clips
        an element to a 1px box but keeps it in the layout, and inside a scroll
        container that still contributes to scrollHeight: measured at 216px of
        phantom scroll range past the end of the transcript, which reads as the
        pane refusing to sit at the bottom. Taking it out of flow removes the
        contribution while keeping it in the accessibility tree.
      */}
      <div className="sr-only" aria-live="polite" style={{ position: 'absolute', top: 0, left: 0 }}>
        {messages.map((m) => (
          <p key={m.id}>{m.content}</p>
        ))}
      </div>
    </div>
  )
}

/** Whether an id refers to a reasoning part (rather than a tool card). */
function isReasoningId(id: string, messages: Message[], streaming: MessagePart[] | null): boolean {
  const part = findPart(id, messages, streaming)
  return part?.type === 'reasoning'
}

function findToolPart(
  id: string,
  messages: Message[],
  streaming: MessagePart[] | null
): Extract<MessagePart, { type: 'tool' }> | null {
  const part = findPart(id, messages, streaming)
  return part?.type === 'tool' ? part : null
}

/**
 * Resolve a layout id back to its part.
 *
 * Ids are paths — `<messageId>/<index>` and, for a subagent's steps,
 * `<messageId>/<index>/<index>`. Walking the path is how a click on a nested
 * card finds the part it belongs to without layout having to keep a side table.
 */
function findPart(
  id: string,
  messages: Message[],
  streaming: MessagePart[] | null
): MessagePart | null {
  const [messageId, ...path] = id.split('/')
  const parts =
    messageId === '__streaming__'
      ? streaming
      : (messages.find((m) => m.id === messageId)?.parts ?? null)
  if (!parts || path.length === 0) return null
  let current: MessagePart | undefined = parts[Number(path[0])]
  for (let i = 1; i < path.length; i++) {
    if (current?.type !== 'tool' || !current.children) return null
    current = current.children[Number(path[i])]
  }
  return current ?? null
}
