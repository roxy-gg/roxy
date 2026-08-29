/**
 * The set of languages the UI ships in.
 *
 * This lives in `shared/` and not in the renderer because BOTH sides need it:
 * the renderer to render, and main to validate what it writes to the settings
 * table. Adding a language is a one-line change here plus a `locales/<code>.json`
 * — and `npm run i18n:translate` will write that file for you.
 *
 * The list past English is roughly "most spoken", which is also the order the
 * translation script fills them in.
 */

/**
 * The language every string is authored in, and the fallback for any gap.
 *
 * Its catalog is `locales/default.json` rather than `locales/en.json`: the file
 * contributors type new strings into is the DEFAULT copy, and it happens to be
 * English. Naming it after the language invites treating it as one translation
 * among many, which it is not — every other file is generated from it.
 */
export const SOURCE_LANGUAGE = 'en'

export type Language = 'en' | 'zh' | 'hi' | 'es' | 'ar' | 'fr' | 'pt' | 'ru' | 'de' | 'ja'

export type LanguageOption = {
  code: Language
  /** English name, for prose and for logs. */
  name: string
  /** The name in the language itself — what the picker actually shows. */
  nativeName: string
  /** Right-to-left script. Drives `<html dir>`. */
  rtl?: boolean
}

/**
 * Ordered as the picker lists them: the source language first, then the rest.
 */
export const LANGUAGES: readonly LanguageOption[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'zh', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', rtl: true },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' }
] as const

export const LANGUAGE_CODES: readonly Language[] = LANGUAGES.map((l) => l.code)

export const DEFAULT_LANGUAGE: Language = SOURCE_LANGUAGE

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGE_CODES as readonly string[]).includes(value)
}

/**
 * Coerce anything — a settings row, a `navigator.language`, a CLI argument —
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

/** `dir` for `<html>`. Only Arabic is RTL today, but the check is by data. */
export function languageDir(code: Language): 'ltr' | 'rtl' {
  return languageOption(code).rtl ? 'rtl' : 'ltr'
}
