import { useEffect, useState } from 'react'
import { observeTheme } from '../../canvas/theme'
import { PALETTE, seedFromRgb, type Rgb, type Seed } from './palette'

let probe: CanvasRenderingContext2D | null | undefined

/**
 * Resolve any CSS color to sRGB bytes by painting one pixel.
 *
 * A theme may set `--color-accent` as hex, `rgb()`, `oklch()`, or anything
 * else CSS accepts, and the custom property's computed value is just that
 * text. Rather than parse every syntax, let the canvas rasterize it and read
 * the pixel back. `willReadFrequently` keeps the tiny canvas on the CPU.
 */
function toRgb(color: string): Rgb | null {
  if (!color) return null
  if (probe === undefined) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    probe = canvas.getContext('2d', { willReadFrequently: true })
  }
  if (!probe) return null
  probe.clearRect(0, 0, 1, 1)
  // An unparseable value leaves fillStyle unchanged. Reset to a fully
  // transparent sentinel first, so a failed parse paints alpha 0 and falls
  // back below -- an opaque sentinel would be indistinguishable from a real
  // (black) accent.
  probe.fillStyle = 'rgba(0, 0, 0, 0)'
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
  return a === 0 ? null : [r, g, b]
}

function readAccentSeed(): Seed {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  const rgb = toRgb(value)
  return rgb ? seedFromRgb(rgb) : PALETTE.blue
}

/**
 * The dither seed for the active theme's accent, kept live across theme
 * switches (including a user theme file reloading). Backs `color: 'accent'`.
 */
export function useAccentSeed(): Seed {
  const [seed, setSeed] = useState(readAccentSeed)
  useEffect(
    () =>
      observeTheme(() =>
        setSeed((prev) => {
          const next = readAccentSeed()
          return prev.fill.every((v, i) => v === next.fill[i]) ? prev : next
        })
      ),
    []
  )
  return seed
}
