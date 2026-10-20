import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import * as repo from '../src/main/db/repo'
import * as bots from '../src/main/db/bots'
import { closeDb } from '../src/main/db/database'
import { runAgentTurn } from '../src/main/harness/agent'
import {
  ENGINEERING_OPERATIONS,
  engineeringName,
  type EngineeringSchema
} from '../src/shared/engineering-tools'
import type { ChatMessage } from '../src/shared/api'
const temp = mkdtempSync(path.join(tmpdir(), 'roxy-engineering-agent-'))
app.setPath('userData', temp)
process.env.ROXY_TRACK_DISABLE = '1'
process.env.ROXY_SKILLS = '0'
process.env.ROXY_MCP = '0'
app.on('window-all-closed', () => undefined)
const native = {
  turn: { schemas: [] as EngineeringSchema[], guidance: undefined as string | undefined },
  executions: [] as { name: string; sessionId: string }[]
}
;(globalThis as unknown as { __nativeTest: typeof native }).__nativeTest = native
const extraMcp: EngineeringSchema[] = []
;(globalThis as unknown as { __nativeMcp: unknown }).__nativeMcp = {
  mcpToolTitle: (name: string) => name,
  loadWorkspaceMcpServers: () => [],
  ensureMcpConnected: async () => {},
  mcpToolSchemas: () => extraMcp,
  mcpInstructions: () => undefined,
  isMcpTool: (name: string) => name.startsWith('mcp__'),
  callMcpTool: async () => ({ ok: true, output: 'mcp test result' }),
  reconnectMcpServer: async () => ({}),
  disposeConnection: async () => {},
  mcpServerSummaries: () => []
}
interface Request {
  messages: ChatMessage[]
  tools?: { function: { name: string } }[]
}
const response = (delta: unknown): Response =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' }
  })
const call = (name: string, input: unknown): Response =>
  response({
    tool_calls: [
      {
        index: 0,
        id: crypto.randomUUID(),
        type: 'function',
        function: { name, arguments: JSON.stringify(input) }
      }
    ]
  })
async function main(): Promise<void> {
  const win = new BrowserWindow({ show: false })
  const originalFetch = globalThis.fetch
  let transport: (body: Request) => Response
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes('models.dev'))
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    assert(String(url).includes('native-test.invalid'))
    return transport(JSON.parse(String(init?.body)))
  }) as typeof fetch
  const schemas: EngineeringSchema[] = ENGINEERING_OPERATIONS.map((operation) => ({
    type: 'function',
    function: {
      name: engineeringName(operation),
      description: operation,
      parameters: { type: 'object', properties: {} }
    }
  }))
  const has = (body: Request, name: string): boolean =>
    !!body.tools?.some((tool) => tool.function.name === name)
  const prompt = (body: Request): string =>
    String(body.messages.find((message) => message.role === 'system')?.content)
  try {
    const provider = repo.connectProvider({
      id: 'openai',
      apiKey: 'test-only',
      baseURL: 'https://native-test.invalid/v1',
      defaultModel: 'test-model'
    })
    repo.setActiveProvider(provider.id, 'test-model')
    const host = repo.createChat({ title: 'Native', workspacePath: temp })
    const bot = bots.createBot('native-owner', 'Investigate the requested target.')
    const turn = async (chatId: string, agentId = 'build'): Promise<void> => {
      await runAgentTurn({
        providerId: provider.id,
        model: 'test-model',
        cwd: temp,
        chatId,
        agentId,
        messages: [{ role: 'user', content: 'Inspect the target.' }],
        signal: new AbortController().signal,
        emit: () => {}
      })
    }
    for (const chatId of [host.id, bot.chatId]) {
      for (const enabled of [false, true])
        for (const guidance of [false, true]) {
          native.turn = {
            schemas: enabled ? schemas : [],
            guidance: guidance
              ? '<reverse-engineering>Native test guidance</reverse-engineering>'
              : undefined
          }
          let count = 0
          transport = (body) => {
            count++
            assert.equal(has(body, 'rea_open_binary'), enabled)
            assert.equal(has(body, 'rea_tools'), enabled)
            assert.equal(prompt(body).includes('Native test guidance'), guidance)
            assert(
              (body.tools?.length ?? 0) <= 128,
              'Native integration respects provider function cap'
            )
            assert(!body.tools?.some((tool) => tool.function.name.startsWith('mcp__rea')))
            return response({ content: 'Verified.' })
          }
          await turn(chatId)
          assert.equal(count, 1)
        }
    }
    native.turn = {
      schemas,
      guidance: '<reverse-engineering>Native test guidance</reverse-engineering>'
    }
    transport = (body) => {
      assert(!body.tools?.some((tool) => tool.function.name.startsWith('rea_')))
      assert(!prompt(body).includes('Native test guidance'))
      return response({ content: 'Plan remains read-only.' })
    }
    await turn(host.id, 'plan')
    // Discovery rotates an enabled call from outside the 128-function window.
    let selected = ''
    let step = 0
    transport = (body) => {
      step++
      assert((body.tools?.length ?? 0) <= 128)
      if (step === 1) {
        selected = schemas.find((schema) => !has(body, schema.function.name))!.function.name
        return call('rea_tools', { operations: [selected] })
      }
      if (step === 2) {
        assert(has(body, selected))
        return call(selected, {})
      }
      assert(
        body.messages.some(
          (message) =>
            message.role === 'tool' && String(message.content).includes('native handler result')
        )
      )
      return response({ content: 'Native call executed.' })
    }
    await turn(host.id)
    assert.equal(native.executions.at(-1)?.name, selected)
    assert.equal(native.executions.at(-1)?.sessionId, host.id)
    // Large connected catalogs must retain a usable native discovery window.
    process.env.ROXY_MCP = '1'
    repo.upsertMcpServer({
      id: 'large-test',
      enabled: true,
      config: { type: 'local', command: ['unused'] }
    })
    for (const count of [126, 127, 128, 160]) {
      extraMcp.splice(
        0,
        extraMcp.length,
        ...Array.from({ length: count }, (_, index) => ({
          type: 'function' as const,
          function: {
            name: `mcp__large__${index}`,
            description: 'test',
            parameters: { type: 'object' }
          }
        }))
      )
      let stage = 0
      transport = (body) => {
        assert((body.tools?.length ?? 0) <= 128)
        assert(has(body, 'rea_tools'))
        if (++stage === 1)
          return call('rea_tools', { operations: [`mcp__large__${count - 1}`, 'rea_open_binary'] })
        assert(has(body, `mcp__large__${count - 1}`))
        assert(has(body, 'rea_open_binary'))
        return response({ content: 'All enabled tools remain discoverable.' })
      }
      await turn(host.id)
    }
    extraMcp.splice(0)
    process.env.ROXY_MCP = '0'
    // A hallucinated native call in Plan never reaches the dispatcher.
    const before = native.executions.length
    step = 0
    transport = () =>
      ++step === 1 ? call('rea_open_binary', {}) : response({ content: 'Blocked.' })
    await turn(host.id, 'plan')
    assert.equal(native.executions.length, before)
    // Parent and delegated children get their own catalog/prompt and session key.
    step = 0
    transport = (body) => {
      assert(has(body, 'rea_open_binary'))
      assert(prompt(body).includes('Native test guidance'))
      const child = body.messages.some(
        (message) => message.role === 'user' && String(message.content).startsWith('child-')
      )
      if (child) return response({ content: 'Child native investigation complete.' })
      if (++step === 1)
        return call('task', {
          tasks: [
            { description: 'First', prompt: 'child-one' },
            { description: 'Second', prompt: 'child-two' }
          ]
        })
      return response({ content: 'Batch complete.' })
    }
    await turn(host.id)
    console.log(
      'ENGINEERING AGENT OK: real host/bot request schemas and prompts, independent controls, next-turn rebuild, Plan gate, discovery rotation under 128 functions, exact native dispatch, delegated guidance'
    )
  } finally {
    globalThis.fetch = originalFetch
    win.destroy()
    closeDb()
    await rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch((error) => {
      if (!['EBUSY', 'EPERM'].includes(error.code)) throw error
    })
  }
}
app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    closeDb()
    app.exit(1)
  })
