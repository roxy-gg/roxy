import fs from 'node:fs'
let text = fs.readFileSync('src/renderer/src/components/ChangesChip.tsx', 'utf8')

// We will copy the exact class string from UsageMeter:
// 'press-scale flex h-7 items-center gap-1.5 sq sq-lg sq-ring rounded-lg border px-2 text-xs tabular-nums transition-colors'
// And the default states:
// 'border-border bg-surface text-text-muted hover:border-border-strong hover:[--sq-ring:var(--color-border-strong)] hover:text-text'

// Find the block:
// className="[-webkit-app-region:no-drag] press-scale flex shrink-0 items-center gap-1.5 sq sq-lg rounded-lg px-2 text-[11px] tabular-nums text-text-muted transition-colors hover:bg-white/5 hover:text-text"
// And replace with cn(...) just like UsageMeter

const oldClass = /className="\[-webkit-app-region:no-drag\] press-scale flex shrink-0 items-center gap-1\.5 sq sq-lg rounded-lg px-2 text-\[11px\] tabular-nums text-text-muted transition-colors hover:bg-white\/5 hover:text-text"/

const newClass = `className={cn(
        '[-webkit-app-region:no-drag] press-scale flex h-7 items-center gap-1.5 sq sq-lg sq-ring rounded-lg border px-2 text-xs tabular-nums transition-colors',
        reviewPaneOpen
          ? 'border-border-strong [--sq-ring:var(--color-border-strong)] bg-elevated text-text'
          : 'border-border bg-surface text-text-muted hover:border-border-strong hover:[--sq-ring:var(--color-border-strong)] hover:text-text'
      )}`

text = text.replace(oldClass, newClass)

// We need to import `cn` and use `reviewPaneOpen`
if (!text.includes("import { cn }")) {
  text = text.replace(
    "import { useRoxyStore } from '../lib/store'",
    "import { useRoxyStore } from '../lib/store'\nimport { cn } from '../lib/cn'"
  )
}

if (!text.includes("const reviewPaneOpen = useRoxyStore((s) => s.reviewPaneOpen)")) {
  text = text.replace(
    "const setReviewPaneOpen = useRoxyStore((s) => s.setReviewPaneOpen)",
    "const setReviewPaneOpen = useRoxyStore((s) => s.setReviewPaneOpen)\n  const reviewPaneOpen = useRoxyStore((s) => s.reviewPaneOpen)"
  )
}

// Ensure the word Changes is removed if it wasn't. Oh wait, it wasn't in the image!
// Ah, the image shows "Changes +457 -49", wait, it wasn't removed? Let me check changeschip.tsx.
fs.writeFileSync('src/renderer/src/components/ChangesChip.tsx', text, 'utf8')
