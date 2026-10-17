import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import * as repo from '../src/main/db/repo'
import * as bots from '../src/main/db/bots'
import { closeDb } from '../src/main/db/database'
import { runSessionTurn } from '../src/main/services/session-turn'
import { cancelSubagentRun, listRunningSubagents } from '../src/main/services/subagent-stream'
import { PartsFold, partsToContent } from '../src/shared/parts'
import type { ChatMessage } from '../src/shared/api'

const temp = mkdtempSync(path.join(tmpdir(), 'roxy-subagents-'))
app.setPath('userData', temp)
process.env.ROXY_TRACK_DISABLE = '1'
process.env.ROXY_SKILLS = '0'
process.env.ROXY_MCP = '0'
app.on('window-all-closed', () => undefined)

interface Request {
  model: string
  messages: ChatMessage[]
  tools?: { function: { name: string } }[]
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(content: string | Record<string, unknown>): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: typeof content === 'string' ? { content } : content }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } }
  )
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(predicate(), label)
}

async function main(): Promise<void> {
  const win = new BrowserWindow({ show: false })
  const originalFetch = globalThis.fetch
  let transport: (body: Request, signal?: AbortSignal | null) => Promise<Response>
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes('models.dev'))
      return new Response(
        JSON.stringify({
          openai: {
            models: {
              'parent-model': {
                id: 'parent-model',
                name: 'Parent',
                tool_call: true,
                limit: { context: 128000, output: 4096 }
              },
              'guest-model': {
                id: 'guest-model',
                name: 'Guest',
                tool_call: true,
                limit: { context: 128000, output: 4096 }
              }
            }
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    assert.ok(String(url).includes('subagent-test.invalid'), `Unexpected network: ${url}`)
    return transport(JSON.parse(String(init?.body)), init?.signal)
  }) as typeof fetch
  try {
    const provider = repo.connectProvider({
      id: 'openai',
      apiKey: 'test-only',
      baseURL: 'https://subagent-test.invalid/v1',
      defaultModel: 'parent-model'
    })
    repo.setActiveProvider(provider.id, 'parent-model')
    const guest = bots.createBot('delegate-owner', 'Finish the request using delegated research.')
    repo.setChatConfig(guest.chatId, {
      providerId: provider.id,
      model: 'guest-model',
      agentId: 'build'
    })

    for (const owner of ['host', 'bot'] as const) {
      const chat =
        owner === 'bot'
          ? repo.getChat(guest.chatId)!
          : repo.createChat({ title: 'Batch', workspacePath: temp })
      const children = Array.from({ length: 3 }, () => deferred<Response>())
      const requests: Request[] = []
      const fold = new PartsFold()
      let parentCalls = 0
      transport = async (body, signal) => {
        const child = children.findIndex(
          (_item, i) => body.messages.at(-1)?.content === `child-${owner}-${i}`
        )
        if (child >= 0) {
          requests[child] = body
          if (child === 1)
            return new Promise<Response>((resolve, reject) => {
              if (signal?.aborted) return reject(new Error('cancelled'))
              signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
                once: true
              })
              children[child].promise.then(resolve, reject)
            })
          return children[child].promise
        }
        if (++parentCalls === 1)
          return response({
            tool_calls: [
              {
                index: 0,
                id: `batch-${owner}`,
                type: 'function',
                function: {
                  name: 'task',
                  arguments: JSON.stringify({
                    tasks: children.map((_item, i) => ({
                      description: `Investigation ${i}`,
                      prompt: `child-${owner}-${i}`
                    }))
                  })
                }
              }
            ]
          })
        assert.ok(
          body.messages.some(
            (message) =>
              message.role === 'tool' && String(message.content).includes(`REPORT-${owner}-0`)
          ),
          'parent receives settled results'
        )
        return response(`Parent used batch ${owner}.`)
      }
      const controller = new AbortController()
      const turn = runSessionTurn(
        {
          requestId: `parent-${owner}`,
          sessionId: chat.id,
          providerId: provider.id,
          model: owner === 'bot' ? 'guest-model' : 'parent-model',
          messages: [{ role: 'user', content: 'Investigate three areas.' }]
        },
        (event) => fold.apply(event),
        controller.signal
      )
      await waitFor(() => listRunningSubagents(chat.id).length === 3, `${owner}: children launched`)
      assert.equal(parentCalls, 1, 'the parent waits while all children run')
      assert.ok(
        requests.every((request) => request.tools?.some((tool) => tool.function.name === 'bash')),
        'Explore children have full tools'
      )
      const subchats = repo.listSubchats(chat.id)
      assert.equal(subchats.length, 3)
      const middle = subchats.find((subchat) => subchat.title.endsWith('Investigation 1'))!
      assert.ok(cancelSubagentRun(middle.id), 'a single child can be cancelled')
      children[0].resolve(response(`REPORT-${owner}-0`))
      await waitFor(
        () => listRunningSubagents(chat.id).length === 1,
        `${owner}: first two children settled`
      )
      assert.equal(parentCalls, 1, 'one remaining child still blocks the parent')
      children[2].resolve(response(`REPORT-${owner}-2`))
      const result = await turn
      assert.ok(result.ok, result.error)
      assert.equal(parentCalls, 2, 'the parent resumes exactly once after all children settle')
      assert.equal(listRunningSubagents(chat.id).length, 0)
      const batch = fold.parts.find((part) => part.type === 'tool' && part.tool === 'task')
      assert.ok(batch && batch.type === 'tool')
      assert.equal(batch.children?.length, 3)
      assert.ok(batch.children?.every((part) => part.type === 'tool' && part.state !== 'running'))
      assert.ok(batch.output?.includes(`REPORT-${owner}-0`))
      assert.ok(batch.output?.includes(`REPORT-${owner}-2`))
      assert.ok(batch.output?.includes('cancelled'))
      repo.addMessage({
        chatId: chat.id,
        role: 'assistant',
        content: partsToContent(fold.parts),
        parts: fold.parts
      })
      for (const subchat of subchats) assert.equal(repo.listMessages(subchat.id).length, 2)
      console.log(`  OK ${owner}: mixed outcomes join before parent continues`)
    }

    const chat = repo.createChat({ title: 'Stopped batch', workspacePath: temp })
    const children = Array.from({ length: 2 }, () => deferred<Response>())
    let parentCalls = 0
    transport = async (body, signal) => {
      const child = children.findIndex(
        (_item, i) => body.messages.at(-1)?.content === `stop-child-${i}`
      )
      if (child >= 0)
        return new Promise<Response>((resolve, reject) => {
          if (signal?.aborted) return reject(new Error('stopped'))
          signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
          children[child].promise.then(resolve, reject)
        })
      if (++parentCalls === 1)
        return response({
          tool_calls: [
            {
              index: 0,
              id: 'stop-batch',
              type: 'function',
              function: {
                name: 'task',
                arguments: JSON.stringify({
                  tasks: children.map((_item, i) => ({
                    description: `Stop child ${i}`,
                    prompt: `stop-child-${i}`
                  }))
                })
              }
            }
          ]
        })
      return response('Should not continue')
    }
    const controller = new AbortController()
    const stopped = runSessionTurn(
      {
        requestId: 'stop-parent',
        sessionId: chat.id,
        providerId: provider.id,
        model: 'parent-model',
        messages: [{ role: 'user', content: 'Stop all.' }]
      },
      () => {},
      controller.signal
    )
    await waitFor(() => listRunningSubagents(chat.id).length === 2, 'stop: children launched')
    controller.abort()
    const result = await stopped
    assert.equal(result.ok, false)
    await waitFor(() => listRunningSubagents(chat.id).length === 0, 'stop: children settled')
    assert.equal(parentCalls, 1, 'stopping the parent cannot start another model step')
    console.log('  OK parent stop cancels the whole batch')
    closeDb()
  } finally {
    globalThis.fetch = originalFetch
    win.destroy()
    closeDb()
    await rm(temp, { recursive: true, force: true }).catch(() => {})
  }
  console.log('SUBAGENT RUNTIME OK')
}

app
  .whenReady()
  .then(main)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    }
  )
