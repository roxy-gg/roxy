/**
 * The model picker's list, as data.
 *
 * Pure data with no DOM and no React means filtering and row generation can be
 * asserted directly in test/shared.ts instead of being eyeballed in a running app.
 */
import type { ModelInfo } from '../../../shared/api'
import { modelLabel } from '../../../shared/models'

/** The subset of a connected provider this list needs. */
export interface RowProvider {
  id: string
  name: string
}

/** A model catalog entry plus its pre-lowercased search text. */
export interface IndexEntry {
  info: ModelInfo
  haystack: string
}

/**
 * Build the `provider:model` lookup used for both search and per-row detail.
 *
 * Names are lowercased ONCE here rather than on every keystroke, and the
 * per-row `find()` scans this replaces were quadratic in the catalog size.
 */
export function buildModelIndex(catalogs: Record<string, ModelInfo[]>): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>()
  for (const [providerId, list] of Object.entries(catalogs)) {
    for (const info of list) {
      map.set(`${providerId}:${info.id}`, {
        info,
        haystack: `${info.name.toLowerCase()}\u0000${info.id.toLowerCase()}`
      })
    }
  }
  return map
}

export interface ProviderModelRow {
  key: string
  providerId: string
  providerName: string
  modelId: string
  label: string
  info: ModelInfo | undefined
}

/**
 * Build the model rows for a single provider's view in the carousel picker.
 */
export function buildProviderModelRows(input: {
  provider: RowProvider
  catalog: ModelInfo[]
  index: Map<string, IndexEntry>
  query: string
  hidden: ReadonlySet<string>
}): ProviderModelRow[] {
  const { provider, catalog, index, query, hidden } = input
  const q = query.trim().toLowerCase()
  const out: ProviderModelRow[] = []
  const seen = new Set<string>()

  for (const m of catalog) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    const key = `${provider.id}:${m.id}`
    if (hidden.has(key)) continue
    if (q) {
      const entry = index.get(key)
      if (!entry?.haystack.includes(q)) continue
    }
    const hit = index.get(key)
    out.push({
      key,
      providerId: provider.id,
      providerName: provider.name,
      modelId: m.id,
      label: modelLabel(provider.id, hit?.info.name ?? m.name ?? m.id, m.id),
      info: hit?.info
    })
  }

  return out
}

/**
 * Count matching models for each provider when a search query is active.
 */
export function countMatchesByProvider(input: {
  providers: RowProvider[]
  catalogs: Record<string, ModelInfo[]>
  index: Map<string, IndexEntry>
  query: string
  hidden: ReadonlySet<string>
}): Record<string, number> {
  const { providers, catalogs, index, query, hidden } = input
  const counts: Record<string, number> = {}
  for (const p of providers) {
    counts[p.id] = buildProviderModelRows({
      provider: p,
      catalog: catalogs[p.id] ?? [],
      index,
      query,
      hidden
    }).length
  }
  return counts
}
