export type NarretePointer =
  | {
      type: 'down' | 'move' | 'up'
      button: number
      ctrlKey: boolean
      altKey: boolean
      x: number
      y: number
    }
  | { type: 'modifiers'; ctrlKey: boolean; altKey: boolean }

/** Load the native listener only for an explicitly started capture session.
 * Events are observed, never suppressed, recorded or replayed. The overlay
 * intercepts capture drags by arming on Ctrl before the mouse goes down. */
export async function listenNarreteInput(
  pointer: (event: NarretePointer) => void,
  escape: () => void
): Promise<() => void> {
  const { uIOhook, UiohookKey } = await import('uiohook-napi')
  type Mouse = { button: unknown; ctrlKey: boolean; altKey: boolean; x: number; y: number }
  const down = (event: Mouse): void =>
    pointer({
      button: Number(event.button),
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      x: event.x,
      y: event.y,
      type: 'down'
    })
  const move = (event: Mouse): void =>
    pointer({
      button: Number(event.button),
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      x: event.x,
      y: event.y,
      type: 'move'
    })
  const up = (event: Mouse): void =>
    pointer({
      button: Number(event.button),
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      x: event.x,
      y: event.y,
      type: 'up'
    })
  const modifiers = (event: { ctrlKey: boolean; altKey: boolean }): void => {
    pointer({ type: 'modifiers', ctrlKey: event.ctrlKey, altKey: event.altKey })
  }
  const key = (event: { keycode: number; ctrlKey: boolean; altKey: boolean }): void => {
    modifiers(event)
    if (event.keycode === UiohookKey.Escape) escape()
  }
  const stop = (): void => {
    uIOhook.removeListener('keyup', modifiers)
    uIOhook.removeListener('mousedown', down)
    uIOhook.removeListener('mousemove', move)
    uIOhook.removeListener('mouseup', up)
    uIOhook.removeListener('keydown', key)
    uIOhook.stop()
  }
  try {
    uIOhook
      .on('mousedown', down)
      .on('mousemove', move)
      .on('mouseup', up)
      .on('keydown', key)
      .on('keyup', modifiers)
    uIOhook.start()
    return stop
  } catch (error) {
    stop()
    throw error
  }
}
