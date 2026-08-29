#!/usr/bin/env node
/**
 * Keep every translation catalog in step with the English one.
 *
 * English (`SOURCE_LANGUAGE`) is the source of truth: strings are authored
 * there, and every other locale is a projection of it. This script is what
 * makes that relationship checkable instead of aspirational.
 *
 *   node script/i18n-sync.mjs           # report drift, exit 1 if any
 *   node script/i18n-sync.mjs --write   # migrate: add/prune keys in place
 *   node script/i18n-sync.mjs --json    # machine-readable, for a translator bot
 *
 * `--write` is the migration step. It brings a catalog back to the English
 * SHAPE without inventing translations: a new key is written with the English
 * text and listed under `todo` in the JSON report, so the gap is visible to a
 * human (and, later, to whatever model does the translating) instead of showing
 * up as a raw `settings.foo.bar` in the UI.
 *
 * It never overwrites an existing translation. The only destructive thing it
 * does is remove keys English no longer has, which are dead weight by
 * definition.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = join(ROOT, 'src/renderer/src/locales')
const SHARED_I18N = join(ROOT, 'src/shared/i18n.ts')

const argv = new Set(process.argv.slice(2))
const WRITE = argv.has('--write')
const JSON_OUT = argv.has('--json')

/**
 * Read the language list out of shared/i18n.ts rather than duplicating it.
 *
 * A regex and not an import because this file is plain Node with no TypeScript
 * loader in the toolchain; the shape it depends on is a literal `code:` in the
 * LANGUAGES array, which is stable and asserted below.
 */
function languages() {
  const src = readFileSync(SHARED_I18N, 'utf8')
  const block = src.match(/export const LANGUAGES[^[]*\[([\s\S]*?)\n\] as const/)
  if (!block) throw new Error('i18n-sync: could not find LANGUAGES in src/shared/i18n.ts')
  const codes = [...block[1].matchAll(/code:\s*'([\w-]+)'/g)].map((m) => m[1])
  const source = src.match(/export const SOURCE_LANGUAGE = '([\w-]+)'/)?.[1]
  if (!codes.length || !source) throw new Error('i18n-sync: could not parse languages')
  return { codes, source }
}

/** Flatten nested JSON to `a.b.c` -> string, the shape i18next looks keys up by. */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}

/** Rebuild nested JSON from flat keys, so catalogs stay readable and diffable. */
function nest(flat) {
  const out = {}
  for (const key of Object.keys(flat)) {
    const parts = key.split('.')
    let node = out
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {}
      node = node[part]
    }
    node[parts.at(-1)] = flat[key]
  }
  return out
}

/** `{{name}}` placeholders. A translation that drops one renders a blank. */
function vars(value) {
  return new Set([...String(value).matchAll(/{{\s*(\w+)[^}]*}}/g)].map((m) => m[1]))
}

/**
 * i18next plural suffixes. `foo_one` / `foo_other` are two forms of ONE
 * string, not two strings, and WHICH forms a language needs is a property of
 * the language: English and Spanish take 2, Polish 3, Arabic 6.
 *
 * So plurals are compared on the BASE key. Demanding an exact suffix match
 * would flag a correct Polish `_few` as stale and a missing English `_many`
 * as a gap, which is precisely backwards.
 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
const baseKey = (key) => key.replace(PLURAL_SUFFIX, '')
const isPlural = (key) => PLURAL_SUFFIX.test(key)

/** `<code>`, `<em>` … — <Trans> needs these to survive translation. */
function tags(value) {
  return [...String(value).matchAll(/<\/?(\w+)[^>]*>/g)].map((m) => m[1].toLowerCase()).sort()
}

const catalogPath = (code) => join(LOCALES, `${code}.json`)

function readCatalog(code) {
  const file = catalogPath(code)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`i18n-sync: ${relative(ROOT, file)} is not valid JSON — ${err.message}`)
  }
}

function writeCatalog(code, flat) {
  // Sorted so a translation lands in a stable place and diffs stay small,
  // rather than wherever the merge happened to put it.
  const sorted = Object.fromEntries(
    Object.keys(flat)
      .sort()
      .map((k) => [k, flat[k]])
  )
  writeFileSync(catalogPath(code), `${JSON.stringify(nest(sorted), null, 2)}\n`)
}

// ---- compare ---------------------------------------------------------------

const { codes, source } = languages()
const sourceCatalog = readCatalog(source)
if (!sourceCatalog) throw new Error(`i18n-sync: missing source catalog ${source}.json`)
const sourceFlat = flatten(sourceCatalog)
const sourceKeys = Object.keys(sourceFlat)

const report = { source, total: sourceKeys.length, locales: {} }
let drift = 0

for (const code of codes) {
  if (code === source) continue

  const existing = readCatalog(code)
  const flat = existing ? flatten(existing) : {}

  // Plurals compare on the base key: a locale satisfies `foo_one`/`foo_other`
  // by supplying whatever forms ITS language needs under `foo_*`.
  const haveBases = new Set(Object.keys(flat).map(baseKey))
  const sourceBases = new Set(sourceKeys.map(baseKey))

  const missing = [...new Set(sourceKeys.filter((k) => !haveBases.has(baseKey(k))).map(baseKey))]
  const stale = Object.keys(flat).filter((k) => !sourceBases.has(baseKey(k)))

  // A key present in both but still holding the English text is untranslated,
  // not translated-identically — except where the two languages genuinely
  // agree (product names, "MCP", "—"), which is why this is reported
  // separately from `missing` rather than folded into it.
  const untranslated = sourceKeys.filter((k) => k in flat && flat[k] === sourceFlat[k])

  // The failures that actually break rendering, as opposed to just reading
  // in English: a lost `{{version}}`, or a `<code>` that <Trans> can't match.
  // Walks the LOCALE's keys, not English's: a plural form this language has
  // and English does not still has to keep its placeholders.
  const broken = []
  for (const key of Object.keys(flat)) {
    if (stale.includes(key)) continue
    const source =
      key in sourceFlat
        ? sourceFlat[key]
        : (sourceFlat[`${baseKey(key)}_other`] ?? sourceFlat[baseKey(key)])
    if (source === undefined) continue
    const want = vars(source)
    const got = vars(flat[key])
    const lost = [...want].filter((v) => !got.has(v))
    const invented = [...got].filter((v) => !want.has(v))
    if (lost.length || invented.length) {
      broken.push({ key, kind: 'interpolation', lost, invented })
    }
    const wantTags = tags(source)
    const gotTags = tags(flat[key])
    if (wantTags.join() !== gotTags.join()) {
      broken.push({ key, kind: 'markup', expected: wantTags, found: gotTags })
    }
  }

  if (WRITE) {
    // Migrate: English text for anything new, drop anything gone. Existing
    // translations are left exactly as they are.
    const merged = {}
    for (const key of sourceKeys) {
      if (key in flat) merged[key] = flat[key]
      // Only seed English when the locale has NO form of this key at all --
      // seeding `_one` into a language that wrote only `_other` would put
      // English back on screen for the singular.
      else if (!haveBases.has(baseKey(key))) merged[key] = sourceFlat[key]
    }
    // Keep plural forms this language legitimately carries and English lacks.
    for (const key of Object.keys(flat)) {
      if (!(key in merged) && isPlural(key) && sourceBases.has(baseKey(key))) {
        merged[key] = flat[key]
      }
    }
    writeCatalog(code, merged)
  }

  report.locales[code] = {
    missing,
    stale,
    broken,
    untranslated: untranslated.length,
    translated: sourceKeys.length - missing.length - untranslated.length,
    coverage: sourceKeys.length
      ? Math.round(
          ((sourceKeys.length - missing.length - untranslated.length) / sourceKeys.length) * 100
        )
      : 100,
    // What a translation pipeline would consume: every string still needing a
    // pass, with the English text to translate FROM.
    todo: [...new Set([...missing, ...untranslated])].sort().map((key) => ({
      key,
      source: sourceFlat[key] ?? sourceFlat[`${key}_other`]
    }))
  }

  if (missing.length || stale.length || broken.length) drift++
}

// ---- output ----------------------------------------------------------------

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`i18n — ${report.total} keys in ${source}.json\n`)
  for (const [code, r] of Object.entries(report.locales)) {
    const bar = `${'█'.repeat(Math.round(r.coverage / 5)).padEnd(20, '░')}`
    console.log(
      `  ${code}  ${bar} ${String(r.coverage).padStart(3)}%  (${r.translated}/${report.total})`
    )
    if (r.missing.length) {
      console.log(
        `      missing ${r.missing.length}: ${r.missing.slice(0, 5).join(', ')}${r.missing.length > 5 ? ' …' : ''}`
      )
    }
    if (r.stale.length) {
      console.log(
        `      stale ${r.stale.length}: ${r.stale.slice(0, 5).join(', ')}${r.stale.length > 5 ? ' …' : ''}`
      )
    }
    if (r.untranslated && !r.missing.length) {
      console.log(`      untranslated ${r.untranslated} (still English)`)
    }
    for (const b of r.broken) {
      if (b.kind === 'interpolation') {
        const bits = [
          b.lost.length ? `dropped ${b.lost.map((v) => `{{${v}}}`).join(' ')}` : '',
          b.invented.length ? `unknown ${b.invented.map((v) => `{{${v}}}`).join(' ')}` : ''
        ].filter(Boolean)
        console.log(`      ! ${b.key}: ${bits.join(', ')}`)
      } else {
        console.log(
          `      ! ${b.key}: markup <${b.expected.join('><')}> became <${b.found.join('><')}>`
        )
      }
    }
  }
  if (WRITE) {
    console.log(
      `\nwrote ${Object.keys(report.locales).length} catalog(s) — new keys carry English text until translated`
    )
  } else if (drift) {
    console.log(`\n${drift} catalog(s) out of sync. Run: npm run i18n:sync`)
  } else {
    console.log('\nall catalogs in sync')
  }
}

// Only a SHAPE mismatch fails the build. An untranslated string is a normal,
// temporary state - it renders as English - and must not block a merge.
if (!WRITE && drift) process.exitCode = 1
