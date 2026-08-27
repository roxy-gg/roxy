/**
 * The model picker's list, as data.
 *
 * Extracted from the component for one reason: the flattened list has a
 * correctness property that is invisible in JSX and was got WRONG in review —
 * every row needs a React key unique across the whole list, and the same model
 * legitimately appears in up to three sections at once (Pinned, its provider's
 * Latest, and that provider's full catalog). Keying rows by `provider:model`
 * therefore produced duplicate sibling keys, and React reused the wrong DOM
 * node while the windowed list scrolled: rows visibly duplicated and stuck.
 *
 * Pure data with no DOM and no React means that property can be asserted
 * directly in test/shared.ts instead of being eyeballed in a running app.
 */
import type { ModelInfo } from '../../../shared/api'
import { modelLabel } from '../../../shared/models'

/** The subset of a connected provider this list needs. */
export interface RowProvider {
  id: string
  name: string
}

/** A section header. `providerId` is '' for the cross-provider Pinned header. */
export interface HeaderRow {
  kind: 'header'
  key: string
  label: string
  icon: 'pin' | 'clock' | 'provider'
  providerId: string
}

/** A selectable model. */
export interface ModelRow {
  kind: 'model'
  key: string
  providerId: string
  providerName: string
  modelId: string
  /** What to render: the catalog name, with any vendor prefix already stripped. */
  label: string
  info: ModelInfo | undefined
  pinned: boolean
}

export type Row = HeaderRow | ModelRow

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

/**
 * Flatten the whole menu — Pinned, then per provider: Latest, then everything —
 * into one array the windowing math can index into.
 *
 * A search query collapses it to a flat filtered catalog: Pinned and Latest are
 * shortcuts for "no query", and repeating their entries above the matches would
 * just show the same model three times in a five-row result.
 */
export function buildModelRows(input: {
  providers: RowProvider[]
  catalogs: Record<string, ModelInfo[]>
  recent: Record<string, { model: string }[]>
  pinned: { providerId: string; model: string }[]
  index: Map<string, IndexEntry>
  query: string
}): Row[] {
  const { providers, catalogs, recent, pinned, index, query } = input
  const q = query.trim().toLowerCase()
  const pinnedKeys = new Set(pinned.map((p) => `${p.providerId}:${p.model}`))
  const out: Row[] = []

  const modelRow = (
    section: string,
    providerId: string,
    providerName: string,
    modelId: string,
    label?: string
  ): ModelRow => {
    const hit = index.get(`${providerId}:${modelId}`)
    return {
      kind: 'model',
      // Section-prefixed: see the note at the top of this file.
      key: `${section}:${providerId}:${modelId}`,
      providerId,
      providerName,
      modelId,
      label: modelLabel(providerId, label ?? hit?.info.name ?? modelId, modelId),
      info: hit?.info,
      pinned: pinnedKeys.has(`${providerId}:${modelId}`)
    }
  }

  // Pinned renders as ONE flat list rather than grouped per provider, so a
  // shortlist spanning several providers stays a single glanceable block.
  if (!q) {
    const rows = pinned.flatMap((p) => {
      const provider = providers.find((pr) => pr.id === p.providerId)
      // Skip a pin whose provider was disconnected, or whose model is no longer
      // in the catalog - it would render as a row that cannot be selected.
      if (!provider || !index.has(`${p.providerId}:${p.model}`)) return []
      return [modelRow('pin', p.providerId, provider.name, p.model)]
    })
    if (rows.length > 0) {
      out.push({ kind: 'header', key: 'h:pinned', label: 'Pinned', icon: 'pin', providerId: '' })
      out.push(...rows)
    }
  }

  for (const p of providers) {
    const catalog = catalogs[p.id] ?? []
    const list = q
      ? catalog.filter((m) => index.get(`${p.id}:${m.id}`)?.haystack.includes(q))
      : catalog
    // A pinned model is already shown above; repeating it under Latest wastes a
    // row on a duplicate.
    const latest = q
      ? []
      : (recent[p.id] ?? []).filter(
          (r) => !pinnedKeys.has(`${p.id}:${r.model}`) && index.has(`${p.id}:${r.model}`)
        )
    if (list.length === 0 && latest.length === 0) continue

    if (latest.length > 0) {
      out.push({
        kind: 'header',
        key: `h:latest:${p.id}`,
        label: `Latest · ${p.name}`,
        icon: 'clock',
        providerId: p.id
      })
      for (const r of latest) out.push(modelRow('recent', p.id, p.name, r.model))
    }
    if (list.length > 0) {
      out.push({
        kind: 'header',
        key: `h:${p.id}`,
        label: p.name,
        icon: 'provider',
        providerId: p.id
      })
      for (const m of list) out.push(modelRow('all', p.id, p.name, m.id, m.name))
    }
  }
  return out
}
