import fs from 'node:fs'
let text = fs.readFileSync('src/renderer/src/lib/store.ts', 'utf8')

// Add reviewPaneWidth
text = text.replace(
  /reviewPaneOpen: boolean\r?\n\s*setReviewPaneOpen: \(open: boolean\) => void\r?\n/,
  "reviewPaneOpen: boolean\n  setReviewPaneOpen: (open: boolean) => void\n  reviewPaneWidth: number\n  setReviewPaneWidth: (width: number) => void\n"
)

text = text.replace(
  /reviewPaneOpen: false,\r?\n\s*setReviewPaneOpen: \(open\) => set\(\{ reviewPaneOpen: open \}\),\r?\n/,
  "reviewPaneOpen: false,\n  setReviewPaneOpen: (open) => set({ reviewPaneOpen: open }),\n  reviewPaneWidth: 420,\n  setReviewPaneWidth: (width) => set({ reviewPaneWidth: width }),\n"
)

fs.writeFileSync('src/renderer/src/lib/store.ts', text, 'utf8')
