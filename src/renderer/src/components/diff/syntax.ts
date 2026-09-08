import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import type { DiffDocument, DiffSyntax, SyntaxToken } from './model'

// Explicit imports keep the engine and grammars local/offline without bundling every language.
const languages = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs')
}
const aliases: Record<string, keyof typeof languages> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  cs: 'csharp',
  c: 'cpp',
  h: 'cpp',
  hpp: 'cpp'
}
let engine: ReturnType<typeof createHighlighterCore> | undefined

export async function highlightDiff(document: DiffDocument): Promise<DiffSyntax> {
  const ext =
    document.path
      .split(/[./\\]/)
      .pop()
      ?.toLowerCase() ?? ''
  const lang = aliases[ext] ?? (ext in languages ? (ext as keyof typeof languages) : undefined)
  const plain = (): DiffSyntax => ({
    before: document.beforeLines.map((line) => [{ text: line.text }]),
    after: document.afterLines.map((line) => [{ text: line.text }])
  })
  if (!lang || document.before.length + document.after.length > 400_000) return plain()
  engine ??= createHighlighterCore({
    themes: [import('shiki/themes/github-dark.mjs'), import('shiki/themes/github-light.mjs')],
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm'))
  })
  const highlighter = await engine
  await highlighter.loadLanguage(languages[lang]())
  const tokenize = (source: string): SyntaxToken[][] =>
    highlighter
      .codeToTokensWithThemes(source, {
        lang,
        themes: { dark: 'github-dark', light: 'github-light' },
        tokenizeMaxLineLength: 2000
      })
      .map((line) =>
        line.map((token) => ({
          text: token.content,
          dark: token.variants.dark.color,
          light: token.variants.light.color
        }))
      )
  return { before: tokenize(document.before), after: tokenize(document.after) }
}
