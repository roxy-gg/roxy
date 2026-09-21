/** Real credential persistence + mocked HTTP. Never uses a real GitHub account. */
import assert from 'node:assert/strict'
import * as repo from '../src/main/db/repo'
import { closeDb, getDb } from '../src/main/db/database'
import { encryptSecret } from '../src/main/services/secure'
import { pollForToken } from '../src/main/services/copilot'
import { invalidateCopilotModels, listModels } from '../src/main/services/models'
import {
  copilotEndpoint,
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
  // Keep the original singleton regression suite on an explicit migrated-row
  // fixture. Production sign-ins now allocate independent UUID connections.
  const saveLegacy = (credential: repo.CopilotCredential): void => {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO providers
      (id, seed_id, account_number, name, wire, auth, enabled, sort_order, created_at)
      VALUES ('github-copilot', 'github-copilot', 1, 'GitHub Copilot', 'openai-chat', 'oauth', 1, 0, 0)`
      )
      .run()
    getDb()
      .prepare(
        `INSERT INTO provider_account_counters(seed_id, last_number)
      VALUES ('github-copilot', 1) ON CONFLICT(seed_id) DO UPDATE SET
      last_number = MAX(last_number, 1)`
      )
      .run()
    repo.storeCopilotCredential(credential, 'github-copilot')
  }
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
    saveLegacy(credential)
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
    saveLegacy(credential)
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
    saveLegacy({ accessToken: 'other-account' })
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
      else saveLegacy({ accessToken: 'new-account' })
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
    saveLegacy({ accessToken: 'new-account' })
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
    saveLegacy({ accessToken: 'github-test' })
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
    saveLegacy({ accessToken: 'new-account' })
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
    await testIndependentAccounts()
    console.log('  Copilot auth: persistence, renewal, expiry, failures, and concurrency passed')
  } finally {
    globalThis.fetch = originalFetch
    Date.now = originalNow
    invalidateCopilotToken()
    invalidateCopilotModels()
    repo.disconnectProvider('github-copilot')
  }
}

/** UUID connections must never share tokens, recovery state, or tenant catalogs. */
async function testIndependentAccounts(): Promise<void> {
  const originalFetch = globalThis.fetch
  const a = repo.storeCopilotCredential({ accessToken: 'multi-a' })
  const b = repo.storeCopilotCredential({ accessToken: 'multi-b' })
  const accounts = [a, b]
  const exchanges = { a: 0, b: 0 }
  const catalogs = { a: 0, b: 0 }
  const denied = new Set<string>()
  const endpoint = (id: string) => copilotEndpoint('/chat/completions', false, id)
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const auth = new Headers(init?.headers).get('authorization')
    if (url === 'https://api.github.com/copilot_internal/v2/token') {
      assert.ok(auth === 'token multi-a' || auth === 'token multi-b')
      const account = auth === 'token multi-a' ? 'a' : 'b'
      exchanges[account]++
      if (denied.has(account)) return new Response('', { status: 401 })
      return Response.json({
        token: `ide-${account}`,
        expires_at: Date.now() / 1000 + 3600,
        endpoints: {
          api: `https://api.${account === 'a' ? 'business' : 'enterprise'}.githubcopilot.com/`
        }
      })
    }
    assert.ok(
      url === 'https://api.business.githubcopilot.com/models' ||
        url === 'https://api.enterprise.githubcopilot.com/models',
      'multi-account tests make no unexpected network calls'
    )
    const account = url.includes('business') ? 'a' : 'b'
    assert.equal(auth, `Bearer ide-${account}`, 'tenant request uses its own account token')
    catalogs[account]++
    return Response.json({
      data: [{ id: `model-${account}`, model_picker_enabled: true, capabilities: { type: 'chat' } }]
    })
  }
  try {
    assert.notEqual(a.id, b.id)
    assert.notEqual(a.id, 'github-copilot')
    assert.notEqual(b.id, 'github-copilot')
    assert.equal(a.seedId, 'github-copilot')
    assert.equal(b.seedId, 'github-copilot')
    assert.ok(b.accountNumber > a.accountNumber)
    assert.equal(repo.getCopilotCredential(a.id)?.accessToken, 'multi-a')
    assert.equal(repo.getCopilotCredential(b.id)?.accessToken, 'multi-b')
    assert.notEqual(repo.getCopilotSessionKey(a.id), repo.getCopilotSessionKey(b.id))

    const [endpointA, endpointB, modelsA, modelsB] = await Promise.all([
      endpoint(a.id),
      endpoint(b.id),
      listModels(a.id),
      listModels(b.id)
    ])
    assert.equal(endpointA.url, 'https://api.business.githubcopilot.com/chat/completions')
    assert.equal(endpointB.url, 'https://api.enterprise.githubcopilot.com/chat/completions')
    assert.equal(endpointA.headers.Authorization, 'Bearer ide-a')
    assert.equal(endpointB.headers.Authorization, 'Bearer ide-b')
    assert.equal(modelsA[0]?.id, 'model-a')
    assert.equal(modelsB[0]?.id, 'model-b')
    assert.deepEqual(exchanges, { a: 1, b: 1 }, 'single-flight is scoped to each connection')
    assert.deepEqual(catalogs, { a: 1, b: 1 })
    assert.equal(await listModels(a.id), modelsA)
    assert.equal(await listModels(b.id), modelsB)
    invalidateCopilotModels(a.id)
    invalidateCopilotToken(undefined, a.id)
    await listModels(a.id)
    assert.equal(await listModels(b.id), modelsB, 'invalidating A preserves B catalog identity')
    assert.deepEqual(exchanges, { a: 2, b: 1 })
    assert.deepEqual(catalogs, { a: 2, b: 1 })

    for (const [failed, healthy, label] of [
      [a, b, 'a'],
      [b, a, 'b']
    ] as const) {
      denied.add(label)
      invalidateCopilotToken(undefined, failed.id)
      await assert.rejects(
        endpoint(failed.id),
        (error: unknown) => error instanceof ModelHttpError && error.status === 401
      )
      assert.equal(copilotNeedsReauthentication(failed.id), true)
      assert.equal(copilotNeedsReauthentication(healthy.id), false)
      assert.ok((await endpoint(healthy.id)).headers.Authorization)
      const previousSession = repo.getCopilotSessionKey(failed.id)
      const reconnected = repo.storeCopilotCredential({ accessToken: `multi-${label}` }, failed.id)
      assert.equal(reconnected.id, failed.id, 'explicit reconnect preserves connection identity')
      assert.equal(reconnected.accountNumber, failed.accountNumber)
      assert.notEqual(repo.getCopilotSessionKey(failed.id), previousSession)
      assert.equal(copilotNeedsReauthentication(failed.id), false)
      denied.delete(label)
      await endpoint(failed.id)
    }

    let sends = 0
    let sent!: () => void
    const firstSend = new Promise<void>((resolve) => {
      sent = resolve
    })
    const retry = withCopilotRetry(
      true,
      async (record) => {
        record((await endpoint(a.id)).headers.Authorization)
        sends++
        sent()
        return new Response('', { status: 401 })
      },
      undefined,
      a.id
    )
    const rejectedRetry = assert.rejects(
      retry,
      (error: unknown) => error instanceof ModelHttpError && error.status === 409
    )
    await firstSend
    await new Promise((resolve) => setImmediate(resolve))
    repo.storeCopilotCredential({ accessToken: 'multi-a' }, a.id)
    await rejectedRetry
    assert.equal(sends, 1, 'reconnect during retry fails closed without sending under a new login')
    assert.equal(copilotNeedsReauthentication(a.id), false)
    assert.equal(copilotNeedsReauthentication(b.id), false)

    const cachedB = await listModels(b.id)
    const beforeDisconnect = { ...exchanges }
    repo.disconnectProvider(a.id)
    await assert.rejects(endpoint(a.id), /not linked/)
    assert.deepEqual(await listModels(a.id), [])
    assert.equal(repo.getCopilotCredential(a.id), null)
    assert.equal(repo.getCopilotCredential(b.id)?.accessToken, 'multi-b')
    assert.equal((await endpoint(b.id)).headers.Authorization, 'Bearer ide-b')
    assert.equal(await listModels(b.id), cachedB, 'disconnect A leaves B cached catalog untouched')
    assert.deepEqual(exchanges, beforeDisconnect, 'disconnect never falls back to another account')
  } finally {
    globalThis.fetch = originalFetch
    for (const account of accounts) {
      invalidateCopilotToken(undefined, account.id)
      invalidateCopilotModels(account.id)
      repo.disconnectProvider(account.id)
    }
  }
}
