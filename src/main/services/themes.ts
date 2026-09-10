/**
 * Themes service — user `theme.json` files on disk.
 *
 * Mirrors the shape of the skills service: discover from a fixed set of roots,
 * cache the scan, and degrade gracefully (an unreadable or malformed theme is
 * skipped and reported, never thrown into the caller). All parsing, validation
 * and resolution lives in `shared/theme.ts`, so this file only does IO.
 *
 * Layout — one folder per theme, so a theme can later carry assets (a font
 * file, a preview image) without changing the format:
 *
 *   <userData>/themes/<id>/theme.json      created by the app
 *   ~/.roxy/themes/<id>/theme.json         hand-authored / shared / dotfiles
 *
 * A bare `<id>.json` is accepted too, since that is what someone dropping a
 * single file in will naturally write.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_THEME_ID,
  THEME_FILENAME,
  BUILT_IN_THEMES,
  getBuiltInTheme,
  isBuiltInThemeId,
  isValidThemeId,
  parseTheme,
  resolveTheme,
  sanitizeThemeId,
  serializeTheme,
  starterTheme,
  toThemeView,
  type PlatformId,
  type ResolvedTheme,
  type ThemeFile,
  type ThemeView
} from '../../shared/theme'

/** Where the app writes themes it creates. */
export function userThemesDir(): string {
  return path.join(app.getPath('userData'), 'themes')
}

/**
 * Every root scanned, nearest-wins first. The userData dir comes first so a
 * theme edited in the app beats a same-id theme in the dotfiles dir.
 */
function themeRoots(): string[] {
  const home = os.homedir()
  return [
    userThemesDir(),
    path.join(home, '.roxy', 'themes'),
    path.join(home, '.config', 'roxy', 'themes')
  ]
}

/** A theme found on disk: what it says, and exactly which file said it. */
interface DiscoveredTheme {
  theme: ThemeFile
  /** The theme.json (or bare <id>.json) itself — what we read and rewrite. */
  file: string
  /** Its containing folder, shown in the UI and used by "Reveal". */
  location: string
}

/** Discovered user themes, keyed by id. Warmed lazily; dropped by refresh. */
let cache: Map<string, DiscoveredTheme> | null = null
/** Non-fatal problems from the last scan, surfaced in the Themes page. */
let scanWarnings: { file: string; message: string }[] = []

async function readThemeFile(file: string): Promise<DiscoveredTheme | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  const parsed = parseTheme(raw)
  if (!parsed.ok) {
    scanWarnings.push({ file, message: parsed.error })
    return null
  }
  for (const w of parsed.warnings) scanWarnings.push({ file, message: w })
  return { theme: parsed.theme, file, location: path.dirname(file) }
}

/** Candidate theme files in one root: `<id>/theme.json` and bare `<id>.json`. */
async function themeFilesIn(root: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return [] // missing root is the normal case, not an error
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(path.join(root, entry.name, THEME_FILENAME))
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path.join(root, entry.name))
  }
  return files
}

async function scan(): Promise<Map<string, DiscoveredTheme>> {
  if (cache) return cache
  scanWarnings = []
  const found = new Map<string, DiscoveredTheme>()
  for (const root of themeRoots()) {
    for (const file of await themeFilesIn(root)) {
      const entry = await readThemeFile(file)
      if (!entry) continue
      const { id } = entry.theme
      // First root to claim an id wins (roots are ordered by precedence), and a
      // user theme may not shadow a built-in — that would make the default
      // impossible to get back to from the UI.
      if (found.has(id)) continue
      if (isBuiltInThemeId(id)) {
        scanWarnings.push({
          file,
          message: `"${id}" is the id of a built-in theme — rename it to load this file.`
        })
        continue
      }
      found.set(id, entry)
    }
  }
  cache = found
  return found
}

/** Drop the discovery cache so the next read re-scans. */
export function refreshThemes(): void {
  cache = null
}

/** Built-ins followed by user themes, for the picker. */
export async function listThemes(): Promise<ThemeView[]> {
  const user = await scan()
  return [
    ...BUILT_IN_THEMES.map((t) => toThemeView(t, 'builtin')),
    ...[...user.values()].map((e) => toThemeView(e.theme, 'user', e.location))
  ]
}

/** Problems found during the last scan (bad JSON, unknown tokens). */
export function themeWarnings(): { file: string; message: string }[] {
  return scanWarnings
}

/** One theme by id — built-in or user. */
export async function findTheme(id: string): Promise<ThemeFile | null> {
  const builtin = getBuiltInTheme(id)
  if (builtin) return builtin
  const user = await scan()
  return user.get(id)?.theme ?? null
}

/** A theme's raw file text, for the built-in editor. */
export async function readThemeSource(id: string): Promise<string | null> {
  const builtin = getBuiltInTheme(id)
  if (builtin) return serializeTheme(builtin)
  const user = await scan()
  const entry = user.get(id)
  if (!entry) return null
  try {
    return await fs.readFile(entry.file, 'utf8')
  } catch {
    return serializeTheme(entry.theme)
  }
}

/**
 * Resolve a theme id to the custom properties the renderer applies.
 *
 * Falls back to the default rather than failing: a theme deleted outside the
 * app (or a stale id in settings) must still boot into a usable window.
 */
export async function resolveThemeById(
  id: string | null,
  platform: PlatformId
): Promise<ResolvedTheme> {
  const user = await scan()
  const lookup = (themeId: string): ThemeFile | undefined =>
    getBuiltInTheme(themeId) ?? user.get(themeId)?.theme
  const theme = (id ? lookup(id) : undefined) ?? getBuiltInTheme(DEFAULT_THEME_ID)!
  return resolveTheme(theme, platform, lookup)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function themeDir(id: string): string {
  return path.join(userThemesDir(), id)
}

/** Write a theme, creating its folder. Returns the id actually used. */
export async function writeTheme(
  source: string,
  options: { id?: string } = {}
): Promise<{ ok: true; id: string; warnings: string[] } | { ok: false; error: string }> {
  const parsed = parseTheme(source)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const theme = parsed.theme
  const id = options.id ?? theme.id
  if (!isValidThemeId(id)) {
    return { ok: false, error: 'Invalid theme id — use lowercase letters, digits and dashes.' }
  }
  if (isBuiltInThemeId(id)) {
    return { ok: false, error: `"${id}" is a built-in theme. Duplicate it under a new id instead.` }
  }
  // Rewrite a theme where it was found, so editing one that lives in
  // `~/.roxy/themes` (or is checked into dotfiles) updates that file rather
  // than silently forking a second copy into userData that then shadows it.
  const existing = (await scan()).get(id)
  const target = existing?.file ?? path.join(themeDir(id), THEME_FILENAME)
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    // Serialize from the PARSED theme, not the raw text: that strips anything
    // validation dropped, so what's on disk is exactly what the app applies.
    await fs.writeFile(target, serializeTheme({ ...theme, id }), 'utf8')
  } catch (err) {
    return { ok: false, error: `Could not write the theme: ${(err as Error).message}` }
  }
  refreshThemes()
  return { ok: true, id, warnings: parsed.warnings }
}

/** Create a new theme, or duplicate an existing one, under a fresh id. */
export async function createTheme(input: {
  name: string
  from?: string
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = input.name.trim() || 'My theme'
  const user = await scan()
  // Take the first free id, so "Duplicate" twice doesn't overwrite the first.
  const base = sanitizeThemeId(name)
  let id = base
  for (let n = 2; isBuiltInThemeId(id) || user.has(id); n++) id = `${base}-${n}`

  let seed: ThemeFile
  if (input.from) {
    const source = await findTheme(input.from)
    if (!source) return { ok: false, error: `No theme named "${input.from}".` }
    seed = { ...source, id, name, description: source.description, author: source.author }
  } else {
    seed = starterTheme(id, name)
  }
  const written = await writeTheme(serializeTheme(seed), { id })
  if (!written.ok) return written
  return { ok: true, id }
}

/** Delete a user theme. Built-ins are not deletable. */
export async function deleteTheme(id: string): Promise<{ ok: boolean; error?: string }> {
  if (isBuiltInThemeId(id)) return { ok: false, error: 'Built-in themes cannot be deleted.' }
  const user = await scan()
  const entry = user.get(id)
  if (!entry) return { ok: false, error: `No theme named "${id}".` }
  // Only remove a folder we own. A bare `<id>.json` dropped in a root has its
  // own file removed instead of its parent, which is a shared directory.
  try {
    const owned = path.resolve(entry.location).startsWith(path.resolve(userThemesDir()))
    if (owned && path.basename(entry.location) === id) {
      await fs.rm(entry.location, { recursive: true, force: true })
    } else {
      await fs.rm(entry.file, { force: true })
    }
  } catch (err) {
    return { ok: false, error: `Could not delete the theme: ${(err as Error).message}` }
  }
  refreshThemes()
  return { ok: true }
}
