/**
 * The scene: what a laid-out transcript is.
 *
 * The renderer is retained-mode. Layout runs when something actually changes
 * (new parts, a resize, a card expanding, a theme switch) and produces a tree of
 * nodes with absolute geometry; paint then walks that tree and draws, doing no
 * measurement and allocating nothing. That split is the whole design — it is why
 * scrolling a thousand-message transcript costs the same as scrolling ten, and
 * why a streamed token only re-lays-out the turn it landed in.
 *
 * Nodes carry their own geometry in TRANSCRIPT space (y grows downward from the
 * top of the first message). Paint translates by the scroll offset; hit-testing
 * un-translates. Nothing stores viewport-relative coordinates, so scrolling
 * never invalidates layout.
 */

import type { Font, TextRun, WrappedLine } from './text'
import type { IconName } from './icons'
import type { AnsiSpan } from './ansi'
import type { DiffRow } from './diff'
import type { Token } from './highlight'

/** Where a click lands. The scene is walked front-to-back to resolve one. */
export type HitAction =
  | { type: 'toggle'; id: string }
  | { type: 'link'; href: string }
  | { type: 'cancel'; id: string }
  | { type: 'copy'; text: string }
  | { type: 'image'; src: string }
  | { type: 'scroll'; id: string }

export interface HitRegion {
  x: number
  y: number
  w: number
  h: number
  action: HitAction
  /** Painted as a hover wash when the pointer is inside. */
  hover?: 'card' | 'subtle' | 'none'
  cursor?: 'pointer' | 'text' | 'default'
  /** Tooltip text, shown after a dwell. */
  title?: string
}

/**
 * A selectable text line — the unit text selection works in.
 *
 * Selection is by (line index, character offset) rather than by pixel, so
 * dragging across a wrapped paragraph behaves like a text editor and copying
 * yields the source text with its original line breaks.
 */
export interface SelectableLine {
  /** Ordinal across the whole transcript, assigned during layout. */
  index: number
  x: number
  y: number
  height: number
  runs: TextRun[]
  /** The plain text of this line, used when building a copy payload. */
  text: string
  /** True when a newline should follow this line in copied output. */
  breakAfter: boolean
}

/** Every drawable. A discriminated union so paint is one exhaustive switch. */
export type Node =
  | {
      kind: 'rect'
      x: number
      y: number
      w: number
      h: number
      radius: number
      fill?: string
      border?: string
    }
  | { kind: 'hairline'; x: number; y: number; w: number; color: string }
  | { kind: 'vrule'; x: number; y: number; h: number; w: number; color: string }
  | {
      kind: 'text'
      x: number
      y: number
      text: string
      font: Font
      color: string
      align?: 'left' | 'right' | 'center'
      maxWidth?: number
    }
  | { kind: 'lines'; x: number; y: number; lines: WrappedLine[] }
  | {
      kind: 'icon'
      x: number
      y: number
      size: number
      name: IconName
      color: string
      rotate?: number
      opacity?: number
    }
  | { kind: 'iconFill'; x: number; y: number; size: number; name: IconName; color: string }
  | { kind: 'spinner'; x: number; y: number; size: number; color: string }
  | { kind: 'braille'; x: number; y: number; font: Font; color: string }
  | {
      kind: 'image'
      x: number
      y: number
      w: number
      h: number
      src: string
      radius: number
      border?: string
    }
  | {
      kind: 'code'
      x: number
      y: number
      w: number
      lineHeight: number
      font: Font
      rows: Token[][]
      colors: Record<string, string>
      gutter?: { width: number; color: string; start: number }
    }
  | {
      kind: 'ansi'
      x: number
      y: number
      w: number
      lineHeight: number
      font: Font
      rows: AnsiSpan[][]
      defaultColor: string
    }
  | {
      kind: 'diff'
      x: number
      y: number
      w: number
      lineHeight: number
      font: Font
      rows: DiffRow[]
      gutterWidth: number
      palette: DiffPalette
    }
  | { kind: 'clip'; x: number; y: number; w: number; h: number; radius: number; children: Node[] }
  | {
      kind: 'fade'
      x: number
      y: number
      w: number
      h: number
      color: string
      direction: 'up' | 'down'
    }
  /**
   * A subtree, optionally translated.
   *
   * The translation is what makes block reuse cheap: when an earlier message
   * grows, everything below it moves, and a cached block can be re-placed by
   * wrapping it in one offset group instead of rewriting the geometry of every
   * node inside it.
   */
  | { kind: 'group'; children: Node[]; offsetY?: number }
  /** Pulsing opacity — `animate-pulse`. Repaints while on screen. */
  | { kind: 'pulse'; children: Node[] }

export interface DiffPalette {
  addBg: string
  delBg: string
  addText: string
  delText: string
  gapBg: string
  gutter: string
  text: string
  marker: string
  gapText: string
}

/**
 * A laid-out block with its own vertical extent.
 *
 * The transcript is a list of these; virtualization slices it by `y`/`height`,
 * so only the blocks the viewport intersects are ever painted or hit-tested.
 */
export interface Block {
  /** Stable id — a message id, or a path to a part within one. */
  id: string
  y: number
  height: number
  nodes: Node[]
  regions: HitRegion[]
  selectable: SelectableLine[]
  /** True while this block is streaming, so paint knows to keep animating. */
  animated: boolean
}

export interface Scene {
  blocks: Block[]
  height: number
  width: number
}

/** Walk a node tree, in paint order. */
export function forEachNode(nodes: Node[], visit: (node: Node) => void): void {
  for (const node of nodes) {
    visit(node)
    if (node.kind === 'clip' || node.kind === 'group' || node.kind === 'pulse') {
      forEachNode(node.children, visit)
    }
  }
}
