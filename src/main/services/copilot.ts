/**
 * GitHub Copilot authentication via the OAuth Device Authorization Grant.
 *
 *  1. POST /login/device/code  -> user_code + verification_uri + device_code
 *  2. user enters the code at github.com/login/device and approves
 *  3. poll /login/oauth/access_token -> GitHub access token
 *
 * The GitHub token is stored; the short-lived Copilot token is exchanged from it
 * by llm.ts for model discovery and inference. Uses the public Copilot client id
 * that community tooling uses for the device flow.
 */
import type { DeviceFlowStart } from '../../shared/types'
import type { CopilotCredential } from '../db/repo'
import { ModelHttpError } from './model-http-error'

const CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const USER_AGENT = 'Roxy'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface GitHubTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  error?: string
  error_description?: string
}

function credentialFromResponse(data: GitHubTokenResponse, startedAt: number): CopilotCredential {
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new ModelHttpError(502, 'GitHub returned an invalid authorization response. Try again.')
  }
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === 'string' && data.refresh_token
      ? { refreshToken: data.refresh_token }
      : {}),
    ...(Number.isFinite(data.expires_in) && data.expires_in! > 0
      ? { expiresAt: startedAt + data.expires_in! * 1000 }
      : {}),
    ...(Number.isFinite(data.refresh_token_expires_in) && data.refresh_token_expires_in! > 0
      ? { refreshTokenExpiresAt: startedAt + data.refresh_token_expires_in! * 1000 }
      : {})
  }
}

/** Device-flow refresh does not require a client secret. GitHub rotates both tokens. */
export async function refreshGitHubCredential(
  credential: CopilotCredential
): Promise<CopilotCredential> {
  if (
    !credential.refreshToken ||
    (credential.refreshTokenExpiresAt !== undefined &&
      credential.refreshTokenExpiresAt <= Date.now())
  ) {
    throw new ModelHttpError(
      401,
      'GitHub authorization can no longer be renewed. Reconnect GitHub Copilot to continue.'
    )
  }
  const startedAt = Date.now()
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken
    }),
    signal: AbortSignal.timeout(30_000)
  })
  // OAuth errors may arrive as HTTP 400 as well as a successful JSON response.
  // Server/rate-limit errors remain retryable regardless of their response body.
  if (!res.ok && ![400, 401, 403].includes(res.status)) {
    await res.body?.cancel().catch(() => undefined)
    throw new ModelHttpError(
      res.status,
      `GitHub authorization refresh failed (${res.status}). Try again.`
    )
  }
  const data = (await res.json().catch(() => {
    if (!res.ok) {
      throw new ModelHttpError(
        res.status,
        `GitHub authorization refresh failed (${res.status}). Try again.`
      )
    }
    throw new ModelHttpError(502, 'GitHub returned an invalid authorization response. Try again.')
  })) as GitHubTokenResponse
  if (data?.error) {
    if (
      data.error === 'bad_refresh_token' ||
      data.error === 'expired_token' ||
      data.error === 'invalid_grant'
    ) {
      throw new ModelHttpError(
        401,
        'GitHub authorization can no longer be renewed. Reconnect GitHub Copilot to continue.'
      )
    }
    // Do not echo OAuth response bodies: they may contain credentials.
    throw new ModelHttpError(
      data.error === 'slow_down' ? 429 : res.ok ? 502 : res.status,
      'GitHub could not refresh authorization. Try again.'
    )
  }
  if (!res.ok) {
    throw new ModelHttpError(
      res.status,
      `GitHub authorization refresh failed (${res.status}). Try again.`
    )
  }
  return { ...credentialFromResponse(data, startedAt), sessionId: credential.sessionId }
}

export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' }),
    signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) {
    throw new Error(`GitHub device code request failed (${res.status})`)
  }
  const data = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in?: number
    interval?: number
  }
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    deviceCode: data.device_code,
    interval: data.interval ?? 5,
    expiresIn: data.expires_in ?? 900
  }
}

/** Poll until authorized, retaining refresh/expiry fields when GitHub supplies them. */
export async function pollForToken(
  deviceCode: string,
  interval: number
): Promise<CopilotCredential> {
  let waitMs = Math.max(1, interval) * 1000
  const deadline = Date.now() + 15 * 60 * 1000

  while (Date.now() < deadline) {
    await sleep(waitMs)
    const startedAt = Date.now()
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok)
      throw new ModelHttpError(
        res.status,
        `GitHub authorization request failed (${res.status}). Try again.`
      )
    const data = (await res.json().catch(() => {
      throw new ModelHttpError(502, 'GitHub returned an invalid authorization response. Try again.')
    })) as GitHubTokenResponse
    if (!data || typeof data !== 'object') {
      throw new ModelHttpError(502, 'GitHub returned an invalid authorization response. Try again.')
    }

    if (data.access_token) return credentialFromResponse(data, startedAt)
    switch (data.error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        waitMs += 5000
        break
      case 'expired_token':
        throw new Error('The code expired before you authorized. Please try again.')
      case 'access_denied':
        throw new Error('Authorization was denied.')
      default:
        if (data.error) throw new Error('GitHub could not authorize this device. Please try again.')
    }
  }
  throw new Error('Timed out waiting for authorization.')
}
