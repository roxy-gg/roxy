/**
 * GitHub Copilot premium-request usage, read from the same endpoint the
 * official editors use for their usage meter. Kept apart from copilot.ts
 * because it needs llm.ts's token renewal, and llm.ts imports copilot.ts.
 */
import * as repo from '../db/repo'
import { freshGitHubAccessToken } from './llm'
import {
  COPILOT_USER_URL,
  parseCopilotUser,
  quotaErrorMessage,
  type ConnectionQuota
} from '../../shared/quota'

const TTL_MS = 60_000
const cache = new Map<string, { at: number; value: Promise<ConnectionQuota> }>()

async function fetchCopilotQuota(connectionId: string): Promise<ConnectionQuota> {
  const base = { connectionId, upstream: 'copilot' as const, fetchedAt: Date.now() }
  if (repo.getProviderSeedId(connectionId) !== 'github-copilot') {
    return { ...base, buckets: [], error: 'Not a GitHub Copilot account.' }
  }
  let token: string
  try {
    token = await freshGitHubAccessToken(connectionId)
  } catch (e) {
    return { ...base, buckets: [], error: e instanceof Error ? e.message : String(e) }
  }
  const res = await fetch(COPILOT_USER_URL, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Roxy'
    },
    signal: AbortSignal.timeout(15_000)
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) return { ...base, buckets: [], error: quotaErrorMessage(res.status, text) }
  const parsed = parseCopilotUser(text)
  if (!parsed.buckets.length && !parsed.premium) {
    return { ...base, ...parsed, error: 'No usage data returned.' }
  }
  return { ...base, ...parsed }
}

/** Cached for a minute and de-duplicated; failures are retried on the next ask. */
export function copilotQuota(connectionId: string, force = false): Promise<ConnectionQuota> {
  const hit = cache.get(connectionId)
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.value
  const value = fetchCopilotQuota(connectionId).catch(
    (e): ConnectionQuota => ({
      connectionId,
      upstream: 'copilot',
      buckets: [],
      fetchedAt: Date.now(),
      error: e instanceof Error ? e.message : String(e)
    })
  )
  cache.set(connectionId, { at: Date.now(), value })
  void value.then((q) => {
    if (q.error && cache.get(connectionId)?.value === value) cache.delete(connectionId)
  })
  return value
}
