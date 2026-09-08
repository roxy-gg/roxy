import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { PromptEntry } from './prompt-history'
import './prompt-history.css'

const ROW = 24
const OVERSCAN = 2
const HOVER_DELAY = 120

/** A small navigation layer over the canvas, not another rendered message list. */
export function PromptHistoryRail({
  entries,
  activeId,
  height,
  onJump
}: {
  entries: PromptEntry[]
  activeId: string | null
  height: number
  onJump: (id: string) => void
}): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const tooltipId = useId()
  const nav = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const hovering = useRef(false)
  const keyboard = useRef(false)
  const pendingFocus = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const previewRef = useRef<string | null>(null)
  const [preview, setPreview] = useState<{ id: string; instant: boolean } | null>(null)
  const [placement, setPlacement] = useState({ left: 0, top: 0, origin: 'right center' })
  const [scrollTop, setScrollTop] = useState(0)
  const [focusId, setFocusId] = useState<string | null>(null)
  const activeIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.id === activeId)
  )
  const viewport = Math.min(entries.length * ROW, 336, Math.max(ROW, height - 32))
  const first = Math.max(
    0,
    Math.min(Math.max(0, entries.length - 1), Math.floor(scrollTop / ROW) - OVERSCAN)
  )
  const last = Math.min(entries.length, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN)
  const focusedIndex = entries.findIndex((entry) => entry.id === focusId)
  const tabIndex = Math.max(
    first,
    Math.min(last - 1, focusedIndex >= 0 ? focusedIndex : activeIndex)
  )
  const item = preview && entries.find((entry) => entry.id === preview.id)
  const itemIndex = item ? entries.indexOf(item) : -1
  const date = item ? new Date(item.createdAt) : null
  const dateTime = date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined
  const summary = (entry: PromptEntry): string =>
    entry.text ||
    (entry.images
      ? t('transcript.promptImages', { count: entry.images })
      : t('transcript.promptEmpty'))

  const close = useCallback(() => {
    clearTimeout(timer.current)
    previewRef.current = null
    setPreview(null)
  }, [])
  const leave = (): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(close, 100)
  }
  const show = (id: string, immediate = false): void => {
    clearTimeout(timer.current)
    const instant = immediate || previewRef.current !== null
    const open = (): void => {
      previewRef.current = id
      setPreview({ id, instant })
    }
    if (instant) open()
    else timer.current = setTimeout(open, HOVER_DELAY)
  }

  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', key)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', close)
    }
  }, [close])

  useLayoutEffect(() => {
    const el = list.current
    if (
      !el ||
      hovering.current ||
      (keyboard.current && nav.current?.contains(document.activeElement))
    )
      return
    const top = activeIndex * ROW
    if (top < el.scrollTop || top + ROW > el.scrollTop + viewport) {
      el.scrollTo({ top: Math.max(0, top - (viewport - ROW) / 2), behavior: 'instant' })
      setScrollTop(el.scrollTop)
    }
  }, [activeId, activeIndex, viewport, entries.length])

  useLayoutEffect(() => {
    if (!pendingFocus.current) return
    const button = buttons.current.get(pendingFocus.current)
    if (button) {
      pendingFocus.current = null
      button.focus({ preventScroll: true })
    }
  }, [first, last, focusId])

  useLayoutEffect(() => {
    if (!item || !tooltip.current) return
    const trigger = buttons.current.get(item.id)
    if (!trigger) {
      close()
      return
    }
    const position = (): void => {
      const rect = trigger.getBoundingClientRect()
      // Measure the untransformed box so its entrance scale cannot move the anchor.
      const box = tooltip.current!
      const top = Math.max(
        8,
        Math.min(
          rect.top + rect.height / 2 - box.offsetHeight / 2,
          window.innerHeight - box.offsetHeight - 8
        )
      )
      setPlacement({
        left: Math.max(8, rect.left - box.offsetWidth - 8),
        top,
        origin: `right ${rect.top + rect.height / 2 - top}px`
      })
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(tooltip.current)
    window.addEventListener('resize', close)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', close)
    }
  }, [item, close, height, viewport, scrollTop, i18n.language])

  if (!entries.length || height < 56) return null

  const timestamp = (entry: PromptEntry): string => {
    const date = new Date(entry.createdAt)
    if (Number.isNaN(date.getTime())) return ''
    const locale = i18n.resolvedLanguage || i18n.language
    const now = new Date()
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date)
    if (date.toDateString() === now.toDateString()) return t('transcript.promptToday', { time })
    if (date.toDateString() === yesterday.toDateString())
      return t('transcript.promptYesterday', { time })
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  }

  return (
    <>
      <nav
        ref={nav}
        className="prompt-history"
        aria-label={t('transcript.promptHistory')}
        data-prompt-history
        data-keyboard={keyboard.current || undefined}
        onPointerEnter={() => {
          hovering.current = true
        }}
        onPointerLeave={() => {
          hovering.current = false
          leave()
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocusId(null)
            close()
          }
        }}
        onKeyDown={(event) => {
          const current = entries.findIndex(
            (entry) => entry.id === (event.target as HTMLElement).dataset.promptId
          )
          if (current < 0) return
          const index =
            event.key === 'ArrowDown'
              ? Math.min(entries.length - 1, current + 1)
              : event.key === 'ArrowUp'
                ? Math.max(0, current - 1)
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? entries.length - 1
                    : -1
          if (index < 0) return
          event.preventDefault()
          keyboard.current = true
          const id = entries[index].id
          const el = list.current!
          if (index * ROW < el.scrollTop) el.scrollTop = index * ROW
          else if ((index + 1) * ROW > el.scrollTop + viewport)
            el.scrollTop = (index + 1) * ROW - viewport
          pendingFocus.current = id
          setScrollTop(el.scrollTop)
          setFocusId(id)
        }}
      >
        <div
          ref={list}
          className="prompt-history-list"
          style={{ height: viewport }}
          onWheel={() => {
            keyboard.current = false
            close()
          }}
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop)
            if (!keyboard.current || !nav.current?.contains(document.activeElement)) close()
          }}
        >
          <div style={{ height: entries.length * ROW, position: 'relative' }}>
            {entries.slice(first, last).map((entry, local) => {
              const index = first + local
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="prompt-history-marker"
                  ref={(button) => {
                    if (button) buttons.current.set(entry.id, button)
                    else buttons.current.delete(entry.id)
                  }}
                  data-prompt-id={entry.id}
                  data-preview={preview?.id === entry.id || undefined}
                  aria-label={t('transcript.promptJump', {
                    number: index + 1,
                    text: summary(entry)
                  })}
                  aria-describedby={preview?.id === entry.id ? tooltipId : undefined}
                  aria-current={activeId === entry.id ? 'location' : undefined}
                  tabIndex={index === tabIndex ? 0 : -1}
                  style={{ top: index * ROW, height: ROW }}
                  onPointerEnter={(event) => {
                    keyboard.current = false
                    if (event.pointerType !== 'touch') show(entry.id)
                  }}
                  onPointerDown={() => {
                    keyboard.current = false
                  }}
                  onFocus={(event) => {
                    setFocusId(entry.id)
                    if (event.currentTarget.matches(':focus-visible')) {
                      keyboard.current = true
                      show(entry.id, true)
                    }
                  }}
                  onClick={() => {
                    close()
                    onJump(entry.id)
                  }}
                >
                  <span aria-hidden />
                </button>
              )
            })}
          </div>
        </div>
        {scrollTop > 1 && (
          <span className="prompt-history-fade prompt-history-fade-top" aria-hidden />
        )}
        {scrollTop + viewport < entries.length * ROW - 1 && (
          <span className="prompt-history-fade prompt-history-fade-bottom" aria-hidden />
        )}
      </nav>
      {item &&
        createPortal(
          <div
            ref={tooltip}
            id={tooltipId}
            role="tooltip"
            data-prompt-preview
            className="prompt-history-preview sq-frame sq-lg sq-fill-elevated sq-ring edge edge-panel shadow-float"
            data-instant={preview?.instant || undefined}
            style={{ left: placement.left, top: placement.top, transformOrigin: placement.origin }}
            onPointerEnter={() => clearTimeout(timer.current)}
            onPointerLeave={leave}
          >
            <p dir="auto" className="prompt-history-summary">
              {summary(item)}
            </p>
            <div className="prompt-history-caption">
              <time dateTime={dateTime}>{timestamp(item)}</time>
              <span>
                {t('transcript.promptPosition', { number: itemIndex + 1, count: entries.length })}
              </span>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
