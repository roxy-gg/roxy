import { useEffect, useRef } from 'react'
import { Copy } from 'lucide-react'
import {
  ContextMenuRow,
  ContextMenuSurface,
  CONTEXT_MENU_PAD,
  CONTEXT_ROW_H
} from '../components/ContextMenu'

export interface CanvasMenuItem {
  label: string
  run: () => void
  disabled?: boolean
  accelerator?: string
}

export function CanvasMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: CanvasMenuItem[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let index = -1
    const onKey = (event: KeyboardEvent): void => {
      const buttons = Array.from(
        ref.current?.querySelectorAll('button:not(:disabled)') ?? []
      ) as HTMLButtonElement[]
      if (!buttons.length) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        index = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[index].focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return (
    <ContextMenuSurface
      x={x}
      y={y}
      height={items.length * CONTEXT_ROW_H + CONTEXT_MENU_PAD}
      onClose={onClose}
    >
      <div ref={ref} role="menu" data-canvas-menu>
        {items.map((item) => (
          <ContextMenuRow
            key={item.label}
            label={item.label}
            icon={Copy}
            preserveFocus
            disabled={item.disabled}
            accelerator={item.accelerator}
            onSelect={() => {
              onClose()
              item.run()
            }}
          />
        ))}
      </div>
    </ContextMenuSurface>
  )
}
