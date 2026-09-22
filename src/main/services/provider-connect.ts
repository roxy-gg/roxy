import type { ConnectProviderResult, ProviderVerificationError } from '../../shared/api'
import type { ConnectProviderInput } from '../../shared/types'
import { resolveSeed } from '../../shared/providers'
import { connectProvider, listConnectedProviders } from '../db/repo'

/** Free, read-only credential checks. Never send a prompt or expose upstream errors. */
export async function connectVerifiedProvider(
  input: ConnectProviderInput
): Promise<ConnectProviderResult> {
  const seed = resolveSeed(input.id)
  if (seed.auth !== 'api-key') return { ok: true, provider: connectProvider(input) }
  const key = input.apiKey?.trim()
  if (!key || /\s/.test(key)) return { ok: false, error: 'invalidKey' }
  const existing = listConnectedProviders().find((p) => p.id === input.connectionId)
  const base = (
    input.baseURL === undefined && existing
      ? existing.baseURL
      : input.baseURL?.trim() || seed.baseURL
  )?.replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(
      base || (seed.wire === 'google' ? 'https://generativelanguage.googleapis.com/v1beta' : '')
    )
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      return { ok: false, error: 'invalidEndpoint' }
  } catch {
    return { ok: false, error: 'invalidEndpoint' }
  }

  let path = '/models'
  if (seed.id === 'openrouter') path = '/key'
  if (seed.wire === 'anthropic' && !url.pathname.endsWith('/v1')) path = '/v1/models'
  url.pathname = url.pathname.replace(/\/+$/, '') + path

  let error: ProviderVerificationError | undefined
  try {
    const signal = AbortSignal.timeout(10_000)
    const request = (token: string): Promise<Response> => {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (seed.wire === 'anthropic') {
        headers['x-api-key'] = token
        headers['anthropic-version'] = '2023-06-01'
      } else if (seed.wire === 'google') {
        headers['x-goog-api-key'] = token
      } else {
        headers.Authorization = `Bearer ${token}`
      }
      // Never forward credentials (including x-api-key) to a redirect destination.
      return fetch(url, { headers, signal, redirect: 'error' })
    }
    const response = await request(key)
    const body = await response.json().catch(() => null)
    if (
      response.status === 401 ||
      (seed.wire === 'google' &&
        response.status === 400 &&
        Array.isArray(body?.error?.details) &&
        body.error.details.some(
          (detail: { reason?: string }) => detail?.reason === 'API_KEY_INVALID'
        ))
    )
      error = 'invalidKey'
    else if (response.status === 403) error = 'forbidden'
    else if (response.status === 429) error = 'rateLimited'
    else if ([404, 405, 501].includes(response.status)) error = 'unsupported'
    else if (!response.ok) error = 'unavailable'
    else if (
      seed.id === 'openrouter' &&
      (body?.data?.is_management_key === true || body?.data?.is_provisioning_key === true)
    ) {
      error = 'forbidden'
    } else {
      const validBody =
        seed.id === 'openrouter'
          ? typeof body?.data?.label === 'string'
          : Array.isArray(seed.wire === 'google' ? body?.models : body?.data)
      if (!validBody) error = 'unsupported'
      else {
        // Public catalogs can return 200 even with a bogus Bearer token.
        // Only claim verification when the same endpoint rejects a control key.
        const control = await request('roxy-invalid-verification-key')
        const rejected =
          control.status === 401 ||
          control.status === 403 ||
          (seed.wire === 'google' && control.status === 400)
        await control.body?.cancel()
        if (!rejected) error = control.ok ? 'unsupported' : 'unavailable'
      }
    }
  } catch {
    error = 'unavailable'
  }
  if (error && !(error === 'unsupported' && input.allowUnverified === true)) {
    return { ok: false, error }
  }
  // No row, account number, or encrypted credential is written until this point.
  return { ok: true, provider: connectProvider(input) }
}
