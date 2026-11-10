/**
 * Sidebar session search - the pure matching rules, kept out of the component so
 * they can be unit-tested without a DOM (see `test/shared.ts`).
 *
 * A query is split into whitespace-separated terms and a session matches only
 * when EVERY term appears somewhere in its searchable text (project name, title,
 * branch). Terms are order-independent and may land in different fields, so
 * `roxy sidebar` finds "Fix sidebar width" inside the "roxy" project.
 *
 * Matching is case- and accent-insensitive: typing `sesion` finds "Sesión".
 */

/** Lowercase and strip combining marks, so `É`, `é` and `e` all compare equal. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Turn the raw input into folded search terms. An empty array means "no filter":
 * callers must treat it as match-everything rather than match-nothing.
 */
export function parseSessionQuery(raw: string): string[] {
  return fold(raw).split(/\s+/).filter(Boolean)
}

/**
 * Whether the given searchable fields satisfy every term. Missing fields
 * (`null` / `undefined`, e.g. a session with no branch) are skipped.
 */
export function matchesSessionQuery(
  terms: readonly string[],
  fields: readonly (string | null | undefined)[]
): boolean {
  if (terms.length === 0) return true
  const haystack = fold(fields.filter((field): field is string => !!field).join('\n'))
  return terms.every((term) => haystack.includes(term))
}
