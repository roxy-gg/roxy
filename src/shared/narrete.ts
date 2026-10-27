import type { QueueImage } from './types'

export const NARRETE_NOTE_LIMIT = 800

export type NarreteRegion = { dataUrl: string; note: string }

export type NarreteSelection = { x: number; y: number; width: number; height: number }

export type NarreteResult =
  | { ok: true }
  | {
      ok: false
      error:
        | 'cancelled'
        | 'busy'
        | 'permissionDenied'
        | 'inputPermissionDenied'
        | 'unsupported'
        | 'captureFailed'
        | 'sendFailed'
    }

export type NarreteCaptureResult =
  | { ok: true; text: string; image: QueueImage }
  | Exclude<NarreteResult, { ok: true }>

export type NarreteSurface = {
  chatId: string
  language: string
  note: string
  regions: NarreteRegion[]
  selection: NarreteSelection | null
  previewDataUrl: string | null
  error?: 'captureFailed'
  revision: number
}

export interface NarreteOverlayApi {
  state(): Promise<NarreteSurface>
  ready(): Promise<void>
  layout(revision: number, rectangles: NarreteSelection[]): Promise<void>
  refresh(note: string, selection?: NarreteSelection): Promise<NarreteResult>
  submit(selection: NarreteSelection | null, note: string): Promise<NarreteResult>
  cancel(): Promise<void>
  onReset(callback: (surface: NarreteSurface) => void): () => void
  onDrag(callback: (selection: NarreteSelection | null) => void): () => void
}

/** Ignore clicks, thin text selections, and small accidental pointer movement. */
export function narreteDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
  bounds: NarreteSelection
): NarreteSelection | null {
  const left = Math.max(bounds.x, Math.min(start.x, end.x))
  const top = Math.max(bounds.y, Math.min(start.y, end.y))
  const right = Math.min(bounds.x + bounds.width, Math.max(start.x, end.x))
  const bottom = Math.min(bounds.y + bounds.height, Math.max(start.y, end.y))
  if (right - left < 24 || bottom - top < 24) return null
  return {
    x: (left - bounds.x) / bounds.width,
    y: (top - bounds.y) / bounds.height,
    width: (right - left) / bounds.width,
    height: (bottom - top) / bounds.height
  }
}

/** Selection coordinates are fractions of the frozen image, not desktop DIP. */
export function narreteCrop(
  selection: NarreteSelection,
  width: number,
  height: number
): NarreteSelection | null {
  const { x, y, width: w, height: h } = selection
  if (
    ![x, y, w, h, width, height].every(Number.isFinite) ||
    width < 1 ||
    height < 1 ||
    x < 0 ||
    y < 0 ||
    w <= 0 ||
    h <= 0 ||
    x + w > 1.000001 ||
    y + h > 1.000001
  )
    return null
  const left = Math.min(width - 1, Math.floor(x * width))
  const top = Math.min(height - 1, Math.floor(y * height))
  const right = Math.min(width, Math.ceil((x + w) * width))
  const bottom = Math.min(height, Math.ceil((y + h) * height))
  return right - left >= 8 && bottom - top >= 8
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null
}
