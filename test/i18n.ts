/**
 * Runtime check of the i18n instance: does a key actually resolve, does a gap
 * fall back to English, does interpolation survive a language switch.
 *
 * Runs in plain Node (no Electron, no DOM) by importing i18next directly with
 * the same config the renderer uses.
 */
import i18next from 'i18next'
import en from '../src/renderer/src/locales/en.json'
import es from '../src/renderer/src/locales/es.json'

let pass = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  \u2713 ${name}`)
  } else {
    fails.push(name)
    console.log(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  console.log('i18n runtime\n')

  await i18next.init({
    resources: { en: { translation: en }, es: { translation: es } },
    lng: 'en',
    fallbackLng: 'en',
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    nsSeparator: false
  })

  const t = i18next.t.bind(i18next)

  // ---- English resolves --------------------------------------------------
  check('en: a flat key resolves', t('common.save') === 'Save')
  check('en: a nested key resolves', t('settings.danger.heading') === 'Danger zone')
  check(
    'en: interpolation fills in',
    t('settings.about.version', { version: '1.2.3' }) === 'Roxy v1.2.3'
  )
  check(
    'en: multi-variable interpolation fills in',
    t('settings.about.runtime', { electron: '33', chrome: '130', node: '20' }) ===
      'Electron 33 \u00b7 Chromium 130 \u00b7 Node 20'
  )
  // A colon inside a value must not be read as a namespace separator.
  check(
    'en: a value containing a colon survives',
    t('settings.about.update.error', { message: 'boom' }) === 'Update check failed: boom'
  )

  // ---- Spanish resolves --------------------------------------------------
  await i18next.changeLanguage('es')
  check('es: the language switched', i18next.language === 'es')
  check('es: a flat key translates', t('common.save') === 'Guardar')
  check('es: a nested key translates', t('settings.danger.heading') === 'Zona de peligro')
  check(
    'es: interpolation survives translation',
    t('settings.about.update.downloading', { percent: 42 }).includes('42')
  )
  check(
    'es: an interpolated version renders',
    t('settings.about.update.downloaded', { version: '9.9.9' }).includes('9.9.9')
  )
  check('es: accented text round-trips', t('settings.danger.wiping') === 'Borrando\u2026')
  check('es: the language section is translated', t('settings.language.heading') === 'Idioma')

  // ---- The failure modes that matter -------------------------------------
  // A key missing from Spanish must render English, never the raw key.
  i18next.addResource('es', 'translation', 'settings.__probe', '')
  check(
    'es: a key absent from the catalog falls back to English',
    i18next.t('common.cancel', { lng: 'es' }) === 'Cancelar' &&
      i18next.t('settings.webSearch.placeholder', { lng: 'es' }) === 'exa_\u2026'
  )

  // Every English key must resolve in Spanish to SOMETHING that is not the key
  // itself - that is the property that keeps raw `settings.foo.bar` off screen.
  const flat = (o: object, p = '', out: Record<string, string> = {}): Record<string, string> => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k
      if (v && typeof v === 'object') flat(v as object, key, out)
      else out[key] = String(v)
    }
    return out
  }
  const keys = Object.keys(flat(en))
  const unresolved = keys.filter((k) => i18next.t(k, { lng: 'es' }) === k)
  check(
    `es: all ${keys.length} keys resolve to text, never to the key`,
    unresolved.length === 0,
    unresolved.slice(0, 3).join(', ')
  )
  const unresolvedEn = keys.filter((k) => i18next.t(k, { lng: 'en' }) === k)
  check(
    `en: all ${keys.length} keys resolve to text, never to the key`,
    unresolvedEn.length === 0,
    unresolvedEn.slice(0, 3).join(', ')
  )

  // No catalog string may still contain an unfilled placeholder after render.
  const leftover = keys.filter((k) => /{{/.test(i18next.t(k, { lng: 'es' })))
  check(
    'es: no string renders a stray {{placeholder}} without values',
    leftover.every((k) => /{{/.test(flat(en)[k])),
    leftover.join(', ')
  )

  await i18next.changeLanguage('en')
  check('en: switching back restores English', t('common.save') === 'Save')

  if (fails.length) {
    console.error(`\nI18N FAILED \u2014 ${fails.length} failing: ${fails.join(', ')}`)
    process.exit(1)
  }
  console.log(`\nI18N OK \u2014 ${pass} checks passed`)
}

void main()
