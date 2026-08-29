import fs from 'node:fs'
let text = fs.readFileSync('src/renderer/src/components/ChangesChip.tsx', 'utf8')

// If the word 'Changes' is still there, remove it. I see it in the fallback branch probably.
// Wait, the previous attempt might not have replaced everything correctly.

const block = `    <button
      type="button"
      onClick={() => setReviewPaneOpen(true)}
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
    </button>`

// Let's replace the whole return statement
text = text.replace(/return \(\r?\n\s*<button[^]*?<\/button>\r?\n\s*\)/m, `return (\n${block}\n  )`)

fs.writeFileSync('src/renderer/src/components/ChangesChip.tsx', text, 'utf8')
