/** Account-specific catalog and endpoint regression checks; no external HTTP. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import * as repo from '../src/main/db/repo'
import { closeDb } from '../src/main/db/database'
import { listModels, modelCost } from '../src/main/services/models'
import { openaiEndpoint, openAiReasoning, streamChat } from '../src/main/services/llm'
import { isResponsesOnly } from '../src/main/services/responses'
import { accountIdentity } from '../src/main/services/copilot'

const root = mkdtempSync(join(tmpdir(), 'roxy-provider-models-'))
app.setPath('userData', root)
const originalFetch = globalThis.fetch

void app
  .whenReady()
  .then(async () => {
    try {
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
