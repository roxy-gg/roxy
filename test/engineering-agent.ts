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
import { CHEAT_SCHEMAS } from '../src/shared/cheat'
const temp = mkdtempSync(path.join(tmpdir(), 'roxy-engineering-agent-'))
app.setPath('userData', temp)
process.env.ROXY_TRACK_DISABLE = '1'
process.env.ROXY_SKILLS = '0'
process.env.ROXY_MCP = '0'
app.on('window-all-closed', () => undefined)
const native = {
  cheat: { schemas: [] as EngineeringSchema[], guidance: undefined as string | undefined },
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
    native.turn = { schemas: [], guidance: undefined }
    native.cheat = {
      schemas: CHEAT_SCHEMAS,
      guidance: '<cheat-engineering>Lab test guidance</cheat-engineering>'
    }
    for (const chatId of [host.id, bot.chatId]) {
      step = 0
      transport = (body) => {
        assert(has(body, 'cheat_open_process'))
        assert(has(body, 'rea_tools'), 'Discovery works without REA enabled')
        assert(prompt(body).includes('Lab test guidance'))
        assert(!has(body, 'rea_open_binary'))
        if (++step === 1) return call('cheat_open_process', { pid: 42 })
        assert(
          body.messages.some(
            (m) => m.role === 'tool' && String(m.content).includes('cheat handler result')
          )
        )
        return response({ content: 'Lab tool executed.' })
      }
      await turn(chatId)
      assert.equal(native.executions.at(-1)?.sessionId, chatId)
      assert.equal(native.executions.at(-1)?.name, 'cheat_open_process')
    }
    for (const [name, input] of [
      ['cheat_inspect_dll', { path: 'C:\\lab\\fixture.dll' }],
      ['cheat_build_dll', { sources: ['C:\\lab\\fixture.cpp'], name: 'fixture' }],
      ['cheat_load_dll', { path: 'C:\\lab\\fixture.dll' }],
      ['cheat_write_memory', { address: '0x1234', data: '0102' }]
    ] as const) {
      step = 0
      transport = (body) => {
        assert(has(body, name), 'DLL tool reaches the real model catalog')
        return ++step === 1
          ? call(name, input)
          : response({ content: 'DLL tool dispatch checked.' })
      }
      await turn(host.id)
      assert.equal(native.executions.at(-1)?.name, name)
      assert.equal(native.executions.at(-1)?.sessionId, host.id)
    }
    const cheatBefore = native.executions.length
    step = 0
    transport = (body) => {
      assert(!has(body, 'cheat_open_process'))
      assert(!prompt(body).includes('Lab test guidance'))
      return ++step === 1
        ? call('cheat_open_process', { pid: 42 })
        : response({ content: 'Plan call rejected.' })
    }
    await turn(host.id, 'plan')
    assert.equal(native.executions.length, cheatBefore)
    native.turn = { schemas, guidance: undefined }
    step = 0
    transport = (body) => {
      assert((body.tools?.length ?? 0) <= 128)
      if (++step === 1)
        return call('rea_tools', { operations: ['cheat_inspect_reclass', 'cheat_load_dll'] })
      assert(has(body, 'cheat_inspect_reclass'))
      assert(has(body, 'cheat_load_dll'))
      return response({ content: 'Combined native discovery verified.' })
    }
    await turn(host.id)
    // Re-resolve settings before every model step, including mid-turn disable.
    native.turn = { schemas: [], guidance: undefined }
    const active = {
      schemas: CHEAT_SCHEMAS,
      guidance: '<cheat-engineering>Live cheat prompt</cheat-engineering>'
    }
    native.cheat = active
    step = 0
    transport = (body) => {
      if (++step === 1) {
        assert(has(body, 'cheat_load_dll'))
        assert(prompt(body).includes('Live cheat prompt'))
        native.cheat = { schemas: [], guidance: undefined }
        return call('rea_tools', { operations: ['cheat_load_dll'] })
      }
      assert(!body.tools?.some((tool) => tool.function.name.startsWith('cheat_')))
      assert(!prompt(body).includes('Live cheat prompt'))
      return response({ content: 'Mid-turn disable applied.' })
    }
    await turn(host.id)
    native.cheat = active
    step = 0
    transport = (body) => {
      if (++step === 1) {
        native.cheat = {
          schemas: CHEAT_SCHEMAS.filter(({ function: f }) => f.name !== 'cheat_load_dll'),
          guidance: '<cheat-engineering>Selected cheat prompt</cheat-engineering>'
        }
        return call('rea_tools', { operations: ['cheat_load_dll', 'cheat_read_memory'] })
      }
      assert(!has(body, 'cheat_load_dll'))
      assert(has(body, 'cheat_read_memory'))
      assert(prompt(body).includes('Selected cheat prompt'))
      assert(!prompt(body).includes('Live cheat prompt'))
      const found = JSON.parse(
        String(body.messages.filter((message) => message.role === 'tool').at(-1)?.content)
      )
      assert(!found.some((schema) => schema.function.name === 'cheat_load_dll'))
      return response({ content: 'Per-call discovery filter applied.' })
    }
    await turn(bot.chatId)
    native.cheat = { schemas: [], guidance: undefined }
    const staleBefore = native.executions.length
    step = 0
    transport = (body) => {
      assert(!body.tools?.some((tool) => tool.function.name.startsWith('cheat_')))
      assert(!prompt(body).includes('cheat-engineering'))
      return ++step === 1
        ? call('cheat_load_dll', { path: 'C:\\lab\\fixture.dll' })
        : response({ content: 'Disabled stale call refused.' })
    }
    await turn(host.id)
    assert.equal(native.executions.length, staleBefore)
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
