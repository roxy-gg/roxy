import { BracketsYellow, Markdown, TypeScript } from '@react-symbols/icons/files'
import { FileIcon as SymbolFileIcon } from '@react-symbols/icons/utils'

const EXTENSIONS = {
  cts: TypeScript,
  mts: TypeScript,
  jsonc: BracketsYellow,
  markdown: Markdown
}

export function FileIcon({ path }: { path: string }): JSX.Element {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return (
    <SymbolFileIcon
      fileName={name.startsWith('.env.') ? '.env' : name}
      autoAssign
      editFileExtensionData={EXTENSIONS}
      aria-hidden="true"
      focusable="false"
      className="h-4 w-4 shrink-0 text-text-subtle"
    />
  )
}
