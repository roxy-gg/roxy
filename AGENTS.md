# AGENTS.md

Notes for anyone — human or agent — writing code in this repo.

## User-facing strings live in `default.json`

**Never hardcode English in a component.** Every string a user can read goes in:

```
src/renderer/src/locales/default.json
```

That file is the source of truth. Every other `locales/<code>.json` is generated
from it by `npm run i18n:translate`, so **only edit `default.json` by hand** —
edits to the translated catalogs get overwritten.

It is called `default.json` and not `en.json` on purpose: it is the file you
type new strings into, and it happens to be English. Naming it after a language
invites treating it as one translation among many, which it is not.

### Writing a string

```tsx
import { useTranslation } from 'react-i18next'

function MyThing(): JSX.Element {
  const { t } = useTranslation()
  return <button title={t('myThing.save')}>{t('myThing.save')}</button>
}
```

```json
{ "myThing": { "save": "Save" } }
```

A hook cannot be shared between components — **every component that calls `t`
needs its own `useTranslation()`**.

Keys are checked against `default.json` at compile time. A typo is a build
error, not something you find in a screenshot later. That is the whole point:

```
error TS2345: Argument of type '["myThing.svae"]' is not assignable …
```

### Interpolation

Put the variable in the string, not around it. Never concatenate.

```tsx
// GOOD
t('session.renamed', { name })
// "session.renamed": "Renamed to {{name}}"

// BAD — untranslatable: word order is not universal
<>Renamed to {name}</>
```

### Plurals

Use i18next plural suffixes. Do not write `n === 1 ? '' : 's'`.

```json
{
  "repoCount_one": "{{count}} repo",
  "repoCount_other": "{{count}} repos"
}
```

```tsx
t('repoCount', { count: n })
```

Languages disagree about how many plural forms exist — English and Spanish have
2, Polish 3, Arabic 6. The tooling compares plurals on the **base key**, so a
locale carrying forms English lacks is fine and is not reported as drift.

Watch for agreement that hangs off the same count. This is one key, not three:

```json
{
  "blocked_one": "{{names}} has local commits — reset it first",
  "blocked_other": "{{names}} have local commits — reset them first"
}
```

### Inline markup

If a sentence contains a `<code>`, `<strong>` or a link, keep it as ONE string
and render with `<Trans>`. Splitting it into fragments makes it untranslatable,
because other languages reorder the parts.

```tsx
<Trans i18nKey="themes.colorsBody" />
```

```json
{ "colorsBody": "Any CSS color — hex, <code>rgb()</code>, or <code>oklch()</code>." }
```

For a component that needs props, pass it explicitly:

```tsx
<Trans i18nKey="skills.body" components={{ code: <code className="text-text" /> }} />
```

The tooling verifies that every `{{variable}}` and every inline tag survives
translation — a model that helpfully "translates" `{{version}}` would otherwise
render a blank, and a dropped `<code>` silently removes the node.

### Strings outside a component

A module-scope function or a lookup table cannot call a hook. Two options:

**Thread `t` in as a parameter:**

```ts
function rowTitle(chat: Chat, t: TFunction): string {
  return t('sidebar.rowDirty')
}
```

**Or store keys instead of text**, and translate at the call site:

```ts
const ACTION_LABEL = {
  push: 'workstream.action.push'
} as const satisfies Record<Action, string>

// at render:
t(ACTION_LABEL[action])
```

Use `as const satisfies`, not `Record<K, string>` — the latter widens the values
to `string` and `t()` will (correctly) refuse them.

## What NOT to translate

Getting this wrong is worse than leaving a string in English.

| Don't translate                                     | Why                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Anything in `src/shared/*` that **main** also reads | The main process has no i18next instance. Strings it builds cross IPC already-rendered.                                                    |
| Sentinel / enum values                              | `'(no folder)'`, `service.status`, agent ids — compared with `===`, used as map keys, or persisted. Translating one silently breaks logic. |
| Text sent to a model                                | Agent descriptions, theme token hints, tool descriptions. The model needs the English vocabulary the validator enforces.                   |
| Product and brand names                             | Roxy, GitHub, MCP, `models.dev`, provider names.                                                                                           |
| Format-hint placeholders                            | `sk-…`, `https://…`, `e.g. owner/repo`. These show shape, not prose.                                                                       |
| User data                                           | Session titles, branch names, file paths, shell commands.                                                                                  |

If a string is user-facing **and** produced in main, it needs main to return
`{ key, params }` and the renderer to resolve it. That is a real refactor of the
IPC payload — don't half-do it by translating one end.

## Adding a language

1. Add it to `LANGUAGES` in `src/shared/i18n.ts` (code, English name, native
   name, and `rtl: true` if the script is right-to-left).
2. Add the import + `resources` entry in `src/renderer/src/i18n.ts`.
3. Run `npm run i18n:translate -- --lang <code>`.

## Commands

```
npm run i18n            # report drift; fails CI if catalog SHAPES disagree
npm run i18n:sync       # migrate catalogs to the default.json shape
npm run i18n:json       # machine-readable report (what the translator consumes)
npm run i18n:translate  # fill in translations via OpenRouter (needs OPENROUTER_API_KEY)
```

An untranslated string is **not** a CI failure — it renders as English, which is
a fine temporary state. Only a shape mismatch (missing key, stale key, dropped
`{{var}}`, mangled tag) fails the build.

## Before you push

```
npm run format
npm run typecheck
npm run i18n
npm run smoke:shared && npm run smoke:i18n && npm run smoke:store
```
