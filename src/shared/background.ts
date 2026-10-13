/** Device-local decoration, deliberately separate from portable theme files. */
export const BACKGROUND_EFFECTS = [
  'none',
  'dither',
  'ascii',
  'halftone',
  'scanlines',
  'haze'
] as const
export type BackgroundEffect = (typeof BACKGROUND_EFFECTS)[number]
export const SIDEBAR_STYLES = ['default', 'glass', 'dimmed'] as const
export type SidebarStyle = (typeof SIDEBAR_STYLES)[number]

export interface BackgroundSettings {
  effect: BackgroundEffect
  showOn: 'empty' | 'all'
  emptyOpacity: number
  sessionOpacity: number
  glass: boolean
  sidebarStyle: SidebarStyle
  sidebarOpacity: number
}

export interface BackgroundState {
  settings: BackgroundSettings
  /** Bounded device-local image/video data, never a path or remote URL. */
  image: string | null
  /** Decoded still frame for video effects and reduced motion. */
  poster?: string
}

export const DEFAULT_BACKGROUND: BackgroundSettings = {
  effect: 'none',
  showOn: 'all',
  emptyOpacity: 30,
  sessionOpacity: 15,
  glass: true,
  sidebarStyle: 'default',
  sidebarOpacity: 66
}

export type BackgroundResult =
  | { ok: true; state: BackgroundState }
  | { ok: false; error: 'invalidImage' | 'invalidVideo' | 'tooLarge' | 'readFailed' | 'saveFailed' }

export function normalizeBackground(value: unknown): BackgroundSettings {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const opacity = (key: 'emptyOpacity' | 'sessionOpacity' | 'sidebarOpacity'): number => {
    const n = input[key]
    return typeof n === 'number' && Number.isFinite(n)
      ? Math.round(Math.max(0, Math.min(100, n)))
      : DEFAULT_BACKGROUND[key]
  }
  return {
    effect: BACKGROUND_EFFECTS.includes(input.effect as BackgroundEffect)
      ? (input.effect as BackgroundEffect)
      : DEFAULT_BACKGROUND.effect,
    showOn: input.showOn === 'empty' ? 'empty' : 'all',
    emptyOpacity: opacity('emptyOpacity'),
    sessionOpacity: opacity('sessionOpacity'),
    glass: typeof input.glass === 'boolean' ? input.glass : DEFAULT_BACKGROUND.glass,
    sidebarStyle: SIDEBAR_STYLES.includes(input.sidebarStyle as SidebarStyle)
      ? (input.sidebarStyle as SidebarStyle)
      : DEFAULT_BACKGROUND.sidebarStyle,
    sidebarOpacity: opacity('sidebarOpacity')
  }
}

export function backgroundOpacity(settings: BackgroundSettings, empty: boolean): number {
  return (
    (empty ? settings.emptyOpacity : settings.showOn === 'all' ? settings.sessionOpacity : 0) / 100
  )
}

/** Ordered color quantization, not a dot texture laid over the original image. */
export function ditherPixels(data: Uint8ClampedArray, width: number): void {
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
  for (let i = 0; i < data.length; i += 4) {
    const pixel = i / 4
    const threshold =
      (bayer[(Math.floor(pixel / width) % 4) * 4 + ((pixel % width) % 4)] + 0.5) / 16 - 0.5
    for (let channel = 0; channel < 3; channel++) {
      data[i + channel] =
        Math.max(0, Math.min(3, Math.round(data[i + channel] / 85 + threshold))) * 85
    }
  }
}
