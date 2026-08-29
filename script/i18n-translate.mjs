#!/usr/bin/env node
/**
 * Fill in the translated catalogs from `locales/default.json`, via OpenRouter.
 *
 *   OPENROUTER_API_KEY=sk-or-… npm run i18n:translate
 *   npm run i18n:translate -- --lang es,fr      # only these
 *   npm run i18n:translate -- --all             # redo strings already translated
 *   npm run i18n:translate -- --model google/gemini-2.5-flash
 *   npm run i18n:translate -- --dry-run         # show the plan, call nothing
 *
 * Only strings that still need a pass are sent: a key missing from a catalog, or
 * one still holding the English text. Re-running is therefore cheap and mostly a
 * no-op, which is what makes it safe to wire to a button.
 *
 * The model is asked for JSON and its output is VALIDATED before it lands:
 * placeholders and inline tags must survive, or the string is rejected and the
 * English is kept. A model that helpfully translates `{{version}}` would
 * otherwise render a blank in the UI, and a dropped `<code>` silently removes a
 * node from <Trans>. Rejections are reported, never written.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = join(ROOT, 'src/renderer/src/locales')
const SHARED_I18N = join(ROOT, 'src/shared/i18n.ts')

// ---- args ------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : (argv[i + 1] ?? '')
}
const has = (name) => argv.includes(`--${name}`)

const DRY = has('dry-run')
const REDO_ALL = has('all')
// Cheap, fast, and good enough for UI strings. Overridable.
const MODEL = flag('model') || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash'
// How many strings per request. Small enough to stay reliable, large enough
// that a full catalog is a handful of calls rather than hundreds.
const BATCH = Number(flag('batch') || 40)
const CONCURRENCY = Number(flag('concurrency') || 3)

// ---- language registry (single source of truth: shared/i18n.ts) ------------

function languages() {
  const src = readFileSync(SHARED_I18N, 'utf8')
  const block = src.match(/export const LANGUAGES[^[]*\[([\s\S]*?)\n\] as const/)
  if (!block) throw new Error('could not find LANGUAGES in src/shared/i18n.ts')
  const out = []
  for (const m of block[1].matchAll(
    /code:\s*'([\w-]+)'[^}]*?name:\s*'([^']+)'[^}]*?nativeName:\s*'([^']+)'/g
  )) {
    out.push({ code: m[1], name: m[2], nativeName: m[3] })
  }
  const source = src.match(/export const SOURCE_LANGUAGE = '([\w-]+)'/)?.[1]
  if (!out.length || !source) throw new Error('could not parse LANGUAGES')
  return { list: out, source }
}

const { list: LANGS, source: SOURCE } = languages()

const requested = (flag('lang') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const targets = LANGS.filter(
  (l) => l.code !== SOURCE && (!requested.length || requested.includes(l.code))
)

if (requested.length) {
  const known = new Set(LANGS.map((l) => l.code))
  const bad = requested.filter((c) => !known.has(c))
  if (bad.length) throw new Error(`unknown language(s): ${bad.join(', ')}`)
}

// ---- catalog helpers -------------------------------------------------------

const catalogPath = (code) => join(LOCALES, code === SOURCE ? 'default.json' : `${code}.json`)

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}

function nest(flat) {
  const out = {}
  for (const key of Object.keys(flat).sort()) {
    const parts = key.split('.')
    let node = out
    for (const p of parts.slice(0, -1)) {
      if (typeof node[p] !== 'object' || node[p] === null) node[p] = {}
      node = node[p]
    }
    node[parts.at(-1)] = flat[key]
  }
  return out
}

const readCatalog = (code) =>
  existsSync(catalogPath(code)) ? JSON.parse(readFileSync(catalogPath(code), 'utf8')) : {}

const writeCatalog = (code, flat) =>
  writeFileSync(catalogPath(code), `${JSON.stringify(nest(flat), null, 2)}\n`)

// ---- validation ------------------------------------------------------------

const vars = (s) => new Set([...String(s).matchAll(/{{\s*(\w+)[^}]*}}/g)].map((m) => m[1]))
const tags = (s) =>
  [...String(s).matchAll(/<\/?(\w+)[^>]*>/g)]
    .map((m) => m[1].toLowerCase())
    .sort()
    .join(',')

/**
 * Reject anything that would render wrong. Returning a reason (not a boolean)
 * so the run can say WHY a string was skipped.
 */
function reject(source, candidate) {
  if (typeof candidate !== 'string') return 'not a string'
  if (!candidate.trim()) return 'empty'
  const want = vars(source)
  const got = vars(candidate)
  const lost = [...want].filter((v) => !got.has(v))
  const invented = [...got].filter((v) => !want.has(v))
  if (lost.length) return `dropped {{${lost.join('}}, {{')}}}`
  if (invented.length) return `invented {{${invented.join('}}, {{')}}}`
  if (tags(source) !== tags(candidate))
    return `markup changed (${tags(source)} -> ${tags(candidate)})`
  return null
}

// ---- the prompt ------------------------------------------------------------

function buildPrompt(lang, entries) {
  const payload = Object.fromEntries(entries.map(([k, v]) => [k, v]))
  return [
    {
      role: 'system',
      content: [
        `You translate UI strings for Roxy, a desktop AI coding assistant used by software engineers.`,
        `Translate from English into ${lang.name} (${lang.nativeName}).`,
        ``,
        `Rules — these are hard requirements, not preferences:`,
        `1. Reply with ONE JSON object: the same keys, translated values. No prose, no code fences.`,
        `2. Keep every {{placeholder}} EXACTLY as-is. Never translate, reorder the braces, or rename them.`,
        `3. Keep every inline tag (<code>, <strong>, <em>, <span>, <0>) exactly, same count, same order.`,
        `   Translate the text between tags, never the tag itself.`,
        `4. Do NOT translate: product or brand names (Roxy, GitHub, MCP, Exa, Electron, Chromium, Node,`,
        `   models.dev, OpenRouter), code identifiers, file names, paths, CLI flags, git terms that`,
        `   engineers use untranslated in your language (commit, branch, worktree, stash, push, pull request),`,
        `   or anything inside <code>…</code>.`,
        `5. Keys ending _one / _other are plural forms of the same string. Translate each for its`,
        `   grammatical number. If your language needs different plural categories, still return exactly`,
        `   the keys you were given.`,
        `6. Match the register: concise, plain, professional. This is UI chrome — buttons, tooltips,`,
        `   short help text. Prefer the wording a native ${lang.name} developer tool would use.`,
        `7. Keep the typographic conventions of ${lang.name} (quotation marks, spacing before punctuation).`,
        `8. Preserve leading/trailing spaces and newlines (\\n) exactly — they are layout.`
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify(payload, null, 2)
    }
  ]
}

// ---- OpenRouter ------------------------------------------------------------

const KEY = process.env.OPENROUTER_API_KEY

async function translateBatch(lang, entries, attempt = 1) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/roxy-gg/roxy',
      'X-Title': 'Roxy i18n'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: buildPrompt(lang, entries),
      // Deterministic-ish: this is not a creative task.
      temperature: 0.2,
      response_format: { type: 'json_object' }
    })
  })

  if (!res.ok) {
    const body = await res.text()
    // 429/5xx are worth retrying; a 400 means the request itself is wrong.
    if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
      const wait = 1000 * 2 ** attempt
      console.log(`    ${lang.code}: HTTP ${res.status}, retrying in ${wait}ms`)
      await new Promise((r) => setTimeout(r, wait))
      return translateBatch(lang, entries, attempt + 1)
    }
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`)
  }

  const json = await res.json()
  const text = json.choices?.[0]?.message?.content
  if (!text) throw new Error('no content in response')

  try {
    // Some models still wrap JSON in a fence despite response_format.
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    if (attempt < 3) return translateBatch(lang, entries, attempt + 1)
    throw new Error(`unparseable JSON: ${String(text).slice(0, 200)}`)
  }
}

/** Run `jobs` with a bounded number in flight. */
async function pool(jobs, limit) {
  const results = []
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (i < jobs.length) results.push(await jobs[i++]())
    })
  )
  return results
}

// ---- main ------------------------------------------------------------------

const sourceFlat = flatten(JSON.parse(readFileSync(catalogPath(SOURCE), 'utf8')))
const sourceKeys = Object.keys(sourceFlat)

console.log(`i18n:translate — ${sourceKeys.length} keys in default.json`)
console.log(`model: ${MODEL}${DRY ? '  (dry run)' : ''}\n`)

if (!DRY && !KEY) {
  console.error('OPENROUTER_API_KEY is not set.')
  console.error('Get one at https://openrouter.ai/keys, then:')
  console.error('  OPENROUTER_API_KEY=sk-or-… npm run i18n:translate')
  process.exit(1)
}

let totalTranslated = 0
let totalRejected = 0

for (const lang of targets) {
  const existing = flatten(readCatalog(lang.code))

  // Needs a pass = absent, or still holding the English text. The second case
  // is what `i18n:sync` leaves behind when it seeds a new key.
  const todo = sourceKeys.filter((k) => {
    if (!(k in existing)) return true
    if (REDO_ALL) return true
    return existing[k] === sourceFlat[k]
  })

  if (!todo.length) {
    console.log(`${lang.code} ${lang.name} — up to date`)
    continue
  }

  console.log(`${lang.code} ${lang.name} — ${todo.length} string(s) to translate`)
  if (DRY) {
    for (const k of todo.slice(0, 5)) console.log(`    ${k}`)
    if (todo.length > 5) console.log(`    … and ${todo.length - 5} more`)
    continue
  }

  const batches = []
  for (let i = 0; i < todo.length; i += BATCH) {
    batches.push(todo.slice(i, i + BATCH).map((k) => [k, sourceFlat[k]]))
  }

  const merged = { ...existing }
  let ok = 0
  const rejected = []

  await pool(
    batches.map((entries, n) => async () => {
      try {
        const out = await translateBatch(lang, entries)
        for (const [key, source] of entries) {
          const candidate = out[key]
          const why = reject(source, candidate)
          if (why) {
            rejected.push(`${key} (${why})`)
            // Leave the English in place rather than shipping something broken.
            merged[key] = existing[key] ?? source
          } else {
            merged[key] = candidate
            ok++
          }
        }
      } catch (err) {
        console.log(`    batch ${n + 1}/${batches.length} failed: ${err.message}`)
        for (const [key, source] of entries) merged[key] = existing[key] ?? source
      }
    }),
    CONCURRENCY
  )

  // Never carry keys the source no longer has.
  for (const k of Object.keys(merged)) if (!(k in sourceFlat)) delete merged[k]
  writeCatalog(lang.code, merged)

  totalTranslated += ok
  totalRejected += rejected.length
  console.log(`    wrote ${ok}/${todo.length}`)
  for (const r of rejected.slice(0, 5)) console.log(`    ! kept English: ${r}`)
  if (rejected.length > 5) console.log(`    ! … and ${rejected.length - 5} more`)
}

if (DRY) {
  console.log('\ndry run — nothing was written')
} else {
  console.log(
    `\ntranslated ${totalTranslated} string(s)` +
      (totalRejected ? `, ${totalRejected} rejected and left in English` : '')
  )
  console.log('Run `npm run i18n` to confirm the catalogs are in sync.')
}
