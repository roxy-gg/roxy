/**
 * Themes — user-authored `theme.json` files that restyle the whole app.
 *
 * The design rests on one fact about Tailwind v4, verified against the compiler
 * rather than assumed: a `@theme` token compiles to a *runtime* `var()`
 * reference, not to a baked literal. `bg-surface` emits
 * `background-color: var(--color-surface)`, and `bg-white/5` emits
 * `color-mix(in oklab, var(--color-white) 5%, transparent)`. So re-pointing the
 * custom properties on `<html>` restyles every one of the ~1000 utility usages
 * in this app live, with no rebuild, no stylesheet swap and no reload.
 *
 * That is why a theme here is *data*, not CSS. A theme file names tokens and
 * values; nothing in it is code, nothing is injected into a stylesheet, and the
 * set of keys it may write is closed (see THEME_COLOR_TOKENS). The `vars`
 * escape hatch below is the single exception, and it is deliberately narrow.
 *
 * This module is pure — no node, no electron, no DOM — so the main process, the
 * renderer and `npm run smoke:shared` all share one implementation and one set
 * of rules. Everything that touches disk lives in main/services/themes.ts;
 * everything that touches the document lives in renderer/src/lib/theme.ts.
 */

/** Marker + version stamped into every theme file we write. */
export const THEME_KIND = 'roxy.theme'
export const THEME_VERSION = 1
/** The filename a theme is stored under inside its own folder. */
export const THEME_FILENAME = 'theme.json'

/** Longest accepted value for any single token — a guard against absurd input. */
const MAX_VALUE_LENGTH = 512
/** Cap on `vars` entries, so a hand-edited file can't bloat the style attribute. */
export const MAX_CUSTOM_VARS = 64

// ---------------------------------------------------------------------------
// Token registry
// ---------------------------------------------------------------------------

export type ThemeTokenGroup = 'surfaces' | 'text' | 'accents' | 'polarity'

export interface ThemeTokenSpec {
  /** Key as written in theme.json (`colors.bg`). */
  key: string
  /** CSS custom property it drives (`--color-bg`). */
  cssVar: string
  label: string
  group: ThemeTokenGroup
  /** What it actually paints, for the editor UI. */
  hint: string
}

/**
 * Every color a theme may set, in the order the editor shows them.
 *
 * Closed by design: an unknown `colors` key is a validation error rather than a
 * silently-ignored typo, because a theme that half-applies looks like a bug in
 * the app rather than a mistake in the file.
 */
export const THEME_COLOR_TOKENS: ThemeTokenSpec[] = [
  {
    key: 'bg',
    cssVar: '--color-bg',
    label: 'Background',
    group: 'surfaces',
    hint: 'The window behind everything.'
  },
  {
    key: 'surface',
    cssVar: '--color-surface',
    label: 'Surface',
    group: 'surfaces',
    hint: 'Sidebar, cards, page panels.'
  },
  {
    key: 'surface-2',
    cssVar: '--color-surface-2',
    label: 'Surface 2',
    group: 'surfaces',
    hint: 'Inputs and inset wells.'
  },
  {
    key: 'elevated',
    cssVar: '--color-elevated',
    label: 'Elevated',
    group: 'surfaces',
    hint: 'Menus and popovers that float above.'
  },
  {
    key: 'border',
    cssVar: '--color-border',
    label: 'Border',
    group: 'surfaces',
    hint: 'Hairlines between regions.'
  },
  {
    key: 'border-strong',
    cssVar: '--color-border-strong',
    label: 'Border strong',
    group: 'surfaces',
    hint: 'Hover borders and scrollbars.'
  },
  {
    key: 'text',
    cssVar: '--color-text',
    label: 'Text',
    group: 'text',
    hint: 'Primary copy.'
  },
  {
    key: 'text-muted',
    cssVar: '--color-text-muted',
    label: 'Text muted',
    group: 'text',
    hint: 'Secondary copy and labels.'
  },
  {
    key: 'text-subtle',
    cssVar: '--color-text-subtle',
    label: 'Text subtle',
    group: 'text',
    hint: 'Timestamps, paths, counts.'
  },
  {
    key: 'accent',
    cssVar: '--color-accent',
    label: 'Accent',
    group: 'accents',
    hint: 'Links, focus rings, the active state.'
  },
  {
    key: 'accent-hover',
    cssVar: '--color-accent-hover',
    label: 'Accent hover',
    group: 'accents',
    hint: 'Accent, one step brighter.'
  },
  {
    key: 'success',
    cssVar: '--color-success',
    label: 'Success',
    group: 'accents',
    hint: 'Live indicators, additions.'
  },
  {
    key: 'warning',
    cssVar: '--color-warning',
    label: 'Warning',
    group: 'accents',
    hint: 'Pending and degraded states.'
  },
  {
    key: 'danger',
    cssVar: '--color-danger',
    label: 'Danger',
    group: 'accents',
    hint: 'Errors, deletions, the danger zone.'
  },
  /**
   * The polarity pair. Tailwind's `white`/`black` are ordinary theme tokens, so
   * they resolve through `var()` like everything else — which makes them the
   * lever that turns a dark UI light. This app leans on `bg-white/5` for ~75
   * hover states and on `bg-white text-black` for its primary button; re-point
   * these two and all of it inverts at once, without touching a component.
   *
   * So: these are NOT "the color white". They are "the color that contrasts
   * with the background", and a light theme sets `white` to near-black.
   */
  {
    key: 'white',
    cssVar: '--color-white',
    label: 'Contrast',
    group: 'polarity',
    hint: 'Hover washes and the primary button fill. Near-black in a light theme.'
  },
  {
    key: 'black',
    cssVar: '--color-black',
    label: 'Contrast text',
    group: 'polarity',
    hint: 'Text ON the primary button, and modal scrims. Near-white in a light theme.'
  }
]

const TOKEN_BY_KEY = new Map(THEME_COLOR_TOKENS.map((t) => [t.key, t]))

/** Custom properties a theme may set through `vars`, beyond the color tokens. */
const EXTRA_VAR_ALLOWLIST = new Set([
  // Motion
  '--ease-out-quart',
  '--ease-in-out-quart',
  '--ease-drawer',
  // Corner geometry (see the squircle system in main.css)
  '--sq-scale',
  // Edge lighting: the translucent hairline, its hover/float variant, and the
  // top-lit bevel. These are derived from `--color-white` (the polarity token),
  // so every theme already gets a coherent default -- these are here for a theme
  // that wants a flatter or glassier look than the palette alone implies.
  '--edge',
  '--edge-strong',
  '--edge-lit',
  // Elevation. These are the indirection vars the `shadow-*` utilities read;
  // the `--shadow-*` tokens themselves are compiled by Tailwind and cannot be
  // re-pointed at runtime.
  '--elevation-raised',
  '--elevation-float',
  // Typography detail
  '--font-sans',
  '--font-mono',
  '--theme-code-line-height',
  '--theme-code-font-size',
  // Chrome
  '--theme-scrollbar-thumb',
  '--theme-scrollbar-thumb-hover',
  '--theme-selection'
])

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export type PlatformId = 'darwin' | 'win32' | 'linux'

/** The bundled faces, and the `system` keyword, offered as one-click picks. */
export const FONT_PRESETS = {
  sans: ['system', 'Geist Variable', 'Inter', 'Söhne', 'Helvetica Neue'],
  mono: [
    'system',
    'Geist Mono Variable',
    'JetBrains Mono',
    'SF Mono',
    'Cascadia Code',
    'Fira Code',
    'IBM Plex Mono'
  ]
} as const

const SANS_FALLBACK = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
const MONO_FALLBACK = "ui-monospace, 'SF Mono', 'JetBrains Mono', monospace"

/** Native UI font per platform, used when a theme asks for `system`. */
const SYSTEM_SANS: Record<PlatformId, string> = {
  darwin:
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif",
  win32: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  linux: "system-ui, 'Cantarell', 'Ubuntu', 'DejaVu Sans', sans-serif"
}

/** Native monospace per platform. */
const SYSTEM_MONO: Record<PlatformId, string> = {
  darwin: "ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
  win32: "'Cascadia Mono', Consolas, ui-monospace, monospace",
  linux: "ui-monospace, 'DejaVu Sans Mono', 'Liberation Mono', monospace"
}

/** CSS-wide keywords and generic families that must never be quoted. */
const UNQUOTED_FAMILIES = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong'
])

/** A bare family name needs quoting when it isn't a generic and isn't an identifier. */
function quoteFamily(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return ''
  if (UNQUOTED_FAMILIES.has(trimmed.toLowerCase())) return trimmed
  if (/^['"].*['"]$/.test(trimmed)) return trimmed
  // A CSS <custom-ident> sequence (Geist, Menlo, -apple-system) is legal bare;
  // anything with a space, a digit-leading word or punctuation gets quoted.
  if (/^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed)) return trimmed
  return `'${trimmed.replace(/'/g, '')}'`
}

/**
 * Turn a theme's font choice into a full CSS font stack.
 *
 * Accepts a single family, an explicit stack (array), or the `system` keyword.
 * A user naming one font still gets the fallbacks appended, because a theme
 * that names a font the machine doesn't have should degrade to a sane stack
 * rather than to Times New Roman.
 */
export function resolveFontStack(
  value: string | string[] | undefined,
  kind: 'sans' | 'mono',
  platform: PlatformId
): string | null {
  if (value === undefined || value === null) return null
  const list = Array.isArray(value) ? value : [value]
  const names = list.map((n) => String(n).trim()).filter(Boolean)
  if (names.length === 0) return null

  const fallback = kind === 'sans' ? SANS_FALLBACK : MONO_FALLBACK
  const system = kind === 'sans' ? SYSTEM_SANS[platform] : SYSTEM_MONO[platform]

  // `system` is a keyword, not a family: it expands to the platform stack and
  // needs nothing appended.
  if (names.length === 1 && names[0].toLowerCase() === 'system') return system

  const head = names
    .map((n) => (n.toLowerCase() === 'system' ? system : quoteFamily(n)))
    .filter(Boolean)

  // Drop fallback entries the author already named. Asking for JetBrains Mono
  // would otherwise emit it twice - harmless to CSS, which takes the first
  // match, but it looks like a bug in devtools and in the copied theme file.
  const bare = (n: string): string => n.replace(/['"]/g, '').trim().toLowerCase()
  const seen = new Set(head.flatMap((n) => n.split(',').map(bare)))
  const tail = fallback
    .split(',')
    .map((n) => n.trim())
    .filter((n) => !seen.has(bare(n)))

  return [...head, ...tail].join(', ')
}

// ---------------------------------------------------------------------------
// The theme file
// ---------------------------------------------------------------------------

export interface ThemeFonts {
  /** UI font. A family, a stack, or `system`. */
  sans?: string | string[]
  /** Code font — tool calls, terminal output, diffs, markdown code blocks. */
  mono?: string | string[]
}

export interface ThemeFile {
  kind?: typeof THEME_KIND
  version?: number
  /** Stable slug; also the folder name on disk. */
  id: string
  name: string
  description?: string
  author?: string
  /** Drives `color-scheme`, so native scrollbars and form controls match. */
  appearance?: 'dark' | 'light'
  /** Start from a built-in and override only what differs. */
  extends?: string
  colors?: Record<string, string>
  fonts?: ThemeFonts
  /**
   * Escape hatch: raw custom properties, for anything the typed fields above
   * don't cover. Restricted to a known allowlist of property names — a theme
   * cannot invent properties, because a value here is applied verbatim and the
   * set of things it can reach has to stay auditable.
   */
  vars?: Record<string, string>
}

/** A theme as the app knows it — the file plus where it came from. */
export interface ThemeView {
  id: string
  name: string
  description?: string
  author?: string
  appearance: 'dark' | 'light'
  /** Built-ins ship with the app and can't be edited or deleted. */
  source: 'builtin' | 'user'
  /** Absolute path to the theme's folder (user themes only). */
  location?: string
  /** Resolved swatches for the picker, keyed by token key. */
  swatches: Record<string, string>
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Reject anything that could escape a CSS declaration or reach the network.
 *
 * Applying a theme goes through `style.setProperty()`, which parses one value
 * and cannot be made to emit a second declaration — so this is defence in
 * depth rather than the only guard. It still matters:
 *
 *  - `url()` is the real risk. A custom property holding `url(https://…)` is
 *    inert until something references it, at which point the browser fetches
 *    it — a shared theme file could quietly phone home, or read a local file.
 *  - Rejecting early lets the editor tell the author their value is bad,
 *    instead of silently dropping it and looking broken.
 */
export function isSafeCssValue(value: string): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (!v || v.length > MAX_VALUE_LENGTH) return false
  // Structural characters that only make sense if you're trying to break out.
  if (/[;{}<>\\]/.test(v)) return false
  // Comments can be used to smuggle the above past a naive reader.
  if (v.includes('/*') || v.includes('*/')) return false
  // Anything that loads or executes.
  if (/\b(url|image-set|image|element|expression|-moz-binding|attr)\s*\(/i.test(v)) return false
  if (/(javascript|data|vbscript|file|blob)\s*:/i.test(v)) return false
  // At-rules have no business inside a value.
  if (v.includes('@')) return false
  return true
}

/** A theme id doubles as a folder name, so keep it to a strict slug. */
export function isValidThemeId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}

/** Coerce arbitrary text into a usable theme id. */
export function sanitizeThemeId(input: string): string {
  const slug = String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'theme'
}

export type ParseThemeResult =
  | { ok: true; theme: ThemeFile; warnings: string[] }
  | { ok: false; error: string }

/**
 * Parse and validate a theme file.
 *
 * Split into hard errors (the file is unusable — bad JSON, no id) and warnings
 * (a single token was dropped). A typo'd color must not cost the author their
 * whole theme, but it must also not pass unmentioned, so the bad key is
 * dropped and named in `warnings` for the UI to show.
 */
export function parseTheme(raw: string): ParseThemeResult {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}` }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'A theme must be a JSON object.' }
  }
  const obj = data as Record<string, unknown>
  const warnings: string[] = []

  const id = obj.id
  if (!isValidThemeId(id)) {
    return {
      ok: false,
      error: 'Missing or invalid "id" — use lowercase letters, digits and dashes.'
    }
  }
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : id

  const theme: ThemeFile = {
    kind: THEME_KIND,
    version: typeof obj.version === 'number' ? obj.version : THEME_VERSION,
    id,
    name
  }
  if (typeof obj.description === 'string') theme.description = obj.description
  if (typeof obj.author === 'string') theme.author = obj.author
  if (obj.appearance === 'light' || obj.appearance === 'dark') theme.appearance = obj.appearance
  if (typeof obj.extends === 'string' && isValidThemeId(obj.extends)) theme.extends = obj.extends

  // ---- colors
  if (obj.colors !== undefined) {
    if (typeof obj.colors !== 'object' || obj.colors === null || Array.isArray(obj.colors)) {
      return { ok: false, error: '"colors" must be an object.' }
    }
    const colors: Record<string, string> = {}
    for (const [key, value] of Object.entries(obj.colors as Record<string, unknown>)) {
      if (!TOKEN_BY_KEY.has(key)) {
        warnings.push(`Unknown color "${key}" — ignored.`)
        continue
      }
      if (typeof value !== 'string' || !isSafeCssValue(value)) {
        warnings.push(`Color "${key}" has an unsafe or empty value — ignored.`)
        continue
      }
      colors[key] = value.trim()
    }
    theme.colors = colors
  }

  // ---- fonts
  if (obj.fonts !== undefined) {
    if (typeof obj.fonts !== 'object' || obj.fonts === null || Array.isArray(obj.fonts)) {
      return { ok: false, error: '"fonts" must be an object.' }
    }
    const fontsIn = obj.fonts as Record<string, unknown>
    const fonts: ThemeFonts = {}
    for (const key of ['sans', 'mono'] as const) {
      const value = fontsIn[key]
      if (value === undefined) continue
      if (typeof value === 'string') {
        if (!isSafeCssValue(value)) {
          warnings.push(`Font "${key}" has an unsafe value — ignored.`)
          continue
        }
        fonts[key] = value
      } else if (Array.isArray(value)) {
        const names = value.filter((n): n is string => typeof n === 'string' && isSafeCssValue(n))
        if (names.length !== value.length) {
          warnings.push(`Font "${key}" has an unsafe entry — ignored.`)
          continue
        }
        fonts[key] = names
      } else {
        warnings.push(`Font "${key}" must be a string or an array of strings — ignored.`)
      }
    }
    if (Object.keys(fonts).length > 0) theme.fonts = fonts
  }

  // ---- vars
  if (obj.vars !== undefined) {
    if (typeof obj.vars !== 'object' || obj.vars === null || Array.isArray(obj.vars)) {
      return { ok: false, error: '"vars" must be an object.' }
    }
    const vars: Record<string, string> = {}
    let count = 0
    for (const [key, value] of Object.entries(obj.vars as Record<string, unknown>)) {
      if (count >= MAX_CUSTOM_VARS) {
        warnings.push(`More than ${MAX_CUSTOM_VARS} custom vars — the rest were ignored.`)
        break
      }
      if (!EXTRA_VAR_ALLOWLIST.has(key)) {
        warnings.push(`"${key}" is not a themeable property — ignored.`)
        continue
      }
      if (typeof value !== 'string' || !isSafeCssValue(value)) {
        warnings.push(`Var "${key}" has an unsafe or empty value — ignored.`)
        continue
      }
      vars[key] = value.trim()
      count++
    }
    if (Object.keys(vars).length > 0) theme.vars = vars
  }

  return { ok: true, theme, warnings }
}

/** Pretty-print a theme for writing to disk. */
export function serializeTheme(theme: ThemeFile): string {
  const ordered: ThemeFile = {
    kind: THEME_KIND,
    version: THEME_VERSION,
    id: theme.id,
    name: theme.name,
    ...(theme.description ? { description: theme.description } : {}),
    ...(theme.author ? { author: theme.author } : {}),
    ...(theme.appearance ? { appearance: theme.appearance } : {}),
    ...(theme.extends ? { extends: theme.extends } : {}),
    ...(theme.colors && Object.keys(theme.colors).length ? { colors: theme.colors } : {}),
    ...(theme.fonts && Object.keys(theme.fonts).length ? { fonts: theme.fonts } : {}),
    ...(theme.vars && Object.keys(theme.vars).length ? { vars: theme.vars } : {})
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Built-in themes
// ---------------------------------------------------------------------------

/** The palette compiled into main.css — the app's out-of-the-box look. */
export const DEFAULT_THEME_ID = 'roxy-dark'

const ROXY_DARK: ThemeFile = {
  kind: THEME_KIND,
  version: THEME_VERSION,
  id: DEFAULT_THEME_ID,
  name: 'Roxy Dark',
  description: 'The default — near-black surfaces, hairline borders, a blue accent.',
  appearance: 'dark',
  colors: {
    bg: '#0a0a0a',
    surface: '#0f0f10',
    'surface-2': '#161618',
    elevated: '#1d1d20',
    border: '#232326',
    'border-strong': '#303035',
    text: '#ededed',
    'text-muted': '#9a9aa3',
    'text-subtle': '#6a6a73',
    accent: '#4d8dff',
    'accent-hover': '#6aa0ff',
    success: '#3fb950',
    warning: '#d9a441',
    danger: '#f0556a',
    white: '#ffffff',
    black: '#000000'
  }
}

/**
 * The proof the abstraction is complete: a light theme built only from tokens,
 * with no component changes. `white`/`black` invert (see the polarity note in
 * THEME_COLOR_TOKENS), which flips every hover wash and the primary button.
 */
const ROXY_LIGHT: ThemeFile = {
  kind: THEME_KIND,
  version: THEME_VERSION,
  id: 'roxy-light',
  name: 'Roxy Light',
  description: 'Paper-white surfaces with the same blue accent.',
  appearance: 'light',
  colors: {
    bg: '#ffffff',
    surface: '#f7f7f8',
    'surface-2': '#efeff1',
    elevated: '#ffffff',
    border: '#e2e2e5',
    'border-strong': '#c9c9cf',
    text: '#1a1a1c',
    'text-muted': '#5c5c66',
    'text-subtle': '#8a8a94',
    accent: '#2563eb',
    'accent-hover': '#1d4ed8',
    success: '#177d3c',
    warning: '#9a6700',
    danger: '#c81e3d',
    white: '#18181b',
    black: '#ffffff'
  }
}

export const BUILT_IN_THEMES: ThemeFile[] = [ROXY_DARK, ROXY_LIGHT]

export function getBuiltInTheme(id: string): ThemeFile | undefined {
  return BUILT_IN_THEMES.find((t) => t.id === id)
}

export function isBuiltInThemeId(id: string): boolean {
  return BUILT_IN_THEMES.some((t) => t.id === id)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Fold a theme onto its base.
 *
 * Always starts from the default palette, so a theme that sets three colors
 * gets a coherent UI rather than eleven unset tokens — the same reason
 * `extends` exists at all. An explicit `extends` layers a chosen built-in in
 * between.
 */
export function flattenTheme(
  theme: ThemeFile,
  lookup?: (id: string) => ThemeFile | undefined
): ThemeFile {
  const chain: ThemeFile[] = []
  const seen = new Set<string>([theme.id])
  let base = theme.extends
  // Walk the extends chain, guarding against cycles and runaway depth.
  for (let i = 0; base && i < 8; i++) {
    if (seen.has(base)) break
    seen.add(base)
    const parent = lookup?.(base) ?? getBuiltInTheme(base)
    if (!parent) break
    chain.unshift(parent)
    base = parent.extends
  }
  const layers = [ROXY_DARK, ...chain, theme]
  const out: ThemeFile = {
    kind: THEME_KIND,
    version: THEME_VERSION,
    id: theme.id,
    name: theme.name,
    description: theme.description,
    author: theme.author,
    appearance: theme.appearance ?? chain[chain.length - 1]?.appearance ?? 'dark',
    colors: {},
    fonts: {},
    vars: {}
  }
  for (const layer of layers) {
    Object.assign(out.colors as object, layer.colors ?? {})
    Object.assign(out.fonts as object, layer.fonts ?? {})
    Object.assign(out.vars as object, layer.vars ?? {})
  }
  return out
}

export interface ResolvedTheme {
  id: string
  name: string
  appearance: 'dark' | 'light'
  /** CSS custom property -> value, ready to set on the root element. */
  vars: Record<string, string>
}

/**
 * Turn a theme into the exact set of custom properties to put on `<html>`.
 *
 * Only tokens the theme actually specifies are emitted. That matters for fonts:
 * main.css overrides `--font-sans`/`--font-mono` under
 * `[data-platform='darwin']` to use San Francisco, and a theme that stays quiet
 * about fonts must not clobber it. Inline styles beat that selector, so
 * emitting a default here would silently break the macOS system font.
 */
export function resolveTheme(
  theme: ThemeFile,
  platform: PlatformId = 'win32',
  lookup?: (id: string) => ThemeFile | undefined
): ResolvedTheme {
  const flat = flattenTheme(theme, lookup)
  const vars: Record<string, string> = {}

  for (const [key, value] of Object.entries(flat.colors ?? {})) {
    const spec = TOKEN_BY_KEY.get(key)
    if (!spec || typeof value !== 'string' || !isSafeCssValue(value)) continue
    vars[spec.cssVar] = value
  }

  const sans = resolveFontStack(flat.fonts?.sans, 'sans', platform)
  if (sans) vars['--font-sans'] = sans
  const mono = resolveFontStack(flat.fonts?.mono, 'mono', platform)
  if (mono) vars['--font-mono'] = mono

  // `vars` is applied last so an author can override anything above it.
  for (const [key, value] of Object.entries(flat.vars ?? {})) {
    if (!EXTRA_VAR_ALLOWLIST.has(key) || !isSafeCssValue(value)) continue
    vars[key] = value
  }

  return {
    id: flat.id,
    name: flat.name,
    appearance: flat.appearance ?? 'dark',
    vars
  }
}

/** The handful of colors the picker previews, in swatch order. */
export const SWATCH_KEYS = ['bg', 'surface', 'border', 'text', 'accent'] as const

export function themeSwatches(theme: ThemeFile): Record<string, string> {
  const flat = flattenTheme(theme)
  const out: Record<string, string> = {}
  for (const key of SWATCH_KEYS) {
    const value = flat.colors?.[key]
    if (value) out[key] = value
  }
  return out
}

/** Build the list entry the renderer shows for a theme. */
export function toThemeView(
  theme: ThemeFile,
  source: 'builtin' | 'user',
  location?: string
): ThemeView {
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description,
    author: theme.author,
    appearance: flattenTheme(theme).appearance ?? 'dark',
    source,
    location,
    swatches: themeSwatches(theme)
  }
}

/** A starter file for "New theme" — the default palette, ready to edit. */
export function starterTheme(id: string, name: string): ThemeFile {
  return {
    kind: THEME_KIND,
    version: THEME_VERSION,
    id,
    name,
    description: 'My theme',
    appearance: 'dark',
    extends: DEFAULT_THEME_ID,
    colors: {
      bg: '#0a0a0a',
      surface: '#0f0f10',
      accent: '#4d8dff'
    },
    fonts: { sans: 'system', mono: 'system' }
  }
}

// ---------------------------------------------------------------------------
// Authoring prompt
// ---------------------------------------------------------------------------

/**
 * Build the "copy prompt" text — a self-contained spec an LLM can turn into a
 * valid theme file, and a human can read as documentation.
 *
 * GENERATED, never hand-written. Every token, hint, allowlisted var and font
 * preset below is read out of the same constants the validator enforces, so the
 * prompt cannot drift from the rules. A hand-maintained copy would be wrong the
 * first time someone adds a token — and wrong documentation that *looks*
 * authoritative is worse than none, because the model confidently emits fields
 * that then get dropped as unknown.
 *
 * Written as instructions to a model rather than prose about the format: it
 * states the output contract first, explains what each token PAINTS (a model
 * can pick a good `surface-2` only if it knows it sits behind inputs), and ends
 * with the failure modes that actually produce ugly or broken themes.
 */
export function buildThemePrompt(options: { goal?: string } = {}): string {
  const goal =
    options.goal?.trim() ||
    'a theme of your own design — pick a distinctive palette and commit to it'

  const group = (id: ThemeTokenGroup): string =>
    THEME_COLOR_TOKENS.filter((t) => t.group === id)
      .map((t) => `  "${t.key}" — ${t.hint}`)
      .join('\n')

  // Only the vars worth an author's attention; the font ones duplicate `fonts`.
  const vars = [...EXTRA_VAR_ALLOWLIST]
    .filter((v) => v !== '--font-sans' && v !== '--font-mono')
    .map((v) => `  ${v}`)
    .join('\n')

  return `You are writing a theme file for Roxy, a desktop AI coding app.

GOAL
${goal}

OUTPUT
Return ONE JSON object and nothing else — no markdown fence, no commentary.
It must parse as JSON. Unknown keys are dropped, so do not invent any.

SHAPE
{
  "id":          required. lowercase letters, digits and dashes only. Used as the folder name.
  "name":        required. Human-readable, e.g. "Deep Ocean".
  "description": optional. One short sentence shown under the name in the picker.
  "author":      optional.
  "appearance":  "dark" | "light". Drives native scrollbars and form controls, so it MUST
                 match your palette. A light palette with "dark" here looks broken.
  "extends":     optional. "${DEFAULT_THEME_ID}" or "roxy-light". Anything you omit is
                 inherited from it, so you may set as few as three colors.
  "colors":      object of the tokens below. Any CSS color: hex, rgb(), hsl(), oklch(),
                 or color-mix(). No url(), no gradients, no var().
  "fonts":       { "sans": …, "mono": … }
  "vars":        optional. Advanced escape hatch, see below.
}

COLOR TOKENS
These are the ONLY accepted color keys. Each one names what it paints — read the
description, because picking a value without knowing where it lands is how themes
end up unreadable.

Surfaces (darkest → lightest in a dark theme; the reverse in a light one):
${group('surfaces')}

Text (in descending prominence — these sit ON the surfaces above):
${group('text')}

Accents (meaning-carrying; keep them distinguishable from each other):
${group('accents')}

Contrast pair — READ THIS, it is the one non-obvious part:
${group('polarity')}
  These are NOT literally white and black. "white" is the color that CONTRASTS
  with your background: it fills the primary button and every hover wash in the
  app. "black" is what sits ON the primary button.
    - Dark theme:  "white": "#ffffff", "black": "#000000"
    - Light theme: "white": "#18181b", "black": "#ffffff"   ← inverted
  Get this backwards on a light theme and every hover state turns into a white
  smear on white, and the primary button becomes unreadable.

FONTS
  "sans" is the UI font. "mono" is the code font — tool calls, terminal output,
  diffs and code blocks. Each accepts:
    "system"                      the platform's native font (SF / Segoe / system-ui)
    "Berkeley Mono"               one family; fallbacks are appended automatically
    ["Berkeley Mono", "Menlo"]    an explicit stack, tried in order
  Naming a font the machine lacks degrades to the fallback stack, so it is safe.
  Omit "fonts" entirely to leave the app's fonts alone.
  Common mono choices: ${FONT_PRESETS.mono.filter((f) => f !== 'system').join(', ')}.

VARS (optional, advanced)
  Raw CSS custom properties for things the fields above don't cover. Only these
  names are accepted; anything else is dropped:
${vars}

CONSTRAINTS — a value breaking any of these is silently discarded
  - No url(), image-set(), attr() or expression() — blocked as an exfiltration risk.
  - No javascript:, data:, file: or blob: URIs.
  - No semicolons, braces, angle brackets, backslashes, comments or @-rules.
  - Each value under ${MAX_VALUE_LENGTH} characters.
  - At most ${MAX_CUSTOM_VARS} entries in "vars".

MAKING IT ACTUALLY GOOD
  - Contrast is the whole job. "text" on "bg" should clear WCAG AA (4.5:1);
    "text-muted" ≥ 3:1. A palette that looks great as swatches and fails here is
    a bad theme.
  - Keep the surface ramp SUBTLE — bg → surface → surface-2 → elevated should be
    small steps in the same hue family. Big jumps make the UI look striped.
  - "border" is a hairline, not a divider: keep it close to the surfaces, only a
    little lighter (dark theme) or darker (light theme).
  - Pick ONE accent hue and let success/warning/danger stay conventionally
    green/amber/red — they carry meaning and should not be restyled for looks.
  - "accent-hover" is the accent one step BRIGHTER in a dark theme, one step
    DARKER in a light theme.
  - Tint your greys toward the accent hue instead of using pure neutrals; it is
    what makes a palette feel designed rather than default.

EXAMPLE (a complete, valid theme)
${serializeTheme({
  kind: THEME_KIND,
  version: THEME_VERSION,
  id: 'deep-ocean',
  name: 'Deep Ocean',
  description: 'Cold blue-black with a cyan accent.',
  appearance: 'dark',
  extends: DEFAULT_THEME_ID,
  colors: {
    bg: '#04121a',
    surface: '#081a24',
    'surface-2': '#0d2430',
    elevated: '#123040',
    border: '#16323f',
    'border-strong': '#1f4553',
    text: '#e2f1f7',
    'text-muted': '#8fadb9',
    'text-subtle': '#5f7d89',
    accent: '#22d3ee',
    'accent-hover': '#4ae0f7',
    success: '#3fb98a',
    warning: '#d9a441',
    danger: '#f0556a',
    white: '#ffffff',
    black: '#000000'
  },
  fonts: { mono: 'JetBrains Mono' }
}).trim()}

Now output the JSON for: ${goal}`
}
