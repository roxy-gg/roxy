/**
 * The set of languages the UI ships in.
 *
 * This lives in `shared/` and not in the renderer because BOTH sides need it:
 * the renderer to render, and main to validate what it writes to the settings
 * table. Adding a language is meant to be a three-line change here plus a new
 * `locales/<code>.json` - see script/i18n-sync.mjs, which reads this file as
 * the source of truth for which catalogs must exist.
 */

/** The language every string is authored in, and the fallback for any gap. */
export const SOURCE_LANGUAGE = 'en'

export type Language = 'en' | 'es'

export type LanguageOption = {
  code: Language
  /** English name, for prose and for logs. */
  name: string
  /** The name in the language itself - what the picker actually shows. */
  nativeName: string
}

/**
 * Ordered as the picker lists them: the source language first, then the rest.
 */
export const LANGUAGES: readonly LanguageOption[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' }
] as const

export const LANGUAGE_CODES: readonly Language[] = LANGUAGES.map((l) => l.code)

export const DEFAULT_LANGUAGE: Language = SOURCE_LANGUAGE

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGE_CODES as readonly string[]).includes(value)
}

/**
 * Coerce anything - a settings row, a `navigator.language`, a CLI argument -
 * into a language we actually have a catalog for.
 *
 * Matches on the base subtag, so `es-419`, `es-MX` and `ES` all land on `es`.
 * Anything unrecognised falls back rather than throwing: a bad value in the
 * database must never be able to stop the app from rendering.
 */
export function normalizeLanguage(value: unknown, fallback: Language = DEFAULT_LANGUAGE): Language {
  if (typeof value !== 'string') return fallback
  const base = value.trim().toLowerCase().split(/[-_]/)[0]
  return isLanguage(base) ? base : fallback
}

export function languageOption(code: Language): LanguageOption {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0]
}
