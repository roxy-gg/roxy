import { useEffect, useState } from 'react'
import { observeTheme } from '../../canvas/theme'
import { accentSeed, type Seed } from './palette'

/**
 * The dither seed for the active theme's accent, kept live across theme
 * switches (including a user theme file reloading). Backs `color: 'accent'`.
 */
export function useAccentSeed(): Seed {
  const [seed, setSeed] = useState(accentSeed)
  useEffect(
    () =>
      observeTheme(() =>
        setSeed((prev) => {
          const next = accentSeed()
          return prev.fill.every((v, i) => v === next.fill[i]) ? prev : next
        })
      ),
    []
  )
  return seed
}
