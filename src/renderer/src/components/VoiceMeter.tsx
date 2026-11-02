import { useEffect, useState } from 'react'
import { cn } from '../lib/cn'
import { useMotion } from '../lib/motion'

const BARS = 7
/** Bar width and resting height. Equal on purpose: at rest each bar is a perfect
 *  dot, and a flat row of dots still reads as "listening", never as a dead mic. */
const BAR_PX = 4
/** Tallest a bar gets; the track is exactly this tall. */
const MAX_PX = 18
const IDLE = Array.from({ length: BARS }, () => 0)

/**
 * The classic "recording" bars: a short rolling history of microphone loudness,
 * newest on the right, so speech visibly travels through the row instead of the
 * whole thing pulsing as one block.
 *
 * Each bar animates its real `height`, not `scaleY`: scaling stretches the
 * corners with the bar, so a short bar ends up with flattened tips. Animating
 * `height` keeps `rounded-full` a true semicircle at every level.
 *
 * Colour is `currentColor`, so the caller decides it with a theme token
 * (`text-accent` in the app) and a theme switch needs no work here. Decorative:
 * the mic button beside it already carries the label and `aria-pressed`.
 *
 * Levels arrive ~10x/s through `subscribe`; state lives here so only this
 * component re-renders. Heights glide between samples with a CSS transition,
 * which is dropped under reduced motion (the bars still show the level - that is
 * information - they just stop easing).
 */
export function VoiceMeter({
  subscribe,
  className
}: {
  subscribe: (listener: (level: number) => void) => () => void
  className?: string
}): JSX.Element {
  const { reduced } = useMotion()
  const [levels, setLevels] = useState<number[]>(IDLE)
  useEffect(
    () =>
      subscribe((level) =>
        setLevels((history) => [...history.slice(1), Math.min(1, Math.max(0, level))])
      ),
    [subscribe]
  )
  return (
    <span
      aria-hidden
      className={cn('flex items-center gap-[3px]', className)}
      style={{ height: MAX_PX }}
    >
      {levels.map((level, index) => (
        <span
          key={index}
          className={cn(
            'shrink-0 rounded-full bg-current',
            !reduced && 'transition-[height] duration-100 ease-out'
          )}
          style={{
            width: BAR_PX,
            height: BAR_PX + (MAX_PX - BAR_PX) * level,
            // Older samples fade, so the leading edge is the part you watch.
            opacity: 0.35 + (0.65 * (index + 1)) / BARS
          }}
        />
      ))}
    </span>
  )
}
