/** Account-specific catalog and endpoint regression checks; no external HTTP. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import * as repo from '../src/main/db/repo'
import { closeDb, getDb } from '../src/main/db/database'
import { listModelCatalog, listModels, modelCost } from '../src/main/services/models'
import { openaiEndpoint, openAiReasoning, streamChat } from '../src/main/services/llm'
import { isResponsesOnly } from '../src/main/services/responses'
import { accountIdentity } from '../src/main/services/copilot'
import { CODEX_PROVIDER_ID } from '../src/shared/cliproxy'
import { SEED_PROVIDERS } from '../src/shared/providers'
import { connectVerifiedProvider } from '../src/main/services/provider-connect'

const root = mkdtempSync(join(tmpdir(), 'roxy-provider-models-'))
app.setPath('userData', root)
const originalFetch = globalThis.fetch

void app
  .whenReady()
  .then(async () => {
    try {
      // Verify every API-key seed using only mocked, read-only HTTP.
      for (const seed of SEED_PROVIDERS.filter((p) => p.auth === 'api-key')) {
        let requests = 0
        globalThis.fetch = async (url, options) => {
          requests++
          assert.equal(options?.method ?? 'GET', 'GET')
          assert.equal(options?.body, undefined, 'verification never sends a paid prompt')
          assert.equal(options?.redirect, 'error', 'credentials never follow redirects')
          assert.ok(options?.signal)
          const headers = new Headers(options?.headers)
          const token = headers.get(
            seed.wire === 'google'
              ? 'x-goog-api-key'
              : seed.wire === 'anthropic'
                ? 'x-api-key'
                : 'Authorization'
          )
          if (requests === 2) return new Response('', { status: 401 })
          assert.equal(
            token,
            seed.wire === 'google' || seed.wire === 'anthropic' ? 'test-key' : 'Bearer test-key'
          )
          if (seed.id === 'roxy') assert.equal(String(url), 'https://roxy.gg/v1/models')
          if (seed.id === 'openrouter')
            assert.equal(String(url), 'https://openrouter.ai/api/v1/key')
          if (seed.id === 'anthropic') {
            assert.equal(String(url), 'https://api.anthropic.com/v1/models')
            assert.equal(headers.get('anthropic-version'), '2023-06-01')
          }
          if (seed.id === 'google')
            assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1beta/models')
          return Response.json(
            seed.id === 'openrouter'
              ? { data: { label: 'test' } }
              : seed.wire === 'google'
                ? { models: [] }
                : { data: [] }
          )
        }
        const result = await connectVerifiedProvider({
          id: seed.id,
          apiKey: ' test-key ',
          ...(!seed.baseURL && seed.wire !== 'google' ? { baseURL: 'https://custom.test/v1' } : {})
        })
        assert.equal(result.ok, true, seed.id)
        assert.equal(requests, 2, `${seed.id}: verifies catalog is not public`)
        if (result.ok) assert.equal(repo.getProviderToken(result.provider.id), 'test-key')
      }
      const saved = repo.listConnectedProviders().find((p) => p.seedId === 'roxy')!
      const before = repo.listConnectedProviders()
      for (const [status, error] of [
        [401, 'invalidKey'],
        [403, 'forbidden'],
        [429, 'rateLimited'],
        [503, 'unavailable'],
        [404, 'unsupported']
      ] as const) {
        globalThis.fetch = async () => new Response('secret upstream details', { status })
        for (const connectionId of [undefined, saved.id]) {
          assert.deepEqual(
            await connectVerifiedProvider({ id: 'roxy', apiKey: 'rejected-key', connectionId }),
            { ok: false, error }
          )
          assert.deepEqual(repo.listConnectedProviders(), before)
          assert.equal(
            repo.getProviderToken(saved.id),
            'test-key',
            'failed reconnect keeps old key'
          )
        }
      }
      for (const status of [401, 403, 429, 503]) {
        globalThis.fetch = async () => new Response('', { status })
        assert.equal(
          (await connectVerifiedProvider({ id: 'roxy', apiKey: 'bad-key', allowUnverified: true }))
            .ok,
          false,
          'consent never bypasses authentication or transient failures'
        )
      }
      globalThis.fetch = async () => {
        throw new Error('secret URL and credential')
      }
      assert.deepEqual(await connectVerifiedProvider({ id: 'roxy', apiKey: 'key' }), {
        ok: false,
        error: 'unavailable'
      })
      globalThis.fetch = async () => {
        throw new DOMException('timeout', 'TimeoutError')
      }
      assert.deepEqual(await connectVerifiedProvider({ id: 'roxy', apiKey: 'key' }), {
        ok: false,
        error: 'unavailable'
      })
      globalThis.fetch = async () => Response.json({ data: [] })
      assert.deepEqual(
        await connectVerifiedProvider({
          id: 'openai-compatible',
          apiKey: 'anything',
          baseURL: 'http://localhost:8080/v1'
        }),
        { ok: false, error: 'unsupported' },
        'public catalog cannot verify a key'
      )
      assert.deepEqual(repo.listConnectedProviders(), before)
      const unverified = await connectVerifiedProvider({
        id: 'openai-compatible',
        apiKey: 'anything',
        baseURL: 'http://localhost:8080/v1',
        allowUnverified: true
      })
      assert.equal(unverified.ok, true, 'explicit consent permits unsupported free checks')
      globalThis.fetch = async () =>
        Response.json({ data: { label: 'management', is_management_key: true } })
      assert.deepEqual(await connectVerifiedProvider({ id: 'openrouter', apiKey: 'key' }), {
        ok: false,
        error: 'forbidden'
      })
      globalThis.fetch = async () =>
        Response.json({ error: { details: [{ reason: 'API_KEY_INVALID' }] } }, { status: 400 })
      assert.deepEqual(await connectVerifiedProvider({ id: 'google', apiKey: 'key' }), {
        ok: false,
        error: 'invalidKey'
      })
      for (const body of ['<html>Not an API</html>', JSON.stringify({ error: 'secret' })]) {
        globalThis.fetch = async () => new Response(body)
        assert.deepEqual(await connectVerifiedProvider({ id: 'roxy', apiKey: 'key' }), {
          ok: false,
          error: 'unsupported'
        })
      }
      globalThis.fetch = async () => {
        throw new Error('must not fetch')
      }
      for (const baseURL of [
        'file:///tmp/key',
        'http://remote.test/v1',
        'https://user:pass@api.test',
        'https://api.test?key=secret',
        'not a URL'
      ]) {
        assert.deepEqual(
          await connectVerifiedProvider({ id: 'openai-compatible', apiKey: 'key', baseURL }),
          { ok: false, error: 'invalidEndpoint' }
        )
      }
      for (const apiKey of ['', '  ', 'key\nvalue']) {
        assert.deepEqual(await connectVerifiedProvider({ id: 'roxy', apiKey }), {
          ok: false,
          error: 'invalidKey'
        })
      }
      assert.equal(
        (await connectVerifiedProvider({ id: 'ollama' })).ok,
        true,
        'keyless local endpoints do not verify'
      )
      // Reconnection checks the existing custom endpoint, never a sibling or seed default.
      const custom = repo.connectProvider({
        id: 'openai',
        apiKey: 'old',
        baseURL: 'https://private.test/v1'
      })
      let verificationCalls = 0
      globalThis.fetch = async (url) => {
        assert.equal(String(url), 'https://private.test/v1/models')
        return ++verificationCalls === 1
          ? Response.json({ data: [] })
          : new Response('', { status: 401 })
      }
      const reconnected = await connectVerifiedProvider({
        id: 'openai',
        connectionId: custom.id,
        apiKey: 'new'
      })
      assert.equal(reconnected.ok, true)
      if (reconnected.ok) assert.equal(reconnected.provider.id, custom.id)
      assert.equal(repo.getProviderToken(custom.id), 'new')
      console.log(
        'PROVIDER VERIFICATION OK: all API-key seeds, free requests, rejected keys, reconnect preservation, public catalogs, explicit consent, safe errors'
      )

      const a = repo.connectProvider({ id: 'ollama', baseURL: 'http://local-a.test/v1' })
      const b = repo.connectProvider({ id: 'ollama', baseURL: 'http://local-b.test/v1' })
      assert.notEqual(a.id, b.id)
      globalThis.fetch = async (url) => {
        if (String(url) === 'http://local-a.test/v1/models')
          return Response.json({ data: [{ id: 'model-a' }] })
        if (String(url) === 'http://local-b.test/v1/models')
          return Response.json({ data: [{ id: 'model-b' }] })
        throw new Error(`Unexpected network request: ${url}`)
      }
      const [modelsA, modelsB] = await Promise.all([listModels(a.id), listModels(b.id)])
      assert.equal(modelsA[0]?.id, 'model-a')
      assert.equal(modelsB[0]?.id, 'model-b')
      assert.equal((await openaiEndpoint(a.id)).url, 'http://local-a.test/v1/chat/completions')
      assert.equal((await openaiEndpoint(b.id)).url, 'http://local-b.test/v1/chat/completions')
      repo.disconnectProvider(a.id)
      await assert.rejects(openaiEndpoint(a.id), /not connected/)
      assert.equal((await listModels(b.id))[0]?.id, 'model-b')

      const apiA = repo.connectProvider({
        id: 'openai-compatible',
        apiKey: 'key-a',
        baseURL: 'https://api-a.test/v1'
      })
      const apiB = repo.connectProvider({
        id: 'openai-compatible',
        apiKey: 'key-b',
        baseURL: 'https://api-b.test/v1'
      })
      const [endpointA, endpointB] = await Promise.all([
        openaiEndpoint(apiA.id),
        openaiEndpoint(apiB.id)
      ])
      assert.equal(endpointA.headers.Authorization, 'Bearer key-a')
      assert.equal(endpointB.headers.Authorization, 'Bearer key-b')
      assert.equal(endpointA.url, 'https://api-a.test/v1/chat/completions')
      assert.equal(endpointB.url, 'https://api-b.test/v1/chat/completions')
      repo.renameProvider(apiA.id, 'Work gateway')
      assert.deepEqual(
        await openaiEndpoint(apiA.id),
        endpointA,
        'renaming never changes endpoint or credentials'
      )

      const teamA = repo.connectProvider({ id: 'roxy', apiKey: 'team-a' })
      const teamB = repo.connectProvider({ id: 'roxy', apiKey: 'team-b' })
      globalThis.fetch = async (_url, options) => {
        const token = new Headers(options?.headers).get('Authorization')
        assert.ok(token === 'Bearer team-a' || token === 'Bearer team-b')
        const account = token!.slice(7)
        return Response.json({
          data: [{ id: account, supported_parameters: ['tools'], pricing: { prompt: '0.000001' } }]
        })
      }
      const [catalogA, catalogB] = await Promise.all([listModels(teamA.id), listModels(teamB.id)])
      assert.equal(catalogA[0]?.id, 'team-a')
      assert.equal(catalogB[0]?.id, 'team-b')
      assert.equal(modelCost(teamA.id, 'team-a')?.input, 1)
      assert.equal(modelCost(teamA.id, 'team-b'), undefined)
      repo.connectProvider({ id: 'roxy', connectionId: teamA.id, apiKey: 'expired' })
      let calls = 0
      globalThis.fetch = async (_url, options) => {
        calls++
        assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer expired')
        return new Response('', { status: 401 })
      }
      assert.deepEqual(await listModels(teamA.id), [])
      assert.equal(calls, 1, 'private catalog failure never falls back to public entitlements')
      assert.equal((await listModels(teamB.id))[0]?.id, 'team-b', 'sibling catalog stays cached')

      for (const status of [401, 403, 500, 503]) {
        globalThis.fetch = async () => new Response('secret upstream details', { status })
        assert.deepEqual(await listModelCatalog(teamA.id), {
          models: [],
          error: status === 401 || status === 403 ? 'authentication' : 'unavailable'
        })
        assert.deepEqual(await listModels(teamA.id), [], 'main callers remain best effort')
        assert.equal((await listModelCatalog(teamB.id)).models[0]?.id, 'team-b')
      }
      globalThis.fetch = async () => {
        throw new Error('secret bearer credential')
      }
      assert.deepEqual(await listModelCatalog(teamA.id), { models: [], error: 'unavailable' })
      assert.deepEqual(await listModels(teamA.id), [])
      assert.deepEqual(await listModelCatalog(b.id), { models: [], error: 'unavailable' })
      assert.deepEqual(await listModelCatalog('openai'), { models: [], error: 'unavailable' })
      globalThis.fetch = async () => new Response('not json')
      assert.deepEqual(await listModelCatalog(teamA.id), { models: [], error: 'unavailable' })
      globalThis.fetch = async () => Response.json({ error: 'secret upstream details' })
      assert.deepEqual(await listModelCatalog(teamA.id), { models: [], error: 'unavailable' })
      globalThis.fetch = async () => Response.json({ data: [] })
      assert.deepEqual(await listModelCatalog(teamA.id), { models: [] }, 'empty is not failure')
      repo.connectProvider({ id: 'roxy', connectionId: teamA.id, apiKey: 'recovered' })
      globalThis.fetch = async () => Response.json({ data: [{ id: 'recovered' }] })
      const recovered = await listModelCatalog(teamA.id)
      assert.equal(recovered.models[0]?.id, 'recovered')
      assert.equal(recovered.error, undefined, 'success clears the prior failure')

      // Exercise prepareConnection failures without downloading or launching a sidecar.
      assert.deepEqual(await listModelCatalog(CODEX_PROVIDER_ID), {
        models: [],
        error: 'unavailable'
      })
      assert.deepEqual(await listModels(CODEX_PROVIDER_ID), [])
      const subscription = repo.storeCliProxyProvider(
        CODEX_PROVIDER_ID,
        'http://127.0.0.1:1/v1',
        'private-sidecar-key'
      )
      getDb().prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(subscription.id)
      assert.deepEqual(await listModelCatalog(subscription.id), {
        models: [],
        error: 'unavailable'
      })
      assert.deepEqual(await listModels(subscription.id), [])

      assert.deepEqual(openAiReasoning(teamB.id, true, 'xhigh'), { reasoning_effort: 'xhigh' })
      globalThis.fetch = async (url, options) => {
        assert.equal(String(url), 'https://api.github.com/user')
        assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer github-a')
        return Response.json({ id: 42, login: 'account-a' })
      }
      assert.equal(await accountIdentity('github-a'), '42:account-a')
      globalThis.fetch = async () => Response.json({ login: 'missing-id' })
      await assert.rejects(accountIdentity('github-a'), /invalid account identity/)
      const copilot = repo.storeCopilotCredential({ accessToken: 'before-reconnect' })
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/copilot_internal/v2/token')) {
          return Response.json({ token: 'old-session', expires_at: Date.now() / 1000 + 3600 })
        }
        assert.ok(
          String(url).endsWith('/chat/completions'),
          'must not replay through Responses after reconnect'
        )
        repo.storeCopilotCredential({ accessToken: 'after-reconnect' }, copilot.id)
        return new Response('unsupported_api_for_model', { status: 400 })
      }
      await assert.rejects(
        streamChat({
          providerId: copilot.id,
          model: 'account-change-fallback',
          messages: [{ role: 'user', content: 'hello' }],
          signal: new AbortController().signal,
          onDelta: () => undefined
        }),
        /account changed/
      )
      assert.equal(isResponsesOnly(copilot.id, 'account-change-fallback'), false)
      console.log(
        'PROVIDER MODELS OK: independent local endpoints, private catalogs, credentials, and pricing'
      )
    } finally {
      globalThis.fetch = originalFetch
      closeDb()
      rmSync(root, { recursive: true, force: true })
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    }
  )
