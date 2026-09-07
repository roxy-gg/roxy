/**
 * Syntax highlighting for canvas.
 *
 * `@pierre/diffs` (Shiki) renders into shadow DOM, so none of it is reachable
 * from a 2D context. This is a small hand-written tokenizer covering the
 * languages an agent actually reads and writes in this app — enough to make code
 * legible, which is the job, rather than a faithful TextMate grammar.
 *
 * It is regex-per-line and stateful only across block comments and template
 * strings, so highlighting a 2000-line file is linear and can run inside layout
 * without a worker.
 */

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'type'
  | 'operator'
  | 'punctuation'
  | 'property'
  | 'tag'
  | 'attribute'
  | 'variable'

export interface Token {
  text: string
  kind: TokenKind
}

/** Highlighter state that carries across lines (open block comment / template). */
export interface HlState {
  inBlockComment: boolean
  inTemplate: boolean
}

export const initialState = (): HlState => ({ inBlockComment: false, inTemplate: false })

type Family = 'c-like' | 'python' | 'shell' | 'markup' | 'css' | 'json' | 'sql' | 'plain'

const KEYWORDS: Record<string, string[]> = {
  'c-like': [
    'abstract',
    'any',
    'as',
    'async',
    'await',
    'boolean',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'constructor',
    'continue',
    'debugger',
    'declare',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'from',
    'function',
    'get',
    'if',
    'implements',
    'import',
    'in',
    'infer',
    'instanceof',
    'interface',
    'is',
    'keyof',
    'let',
    'namespace',
    'never',
    'new',
    'null',
    'number',
    'object',
    'of',
    'package',
    'private',
    'protected',
    'public',
    'readonly',
    'return',
    'satisfies',
    'set',
    'static',
    'string',
    'super',
    'switch',
    'symbol',
    'this',
    'throw',
    'true',
    'try',
    'type',
    'typeof',
    'undefined',
    'unique',
    'unknown',
    'var',
    'void',
    'while',
    'with',
    'yield',
    'struct',
    'impl',
    'fn',
    'mut',
    'pub',
    'use',
    'match',
    'trait',
    'where',
    'defer',
    'go',
    'chan',
    'select',
    'func',
    'map',
    'range',
    'nil',
    'var',
    'defer',
    'using',
    'override',
    'virtual',
    'sealed',
    'internal',
    'params',
    'ref',
    'out',
    'base',
    'when',
    'lock',
    'unsafe',
    'fixed',
    'checked'
  ],
  python: [
    'and',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'False',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'None',
    'nonlocal',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'True',
    'try',
    'while',
    'with',
    'yield',
    'self',
    'cls',
    'match',
    'case'
  ],
  shell: [
    'if',
    'then',
    'else',
    'elif',
    'fi',
    'for',
    'while',
    'do',
    'done',
    'case',
    'esac',
    'function',
    'return',
    'in',
    'select',
    'until',
    'break',
    'continue',
    'export',
    'local',
    'readonly',
    'declare',
    'source',
    'alias',
    'set',
    'unset',
    'shift',
    'trap',
    'exit',
    'echo',
    'cd',
    'test'
  ],
  sql: [
    'select',
    'from',
    'where',
    'insert',
    'into',
    'values',
    'update',
    'set',
    'delete',
    'create',
    'table',
    'alter',
    'drop',
    'index',
    'join',
    'left',
    'right',
    'inner',
    'outer',
    'on',
    'group',
    'by',
    'order',
    'having',
    'limit',
    'offset',
    'union',
    'all',
    'distinct',
    'as',
    'and',
    'or',
    'not',
    'null',
    'primary',
    'key',
    'foreign',
    'references',
    'default',
    'unique',
    'constraint',
    'with',
    'case',
    'when',
    'then',
    'else',
    'end',
    'exists',
    'in',
    'between',
    'like',
    'asc',
    'desc',
    'returning'
  ]
}

const FAMILY: Record<string, Family> = {}
for (const ext of [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'go',
  'rs',
  'swift',
  'kt',
  'kts',
  'scala',
  'php',
  'dart',
  'groovy',
  'proto',
  'zig',
  'v'
]) {
  FAMILY[ext] = 'c-like'
}
for (const ext of ['py', 'pyi', 'rb', 'pl', 'r', 'lua', 'ex', 'exs', 'nim', 'cr'])
  FAMILY[ext] = 'python'
for (const ext of [
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'psm1',
  'bat',
  'cmd',
  'env',
  'dockerfile',
  'makefile',
  'mk',
  'toml',
  'ini',
  'cfg',
  'conf',
  'service',
  'gitignore',
  'editorconfig',
  'properties'
]) {
  FAMILY[ext] = 'shell'
}
for (const ext of [
  'html',
  'htm',
  'xml',
  'svg',
  'vue',
  'svelte',
  'astro',
  'xaml',
  'plist',
  'jsp',
  'erb',
  'ejs',
  'hbs'
]) {
  FAMILY[ext] = 'markup'
}
for (const ext of ['css', 'scss', 'sass', 'less', 'styl', 'pcss']) FAMILY[ext] = 'css'
for (const ext of ['json', 'json5', 'jsonc', 'ndjson', 'lock', 'yaml', 'yml', 'webmanifest'])
  FAMILY[ext] = 'json'
for (const ext of ['sql', 'psql', 'mysql', 'ddl']) FAMILY[ext] = 'sql'
for (const ext of [
  'md',
  'mdx',
  'markdown',
  'txt',
  'log',
  'csv',
  'tsv',
  'diff',
  'patch',
  'rst',
  'adoc'
]) {
  FAMILY[ext] = 'plain'
}

/**
 * Resolve a language family from a fence tag or a file name. Falls back to
 * plain, which renders as uncolored text rather than as something wrong —
 * mis-highlighting is worse than not highlighting.
 */
export function familyFor(hint: string): Family {
  const raw = hint.trim().toLowerCase()
  if (raw === '') return 'plain'
  const base = raw.split(/[\\/]/).pop() ?? raw
  // Extension-less files that are still recognisable by name.
  if (base === 'dockerfile' || base === 'makefile' || base === 'jenkinsfile') return 'shell'
  const ext = base.includes('.') ? (base.split('.').pop() ?? '') : base
  return FAMILY[ext] ?? FAMILY[raw] ?? 'plain'
}

/** Tokenize one line, threading state for multi-line constructs. */
export function highlightLine(line: string, family: Family, state: HlState): Token[] {
  if (family === 'plain') return [{ text: line, kind: 'plain' }]
  const tokens: Token[] = []
  let i = 0
  const push = (text: string, kind: TokenKind): void => {
    if (text === '') return
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += text
    else tokens.push({ text, kind })
  }

  // Resume an open block comment from the previous line.
  if (state.inBlockComment) {
    const end = line.indexOf('*/')
    if (end === -1) {
      push(line, 'comment')
      return tokens
    }
    push(line.slice(0, end + 2), 'comment')
    state.inBlockComment = false
    i = end + 2
  }
  if (state.inTemplate) {
    const end = findUnescaped(line, '`', 0)
    if (end === -1) {
      push(line, 'string')
      return tokens
    }
    push(line.slice(0, end + 1), 'string')
    state.inTemplate = false
    i = end + 1
  }

  const words =
    KEYWORDS[family === 'markup' || family === 'css' || family === 'json' ? 'c-like' : family] ?? []
  const keywords = new Set(words)

  while (i < line.length) {
    const ch = line[i]
    const rest = line.slice(i)

    // Comments.
    if (family === 'c-like' && ch === '/' && line[i + 1] === '/') {
      push(rest, 'comment')
      break
    }
    if (family === 'c-like' && ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      if (end === -1) {
        push(rest, 'comment')
        state.inBlockComment = true
        break
      }
      push(line.slice(i, end + 2), 'comment')
      i = end + 2
      continue
    }
    if ((family === 'python' || family === 'shell') && ch === '#') {
      push(rest, 'comment')
      break
    }
    if (family === 'sql' && ch === '-' && line[i + 1] === '-') {
      push(rest, 'comment')
      break
    }
    if (family === 'css' && ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      if (end === -1) {
        push(rest, 'comment')
        state.inBlockComment = true
        break
      }
      push(line.slice(i, end + 2), 'comment')
      i = end + 2
      continue
    }
    if (family === 'markup' && rest.startsWith('<!--')) {
      const end = line.indexOf('-->', i + 4)
      if (end === -1) {
        push(rest, 'comment')
        state.inBlockComment = true
        break
      }
      push(line.slice(i, end + 3), 'comment')
      i = end + 3
      continue
    }

    // Strings.
    if (ch === '"' || ch === "'" || ch === '`') {
      if (ch === '`' && family === 'c-like') {
        const end = findUnescaped(line, '`', i + 1)
        if (end === -1) {
          push(rest, 'string')
          state.inTemplate = true
          break
        }
        push(line.slice(i, end + 1), 'string')
        i = end + 1
        continue
      }
      const end = findUnescaped(line, ch, i + 1)
      if (end === -1) {
        push(rest, 'string')
        break
      }
      push(line.slice(i, end + 1), 'string')
      i = end + 1
      continue
    }

    // Markup tags: `<div`, `</div`, and their attributes.
    if (family === 'markup' && ch === '<') {
      const m = rest.match(/^<\/?[A-Za-z][\w:-]*/)
      if (m) {
        push(m[0], 'tag')
        i += m[0].length
        continue
      }
    }
    if (family === 'markup' && /[A-Za-z]/.test(ch)) {
      const m = rest.match(/^[\w:-]+(?=\s*=)/)
      if (m) {
        push(m[0], 'attribute')
        i += m[0].length
        continue
      }
    }

    // CSS selectors/properties and JSON keys both key off `:`.
    if ((family === 'css' || family === 'json') && (ch === '"' || /[\w-]/.test(ch))) {
      const m = rest.match(/^([\w-]+)(?=\s*:)/)
      if (m) {
        push(m[1], 'property')
        i += m[1].length
        continue
      }
    }

    // Numbers, including hex/binary/exponent/suffixed literals.
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] ?? ''))) {
      const m = rest.match(
        /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9]+)?)[a-zA-Z%]*/
      )
      if (m) {
        push(m[0], 'number')
        i += m[0].length
        continue
      }
    }

    // Identifiers: keyword, call, type, or plain.
    if (/[A-Za-z_$@]/.test(ch)) {
      const m = rest.match(/^[A-Za-z_$@][\w$]*/)
      if (m) {
        const word = m[0]
        const after = line.slice(i + word.length)
        if (keywords.has(word)) push(word, 'keyword')
        else if (/^\s*\(/.test(after)) push(word, 'function')
        // A leading capital is a type in every language here that has types.
        else if (/^[A-Z]/.test(word) && family === 'c-like') push(word, 'type')
        else if (word.startsWith('$') || word.startsWith('@')) push(word, 'variable')
        else if (/^\s*:/.test(after) && family !== 'c-like') push(word, 'property')
        else push(word, 'plain')
        i += word.length
        continue
      }
    }

    if (/[+\-*/%=<>!&|^~?]/.test(ch)) {
      push(ch, 'operator')
      i++
      continue
    }
    if (/[(){}[\],;:.]/.test(ch)) {
      push(ch, 'punctuation')
      i++
      continue
    }
    push(ch, 'plain')
    i++
  }
  return tokens
}

/** Tokenize a whole block, threading state between lines. */
export function highlight(code: string, hint: string): Token[][] {
  const family = familyFor(hint)
  const state = initialState()
  return code.split('\n').map((line) => highlightLine(line, family, state))
}

/**
 * Token colors.
 *
 * Two palettes rather than one tinted by the theme: syntax color is not a
 * design token, it is a legibility contract, and deriving it from `--color-*`
 * would give a user theme the power to make code unreadable. These are tuned to
 * sit against `--color-surface` in each appearance.
 */
const DARK: Record<TokenKind, string> = {
  plain: '#d4d4d4',
  keyword: '#c586c0',
  string: '#ce9178',
  comment: '#6a9955',
  number: '#b5cea8',
  function: '#dcdcaa',
  type: '#4ec9b0',
  operator: '#d4d4d4',
  punctuation: '#8c8c95',
  property: '#9cdcfe',
  tag: '#569cd6',
  attribute: '#9cdcfe',
  variable: '#9cdcfe'
}

const LIGHT: Record<TokenKind, string> = {
  plain: '#24292f',
  keyword: '#cf222e',
  string: '#0a3069',
  comment: '#6e7781',
  number: '#0550ae',
  function: '#8250df',
  type: '#953800',
  operator: '#24292f',
  punctuation: '#57606a',
  property: '#0550ae',
  tag: '#116329',
  attribute: '#0550ae',
  variable: '#0550ae'
}

export function tokenColors(appearance: 'dark' | 'light'): Record<TokenKind, string> {
  return appearance === 'light' ? LIGHT : DARK
}

/** Index of the next unescaped `quote` at or after `from`. */
function findUnescaped(line: string, quote: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') {
      i++
      continue
    }
    if (line[i] === quote) return i
  }
  return -1
}
