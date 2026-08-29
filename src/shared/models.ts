/**
 * Model-selection helpers shared by the renderer, the remote host, and the
 * onboarding connect flow. models.dev already returns each provider's list
 * newest-first, so "use the latest model" is just "take the first" — preferring
 * a tool-capable one, since Roxy is an agent that calls tools every turn.
 */
import type { ModelInfo } from './api'

/**
 * Pick a sensible default model from a provider's catalog so a freshly connected
 * provider "just works" without the user typing a model name: the newest
 * tool-capable model, else the newest model overall. Returns undefined only when
 * the catalog is empty (offline, or a provider models.dev doesn't know).
 */
export function pickDefaultModel(models: ModelInfo[]): string | undefined {
  if (models.length === 0) return undefined
  const toolCapable = models.find((m) => m.toolCall)
  return (toolCapable ?? models[0]).id
}

/**
 * Providers whose catalog names arrive with a "Vendor: " prefix we hide.
 *
 * Deliberately a set and not "every provider": on a gateway reselling many
 * vendors that prefix is the ONLY vendor signal a row has, since the logo beside
 * it is the gateway's and identical on all 300+ rows. Dropping it is a judgement
 * that the repetition costs more than the signal, and that judgement has been
 * made for Roxy's own inference only. OpenRouter reports identically shaped
 * names and is one entry away if the same call gets made for it.
 */
const VENDOR_PREFIXED_PROVIDERS = new Set(['roxy'])

/** Lowercase alphanumerics only, so `x-ai`, `xAI` and `X.AI` compare equal. */
function normalizeVendor(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * What to SHOW for a model: the catalog name, minus the vendor prefix on the
 * providers that carry one.
 *
 * Roxy's gateway proxies OpenRouter, so its names arrive in OpenRouter's shape —
 * "Anthropic: Claude Opus 4.5", "Google: Gemini 3 Pro". In a 320px menu where
 * every row already wears the same Roxy mark, that prefix repeats on every line
 * and truncates away the part that actually differs.
 *
 * It is removed only once the model's OWN id vouches for the prefix being a
 * vendor (`anthropic/claude-opus-4.5`), so a colon belonging to the model name
 * survives: "Venice: Uncensored" on a `cognitivecomputations/…` id keeps its
 * full name rather than being silently shortened to something that no longer
 * identifies it. `meta-llama` vs "Meta" and `mistralai` vs "Mistral" are why
 * either side may be the longer form, and why the compare ignores punctuation.
 *
 * DISPLAY ONLY — the catalog keeps the full name, which matters twice: the
 * picker's search haystack still matches on the vendor (typing "anthropic"
 * finds every Claude), and the catalog's name sort still groups the list by
 * vendor, so the menu stays vendor-ordered while reading as a plain list of
 * models.
 */
export function modelLabel(providerId: string, name: string, modelId: string): string {
  const full = name.trim()
  if (!VENDOR_PREFIXED_PROVIDERS.has(providerId)) return full
  const colon = full.indexOf(':')
  if (colon <= 0) return full
  const model = full.slice(colon + 1).trim()
  if (!model) return full
  const slash = modelId.indexOf('/')
  if (slash <= 0) return full
  const prefix = normalizeVendor(full.slice(0, colon))
  const vendor = normalizeVendor(modelId.slice(0, slash))
  if (!prefix || !vendor) return full
  return prefix.startsWith(vendor) || vendor.startsWith(prefix) ? model : full
}
