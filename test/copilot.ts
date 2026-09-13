/** Real credential persistence + mocked HTTP. Never uses a real GitHub account. */
import assert from 'node:assert/strict'
import * as repo from '../src/main/db/repo'
import { closeDb, getDb } from '../src/main/db/database'
import { encryptSecret } from '../src/main/services/secure'
import { pollForToken } from '../src/main/services/copilot'
import { invalidateCopilotModels, listModels } from '../src/main/services/models'
import {
  copilotNeedsReauthentication,
  invalidateCopilotToken,
  ModelHttpError,
  openaiEndpoint,
  withCopilotRetry
} from '../src/main/services/llm'

export async function testCopilot(): Promise<void> {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  const endpoint = (): ReturnType<typeof openaiEndpoint> => openaiEndpoint('github-copilot')
  const ide = (token = 'ide-test', lifetime = 1800, refreshIn = 900, skew = 0): Response =>
    Response.json(
      {
        token,
        expires_at: (now + skew) / 1000 + lifetime,
        refresh_in: refreshIn,
        endpoints: { api: 'https://api.business.githubcopilot.com/' }
      },
      { headers: { date: new Date(now + skew).toUTCString() } }
    )
  let exchangeCount = 0
  let refreshCount = 0
  let modelCount = 0
  const catalog = (): Response =>
    Response.json({
      data: [{ id: 'tenant-model', model_picker_enabled: true, capabilities: { type: 'chat' } }]
    })
  let models: (headers: Headers) => Response | Promise<Response> = catalog
  let exchange: (headers: Headers) => Response | Promise<Response> = () => ide()
  let oauth: (body: Record<string, unknown>) => Response | Promise<Response> = () => {
    throw new Error('Unexpected OAuth request')
  }
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === 'https://api.github.com/copilot_internal/v2/token') {
      exchangeCount++
      return exchange(new Headers(init?.headers))
    }
    if (url === 'https://api.business.githubcopilot.com/models') {
      modelCount++
      return models(new Headers(init?.headers))
    }
    assert.equal(url, 'https://github.com/login/oauth/access_token', 'no unexpected network access')
    const body = JSON.parse(String(init?.body))
    if (body.grant_type === 'refresh_token') refreshCount++
    return oauth(body)
  }
  const reset = (credential: repo.CopilotCredential = { accessToken: 'github-test' }): void => {
    repo.storeCopilotCredential(credential)
    invalidateCopilotToken()
    invalidateCopilotModels()
    exchangeCount = refreshCount = modelCount = 0
    models = catalog
    exchange = () => ide()
    oauth = () => {
      throw new Error('Unexpected OAuth request')
    }
  }
  const httpError =
    (status: number) =>
    (error: unknown): boolean =>
      error instanceof ModelHttpError && error.status === status
  try {
    // The device response must retain both expiries and the rotating refresh token.
    oauth = (body) => {
      assert.equal(body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code')
      return Response.json({
        access_token: 'github-device',
        refresh_token: 'refresh-device',
        expires_in: 28800,
        refresh_token_expires_in: 15897600
      })
    }
    const credential = await pollForToken('test-device', 1)
    assert.deepEqual(credential, {
      accessToken: 'github-device',
      refreshToken: 'refresh-device',
      expiresAt: now + 28800_000,
      refreshTokenExpiresAt: now + 15897600_000
    })
    repo.storeCopilotCredential(credential)
    const saved = repo.getCopilotCredential()!
    assert.equal(typeof saved.sessionId, 'string')
    assert.deepEqual(saved, { ...credential, sessionId: saved.sessionId })
    closeDb()
    assert.deepEqual(
      repo.getCopilotCredential(),
      saved,
      'refresh secrets survive reopening the database'
    )
    assert.equal(
      repo.getProviderToken('github-copilot'),
      credential.accessToken,
      'generic getter never returns refresh secrets'
    )

    const corrupt = encryptSecret('{SECRET-invalid-json')
    getDb()
      .prepare('UPDATE credentials SET data = ?, encrypted = ? WHERE provider_id = ?')
      .run(corrupt.data, Number(corrupt.encrypted), 'github-copilot')
    assert.throws(
      () => repo.getCopilotCredential(),
      (error: unknown) =>
        /credential is invalid/.test(String(error)) && !String(error).includes('SECRET')
    )

    // Shipped credentials are encrypted bare strings, not JSON.
    const legacy = encryptSecret('legacy-github')
    getDb()
      .prepare('UPDATE credentials SET data = ?, encrypted = ? WHERE provider_id = ?')
      .run(legacy.data, Number(legacy.encrypted), 'github-copilot')
    assert.deepEqual(repo.getCopilotCredential(), { accessToken: 'legacy-github' })
    exchange = (headers) => {
      assert.equal(headers.get('authorization'), 'token legacy-github')
      return ide()
    }
    await endpoint()

    reset()
    await Promise.all(Array.from({ length: 20 }, endpoint))
    assert.equal(exchangeCount, 1, 'concurrent requests share the exchange')
    await endpoint()
    assert.equal(exchangeCount, 1, 'valid IDE token is cached')
    now += 901_000
    await endpoint()
    assert.equal(exchangeCount, 2, 'refresh_in triggers renewal before expires_at')

    reset()
    exchange = () => ide('skewed', 1800, 900, -3600_000)
    await endpoint()
    await endpoint()
    assert.equal(exchangeCount, 1, 'server Date handles a clock one hour ahead')

    reset({ accessToken: 'github-expired', refreshToken: 'refresh-old', expiresAt: now - 1 })
    oauth = (body) => {
      assert.equal(body.refresh_token, 'refresh-old')
      assert.equal(body.client_id, 'Iv1.b507a08c87ecfe98')
      assert.equal(body.client_secret, undefined)
      return Response.json({
        access_token: 'github-new',
        refresh_token: 'refresh-new',
        expires_in: 28800,
        refresh_token_expires_in: 15897600
      })
    }
    exchange = (headers) => {
      assert.equal(headers.get('authorization'), 'token github-new')
      return ide()
    }
    await Promise.all(Array.from({ length: 20 }, endpoint))
    assert.equal(refreshCount, 1, 'rotating refresh token is only spent once')
    assert.equal(exchangeCount, 1)
    closeDb()
    assert.equal(repo.getCopilotCredential()?.refreshToken, 'refresh-new', 'rotation is persisted')

    reset({ accessToken: 'expiring', refreshToken: 'rotating', expiresAt: now - 1 })
    oauth = () =>
      Response.json({ access_token: 'rotated', refresh_token: 'next-refresh', expires_in: 28800 })
    let finishRotated!: (response: Response) => void
    exchange = () =>
      new Promise((resolve) => {
        finishRotated = resolve
      })
    const duringRotation = endpoint()
    while (!finishRotated) await new Promise((resolve) => setImmediate(resolve))
    const afterRotation = endpoint()
    assert.equal(exchangeCount, 1, 'caller after OAuth rotation joins the pending IDE exchange')
    finishRotated(ide())
    await Promise.all([duringRotation, afterRotation])
    assert.equal(refreshCount, 1)

    reset({ accessToken: 'github-rejected', refreshToken: 'refresh-rejected' })
    oauth = () =>
      Response.json({ access_token: 'github-recovered', refresh_token: 'refresh-recovered' })
    exchange = (headers) =>
      headers.get('authorization') === 'token github-rejected'
        ? new Response('', { status: 401 })
        : ide('recovered')
    assert.equal((await endpoint()).headers.Authorization, 'Bearer recovered')
    assert.equal(refreshCount, 1, 'exchange 401 renews upstream OAuth before asking for sign-in')
    assert.equal(exchangeCount, 2)

    reset({ accessToken: 'github-expired', refreshToken: 'refresh-old', expiresAt: now - 1 })
    oauth = () => new Response('temporary failure', { status: 503 })
    await assert.rejects(endpoint(), httpError(503))
    assert.equal(
      repo.getCopilotCredential()?.refreshToken,
      'refresh-old',
      'temporary failure does not delete credentials'
    )
    oauth = () => Response.json({ access_token: 'github-retry', refresh_token: 'refresh-retry' })
    await endpoint()
    assert.equal(refreshCount, 2, 'failed single-flight is released for retry')

    reset({ accessToken: 'github-expired', refreshToken: 'refresh-revoked', expiresAt: now - 1 })
    oauth = () =>
      Response.json({ error: 'bad_refresh_token', error_description: 'DO NOT DISPLAY THIS SECRET' })
    await assert.rejects(
      endpoint(),
      (error: unknown) =>
        httpError(401)(error) &&
        /Reconnect/.test(String(error)) &&
        !String(error).includes('SECRET')
    )
    assert.equal(exchangeCount, 0)

    oauth = () => new Response('{SECRET-invalid-json')
    await assert.rejects(
      endpoint(),
      (error: unknown) => httpError(502)(error) && !String(error).includes('SECRET')
    )

    reset()
    exchange = () => new Response('', { status: 401 })
    await assert.rejects(endpoint(), httpError(401))
    assert.equal(
      refreshCount,
      0,
      'legacy credentials without refresh tokens require reconnect only if rejected'
    )
    exchange = () => new Response('', { status: 403 })
    await assert.rejects(
      endpoint(),
      (error: unknown) => httpError(403)(error) && !/reconnect/i.test(String(error))
    )
    exchange = () => Response.json({ expires_at: now / 1000 + 1800 })
    await assert.rejects(endpoint(), httpError(502))
    exchange = () => new Response('{SECRET-invalid-json')
    await assert.rejects(
      endpoint(),
      (error: unknown) => httpError(502)(error) && !String(error).includes('SECRET')
    )
    exchange = () => Response.json(null)
    await assert.rejects(endpoint(), httpError(502))
    exchange = () => ide('valid')
    await endpoint()

    // Account switching and disconnect must be respected even while a token is cached.
    repo.storeCopilotCredential({ accessToken: 'other-account' })
    exchange = (headers) => {
      assert.equal(headers.get('authorization'), 'token other-account')
      return ide('other-ide')
    }
    assert.equal((await endpoint()).headers.Authorization, 'Bearer other-ide')
    repo.disconnectProvider('github-copilot')
    await assert.rejects(endpoint(), /not linked/)

    // A late refresh must not resurrect a disconnected credential or replace a new account.
    for (const disconnect of [true, false]) {
      reset({ accessToken: 'old-account', refreshToken: 'old-refresh', expiresAt: now - 1 })
      let finish!: (response: Response) => void
      oauth = () =>
        new Promise((resolve) => {
          finish = resolve
        })
      const request = endpoint()
      const rejected = assert.rejects(request, httpError(409))
      if (disconnect) repo.disconnectProvider('github-copilot')
      else repo.storeCopilotCredential({ accessToken: 'new-account' })
      finish(Response.json({ access_token: 'late-token', refresh_token: 'late-refresh' }))
      await rejected
      assert.equal(repo.getProviderToken('github-copilot'), disconnect ? null : 'new-account')
    }

    reset()
    let finishExchange!: (response: Response) => void
    exchange = () =>
      new Promise((resolve) => {
        finishExchange = resolve
      })
    const staleExchange = assert.rejects(endpoint(), httpError(409))
    repo.storeCopilotCredential({ accessToken: 'new-account' })
    exchange = () => ide('new-account-ide')
    await endpoint()
    finishExchange(ide('old-account-ide'))
    await staleExchange
    assert.equal((await endpoint()).headers.Authorization, 'Bearer new-account-ide')

    // A delayed 401 for token A must not discard token B installed by another session.
    reset()
    exchange = () => ide(`ide-${exchangeCount}`)
    let finishOld!: (response: Response) => void
    let requestCount = 0
    const delayed = withCopilotRetry(true, async (record) => {
      const { headers } = await endpoint()
      record(headers.Authorization)
      requestCount++
      return requestCount === 1
        ? new Promise((resolve) => {
            finishOld = resolve
          })
        : new Response('ok')
    })
    // Wait for the first send to reach its HTTP response, without wall-clock delays.
    while (!finishOld) await new Promise((resolve) => setImmediate(resolve))
    invalidateCopilotToken()
    await endpoint()
    finishOld(new Response('', { status: 401 }))
    assert.equal((await delayed).status, 200)
    assert.equal(exchangeCount, 2, 'late 401 reuses the newer token')

    reset()
    exchange = () => ide(`ide-${exchangeCount}`)
    let sends = 0
    const recovered = await withCopilotRetry(true, async (record) => {
      const { headers } = await endpoint()
      record(headers.Authorization)
      return new Response('', { status: ++sends === 1 ? 401 : 200 })
    })
    assert.equal(recovered.status, 200)
    assert.equal(exchangeCount, 2, 'IDE 401 silently exchanges and retries')
    assert.equal(refreshCount, 0, 'IDE expiry is not a new GitHub login')

    reset({ accessToken: 'catalog-expired', refreshToken: 'catalog-refresh', expiresAt: now - 1 })
    oauth = () =>
      Response.json({
        access_token: 'catalog-renewed',
        refresh_token: 'catalog-next',
        expires_in: 28800
      })
    const [discovered, concurrent] = await Promise.all([
      listModels('github-copilot'),
      listModels('github-copilot')
    ])
    assert.equal(
      discovered[0]?.id,
      'tenant-model',
      'OAuth rotation must not empty the model picker'
    )
    assert.equal(discovered, concurrent)
    assert.equal(await listModels('github-copilot'), discovered, 'renewed catalog stays cached')
    assert.equal(refreshCount, 1)
    assert.equal(modelCount, 1)
    const sessionKey = repo.getCopilotSessionKey()
    closeDb()
    assert.equal(repo.getCopilotSessionKey(), sessionKey, 'login identity survives restart')
    assert.equal((await endpoint()).url, 'https://api.business.githubcopilot.com/chat/completions')
    assert.equal(
      (await openaiEndpoint('github-copilot', { responses: true })).url,
      'https://api.business.githubcopilot.com/responses'
    )

    // Discovery may still be in flight when inference renews the same account.
    reset({
      accessToken: 'catalog-valid',
      refreshToken: 'catalog-refresh',
      expiresAt: now + 120_000
    })
    let finishModels!: (response: Response) => void
    models = () =>
      new Promise((resolve) => {
        finishModels = resolve
      })
    const duringDiscovery = listModels('github-copilot')
    while (!finishModels) await new Promise((resolve) => setImmediate(resolve))
    now += 901_000
    oauth = () => Response.json({ access_token: 'catalog-rotated', refresh_token: 'catalog-next' })
    await endpoint()
    finishModels(catalog())
    assert.equal(
      (await duringDiscovery)[0]?.id,
      'tenant-model',
      'inference rotation is not an account switch'
    )

    // The discovery retry must identify its rejected token, just like inference.
    reset()
    exchange = () => ide(`ide-${exchangeCount}`)
    finishModels = undefined!
    models = () =>
      modelCount === 1
        ? new Promise((resolve) => {
            finishModels = resolve
          })
        : catalog()
    const lateDiscovery = listModels('github-copilot')
    while (!finishModels) await new Promise((resolve) => setImmediate(resolve))
    invalidateCopilotToken()
    await endpoint()
    finishModels(new Response('', { status: 401 }))
    assert.equal((await lateDiscovery)[0]?.id, 'tenant-model')
    assert.equal(exchangeCount, 2, 'a late discovery 401 preserves the new IDE token')
    assert.equal(copilotNeedsReauthentication(), false, 'silent recovery needs no reconnect action')

    // Recovery is retained even when discovery turns the auth error into an empty catalog.
    reset({
      accessToken: 'expired-access',
      refreshToken: 'expired-refresh',
      expiresAt: now - 1,
      refreshTokenExpiresAt: now - 1
    })
    closeDb()
    assert.deepEqual(await listModels('github-copilot'), [])
    assert.equal(
      copilotNeedsReauthentication(),
      true,
      'expired refresh token after restart offers reconnect'
    )
    assert.equal(refreshCount, 0, 'known expired refresh token is not sent')
    assert.equal(exchangeCount, 0)

    for (const error of ['bad_refresh_token', 'expired_token', 'invalid_grant']) {
      for (const status of [200, 400]) {
        reset({
          accessToken: 'revoked-access',
          refreshToken: 'revoked-refresh',
          expiresAt: now - 1
        })
        oauth = () => Response.json({ error, error_description: 'SECRET' }, { status })
        assert.deepEqual(await listModels('github-copilot'), [])
        assert.equal(copilotNeedsReauthentication(), true, `${error} (${status}) offers reconnect`)
      }
    }
    reset({ accessToken: 'revoked-access', refreshToken: 'revoked-refresh' })
    exchange = () => new Response('', { status: 401 })
    oauth = () => new Response('', { status: 401 })
    await assert.rejects(endpoint(), httpError(401))
    assert.equal(
      copilotNeedsReauthentication(),
      true,
      'revocation without expiry metadata offers reconnect'
    )

    reset()
    exchange = () => new Response('', { status: 401 })
    await assert.rejects(endpoint(), httpError(401))
    assert.equal(
      copilotNeedsReauthentication(),
      true,
      'revoked legacy authorization offers reconnect'
    )
    repo.storeCopilotCredential({ accessToken: 'github-test' })
    assert.equal(
      copilotNeedsReauthentication(),
      false,
      'reconnecting even the same account clears recovery'
    )
    repo.disconnectProvider('github-copilot')
    assert.equal(copilotNeedsReauthentication(), false, 'disconnect hides recovery')

    for (const status of [403, 429, 502, 503]) {
      reset()
      exchange = () => new Response('', { status })
      await assert.rejects(endpoint(), httpError(status))
      assert.equal(
        copilotNeedsReauthentication(),
        false,
        `exchange ${status} does not ask for sign-in`
      )
      reset({ accessToken: 'expired', refreshToken: 'valid-refresh', expiresAt: now - 1 })
      oauth = () => new Response('', { status })
      await assert.rejects(endpoint(), httpError(status))
      assert.equal(
        copilotNeedsReauthentication(),
        false,
        `refresh ${status} does not ask for sign-in`
      )
    }

    reset()
    const rejected = await withCopilotRetry(true, async (record) => {
      record((await endpoint()).headers.Authorization)
      return new Response('', { status: 401 })
    })
    assert.equal(rejected.status, 401)
    assert.equal(exchangeCount, 4, 'reauthentication is offered only after automatic retries')
    assert.equal(copilotNeedsReauthentication(), true)
    await withCopilotRetry(true, async (record) => {
      record((await endpoint()).headers.Authorization)
      return new Response('ok')
    })
    assert.equal(copilotNeedsReauthentication(), false, 'successful request clears recovery')

    reset()
    let rejectOld!: (response: Response) => void
    exchange = () =>
      new Promise((resolve) => {
        rejectOld = resolve
      })
    const rejectedAccount = assert.rejects(endpoint(), httpError(401))
    repo.storeCopilotCredential({ accessToken: 'new-account' })
    rejectOld(new Response('', { status: 401 }))
    await rejectedAccount
    assert.equal(
      copilotNeedsReauthentication(),
      false,
      'late failure cannot ask a new account to reconnect'
    )

    reset()
    const aborted = new AbortController()
    await withCopilotRetry(
      true,
      async (record) => {
        record((await endpoint()).headers.Authorization)
        aborted.abort()
        return new Response('', { status: 401 })
      },
      aborted.signal
    )
    assert.equal(copilotNeedsReauthentication(), false, 'aborted retries do not request sign-in')
    console.log('  Copilot auth: persistence, renewal, expiry, failures, and concurrency passed')
  } finally {
    globalThis.fetch = originalFetch
    Date.now = originalNow
    invalidateCopilotToken()
    invalidateCopilotModels()
    repo.disconnectProvider('github-copilot')
  }
}
