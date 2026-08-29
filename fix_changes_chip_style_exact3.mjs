import fs from 'node:fs'
let text = fs.readFileSync('src/renderer/src/components/ChangesChip.tsx', 'utf8')

// The previous replace didn't work because the file actually had:
// return (
//     <div className="shrink-0 px-4 text-xs">
//       <div className="mx-auto max-w-3xl px-1">
//         <button ...>
//           <span>Changes</span>

text = text.replace(/return \(\r?\n\s*<div className="shrink-0 px-4 text-xs">[^]*?<\/div>\r?\n\s*\)/, `return (
    <button
      type="button"
      onClick={() => setReviewPaneOpen(!reviewPaneOpen)}
      title="Review these changes"
      className={cn(
        '[-webkit-app-region:no-drag] press-scale flex h-7 items-center gap-1.5 sq sq-lg sq-ring rounded-lg border px-2 text-xs tabular-nums transition-colors',
        reviewPaneOpen
          ? 'border-border-strong [--sq-ring:var(--color-border-strong)] bg-elevated text-text'
          : 'border-border bg-surface text-text-muted hover:border-border-strong hover:[--sq-ring:var(--color-border-strong)] hover:text-text'
      )}
    >
      <FileDiff className="h-3.5 w-3.5" />
      {counts && (counts.additions > 0 || counts.deletions > 0) ? (
        <span className="flex items-center gap-1">
          {counts.additions > 0 && <span className="text-success">+{counts.additions}</span>}
          {counts.deletions > 0 && <span className="text-danger">-{counts.deletions}</span>}
        </span>
      ) : (
        <span className="text-text-subtle">
          {changed} file{changed === 1 ? '' : 's'}
        </span>
      )}
    </button>
  )`)

fs.writeFileSync('src/renderer/src/components/ChangesChip.tsx', text, 'utf8')
