/**
 * Layout constants — the canvas transcript's spacing scale.
 *
 * Every number here traces back to a Tailwind class in the DOM transcript it
 * replaces, so the canvas lands on the same rhythm rather than a new one that
 * happens to look close. The comment on each says which class it came from;
 * Tailwind's scale is 0.25rem per step at a 16px root, so `py-1.5` is 6px.
 *
 * Keeping them in one file matters more here than it would in CSS: canvas has no
 * cascade, so a value used by three blocks is genuinely written three times
 * unless it lives somewhere shared.
 */

export const SPACE = {
  /** `px-4` — the transcript column's horizontal padding. */
  columnPadX: 16,
  /** `max-w-3xl` — the column's measure. */
  columnMax: 768,
  /** `pt-4` / `pb-6` on the message column. */
  columnPadTop: 16,
  columnPadBottom: 24,

  /** `gap-3` between a message's avatar and its body. */
  avatarGap: 12,
  /** `h-7 w-7` avatar. */
  avatar: 28,
  /** `py-3 px-1` on a message row. */
  messagePadY: 12,
  messagePadX: 4,
  /** `gap-1` between the parts of a turn. */
  partGap: 4,

  /** `my-1.5` on a tool card. */
  cardMarginY: 6,
  /** `px-2.5 py-1.5` on a tool card header. */
  cardPadX: 10,
  cardPadY: 6,
  /** `gap-2` inside a card header. */
  headerGap: 8,
  /** `px-3 py-2` on a card body. */
  bodyPadX: 12,
  bodyPadY: 8,

  /** `rounded-lg` = 8px; the squircle scale is applied at paint. */
  radiusLg: 8,
  radiusMd: 6,
  radiusSm: 4,
  radiusBase: 4
} as const

export const SIZE = {
  /** `h-3.5 w-3.5` — chevrons, status icons. */
  iconSm: 14,
  /** `h-4 w-4` — a tool's own icon. */
  icon: 16,
  /** `h-3 w-3` — the smallest badges. */
  iconXs: 12,
  /** `max-h-72` — a plain output pane. */
  outputMax: 288,
  /** `max-h-96` — a diff or an image. */
  diffMax: 384,
  /** `max-h-[28rem]` — a nested subagent transcript. */
  nestedMax: 448
} as const

export const FONT_SIZE = {
  /** `text-sm` — prose. */
  body: 14,
  /** `text-xs` — tool names, titles, code. */
  small: 12,
  /** `text-[11px]` — the activity line. */
  tiny: 11,
  /** `text-[10px]` — step counts, section labels. */
  micro: 10,
  /** Headings, `text-base`/`text-lg` etc. */
  h1: 22,
  h2: 19,
  h3: 16,
  h4: 14,
  h5: 13,
  h6: 12
} as const
