import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { DEFAULT_LANGUAGE, SOURCE_LANGUAGE, languageDir, normalizeLanguage } from '@shared/i18n'
import type { Language } from '@shared/i18n'
import source from './locales/default.json'
import ar from './locales/ar.json'
import de from './locales/de.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import hi from './locales/hi.json'
import ja from './locales/ja.json'
import pt from './locales/pt.json'
import ru from './locales/ru.json'
import zh from './locales/zh.json'

/**
 * Every catalog is BUNDLED, not fetched.
 *
 * A backend plugin would mean the first paint renders raw keys until the JSON
 * lands — visible on every launch. These files are a few KB each and the app is
 * a desktop binary, so there is nothing to save by loading them lazily.
 */
export const resources = {
  en: { translation: source },
  ar: { translation: ar },
  de: { translation: de },
  es: { translation: es },
  fr: { translation: fr },
  hi: { translation: hi },
  ja: { translation: ja },
  pt: { translation: pt },
  ru: { translation: ru },
  zh: { translation: zh }
} as const

/**
 * Point `t()` at the DEFAULT catalog for types. A key that doesn't exist, or an
 * interpolation variable that isn't in the string, is now a COMPILE error
 * rather than a mystery `settings.foo.bar` rendered in the UI.
 *
 * Only the source catalog is used as the shape — the others are allowed to lag
 * behind it (missing keys fall back to English at runtime), which is exactly
 * what `script/i18n-sync.mjs` reports on.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: typeof source }
    /** Catalogs are plain JSON with real dots nowhere in the keys. */
    keySeparator: '.'
    nsSeparator: false
  }
}

void i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: SOURCE_LANGUAGE,
  // A partial translation shows English for the gaps instead of the raw key.
  returnEmptyString: false,
  interpolation: {
    // React escapes for us; i18next doing it again turns an apostrophe in a
    // Spanish string into `&#39;`.
    escapeValue: false
  },
  // `nsSeparator: false` lets a string contain a colon ("Update failed: …")
  // without i18next reading the part before it as a namespace.
  nsSeparator: false,
  react: {
    // Which tags <Trans> may keep without a matching component in `components`.
    transKeepBasicHtmlNodesFor: ['br', 'strong', 'em', 'b', 'i', 'code', 'span']
  }
})

/**
 * Switch the UI language. Safe to call with anything — an unknown value falls
 * back rather than leaving the app in a half-translated state.
 *
 * This does NOT persist; it is the render half only. `setLanguage` in the
 * store writes to the database and then calls this.
 */
export async function applyLanguage(value: unknown): Promise<Language> {
  const lang = normalizeLanguage(value)
  if (i18n.language !== lang) await i18n.changeLanguage(lang)
  // `<html lang>` drives hyphenation, spellcheck and screen-reader voice;
  // `dir` mirrors the whole layout for Arabic.
  document.documentElement.lang = lang
  document.documentElement.dir = languageDir(lang)
  return lang
}

export default i18n
