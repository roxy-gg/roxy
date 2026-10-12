/** Real tools, SQLite, queue delivery and model transport; no user data/network. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import * as repo from '../src/main/db/repo'
import * as bots from '../src/main/db/bots'
import { closeDb, getDb } from '../src/main/db/database'
import { runTool } from '../src/main/harness/tools'
import { runAgentTurn } from '../src/main/harness/agent'
import { sessionCwd } from '../src/main/services/workspace'
import { enqueuePrompt, wakeAutomation, stopAutomation } from '../src/main/services/automation'
import { sessionBusy } from '../src/main/services/turn-state'
import {
  attachmentSafeJson,
  resolveImageRefs,
  validateForwardedImages
} from '../src/main/services/attachments'
import { MAX_FORWARDED_IMAGES, MAX_IMAGE_BYTES, messageImages } from '../src/shared/attachments'
import { reconstructTurn, flattenToolHistory } from '../src/shared/tool-history'
import { openAiContent } from '../src/main/services/llm'
import { ModelHttpError } from '../src/main/services/model-http-error'
import { toModelMessages } from '../src/main/services/aisdk'
import { toResponsesInput } from '../src/main/services/responses'
import type { QueueItem } from '../src/shared/types'

const root = mkdtempSync(path.join(tmpdir(), 'roxy-image-delegation-'))
app.setPath('userData', root)
process.env.ROXY_TRACK_DISABLE = '1'
process.env.ROXY_SKILLS = '0'
process.env.ROXY_MCP = '0'
const originalFetch = globalThis.fetch
const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='
const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const images = [
  { dataUrl: pixel, mediaType: 'image/png', name: 'first.png' },
  { dataUrl: gif, mediaType: 'image/gif', name: 'second.gif' }
]
const copies = images.map((image) => ({ ...image, forwarded: true }))
type WireMessage = {
  role: string
  content: string | { type: string; text?: string; image_url?: { url: string } }[]
}
const requests: {
  model: string
  messages: WireMessage[]
  tools?: { function: { name: string; parameters: { properties: Record<string, unknown> } } }[]
}[] = []
let tool: { name: string; arguments: Record<string, unknown> } | undefined

async function main(): Promise<void> {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('models.dev'))
      return Response.json({
        openai: {
          models: {
            vision: { id: 'vision', tool_call: true, modalities: { input: ['text', 'image'] } },
            blind: { id: 'blind', tool_call: true, modalities: { input: ['text'] } },
            unknown: { id: 'unknown', tool_call: true }
          }
        }
      })
    assert.equal(String(url), 'https://image-test.invalid/v1/chat/completions')
    requests.push(JSON.parse(String(init?.body)))
    const next = tool
    tool = undefined
    return new Response(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: next
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'forward-images',
                      type: 'function',
                      function: { name: next.name, arguments: JSON.stringify(next.arguments) }
                    }
                  ]
                }
              : { content: 'Checked the supplied request.' },
            finish_reason: next ? 'tool_calls' : 'stop'
          }
        ]
      })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } }
    )
  }
  repo.setAutoWorkstream(false)
  const provider = repo.connectProvider({
    id: 'openai',
    apiKey: 'test-only',
    baseURL: 'https://image-test.invalid/v1',
    defaultModel: 'vision'
  })
  repo.setActiveProvider(provider.id, 'vision')
  const owner = bots.createBot('image-sender')
  const guest = bots.createBot('image-recipient')
  const source = owner.chatId
  const sourceContext = { cwd: sessionCwd(source), sessionId: source, botId: owner.id }
  const destination = repo.createChat({ title: 'Image destination', workspacePath: root })
  const screenshot = repo.addMessage({
    chatId: source,
    role: 'user',
    content: 'Fix both screenshots',
    parts: [
      { type: 'text', text: 'Fix both screenshots' },
      ...images.map((image) => ({ type: 'image' as const, ...image }))
    ]
  })
  const refs = messageImages(screenshot).map((image) => image.ref)
  const rebuilt = reconstructTurn(screenshot, owner)
  assert.deepEqual(
    rebuilt[0].images?.map((image) => image.dataUrl),
    [pixel, gif]
  )
  assert.ok(
    refs.every((ref) => rebuilt[0].content.includes(ref)),
    'the source model discovers both refs'
  )
  assert.ok(flattenToolHistory(rebuilt)[0].images?.length === 2)
  assert.deepEqual(resolveImageRefs(source, refs), copies)
  assert.deepEqual(resolveImageRefs(source, [refs[0], refs[0]]), [copies[0]])
  assert.equal(resolveImageRefs(source, undefined), undefined)
  const read = await runTool('bot_manage', { action: 'read' }, sourceContext)
  assert.ok(read.ok && refs.every((ref) => read.output.includes(ref)))
  assert.ok(!read.output.includes(pixel), 'history tools return metadata, never image bytes')
  for (const invalid of [
    null,
    'not-an-array',
    [3],
    ['image:missing:0'],
    [refs[0], 'missing'],
    Array(MAX_FORWARDED_IMAGES + 1).fill(refs[0])
  ]) {
    const result = await runTool(
      'session_manage',
      { action: 'send', id: destination.id, prompt: 'invalid', image_refs: invalid },
      sourceContext
    )
    assert.equal(result.ok, false)
    assert.equal(repo.listQueue(destination.id).length, 0, 'invalid selection queues nothing')
    assert.ok(!result.output.includes(pixel))
  }
  assert.throws(() => resolveImageRefs(undefined, refs), /source session/)
  assert.throws(
    () => resolveImageRefs(destination.id, refs),
    /unavailable in this chat/,
    'cannot fetch another private chat by guessing a ref'
  )
  for (const image of [
    { ...images[0], mediaType: 'image/svg+xml' },
    { ...images[0], mediaType: 'image/jpeg' },
    { ...images[0], dataUrl: 'file:///private/image.png' },
    { ...images[0], dataUrl: 'data:image/png;base64,!!!!' },
    { ...images[0], dataUrl: 'data:image/png;base64,aW1hZ2U=' },
    {
      ...images[0],
      dataUrl: `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')}`
    }
  ])
    assert.throws(() => validateForwardedImages([image]))

  // Exercise a model-issued handoff, not just a direct helper call.
  tool = {
    name: 'session_manage',
    arguments: {
      action: 'send',
      id: destination.id,
      prompt: 'Fix both forwarded screenshots',
      image_refs: refs
    }
  }
  await runAgentTurn({
    providerId: provider.id,
    model: 'vision',
    messages: rebuilt,
    cwd: sourceContext.cwd,
    chatId: source,
    signal: new AbortController().signal,
    emit: () => {}
  })
  const sourceRequest = requests[0]
  for (const name of ['session_manage', 'bot_invoke', 'queue_manage'])
    assert.ok(
      sourceRequest.tools?.find((entry) => entry.function.name === name)?.function.parameters
        .properties.image_refs
    )
  assert.match(String(sourceRequest.messages[0].content), /include the relevant image_refs/)
  const queued = repo.listQueue(destination.id)[0]
  assert.deepEqual(queued.images, copies)
  assert.equal(queued.botId, owner.id)
  assert.equal(queued.sourceChatId, source)
  assert.ok(
    !JSON.stringify(requests.at(-1)?.messages.filter((m) => m.role === 'tool')).includes(pixel)
  )
  closeDb()
  assert.deepEqual(
    repo.listQueue(destination.id)[0],
    queued,
    'images and attribution survive database reload'
  )

  const deliver = async (chatId: string, failed = false): Promise<void> => {
    wakeAutomation()
    const deadline = Date.now() + 10000
    while (sessionBusy(chatId) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(sessionBusy(chatId), false)
    assert.equal(repo.listQueue(chatId).length, failed ? 1 : 0)
  }
  const clear = (chatId: string): void => {
    for (const item of repo.listQueue(chatId)) repo.removeQueueItem(item.id)
  }
  const assertPayload = (model = 'vision'): void => {
    const request = requests.at(-1)!
    assert.equal(request.model, model)
    const last = request.messages.at(-1)!
    assert.equal(last.role, 'user')
    assert.ok(Array.isArray(last.content))
    assert.deepEqual(
      last.content.filter((part) => part.type === 'image_url').map((part) => part.image_url?.url),
      [pixel, gif]
    )
  }
  await deliver(destination.id)
  clear(source) // Test intentionally stops the automatic reply continuation.
  assertPayload()
  closeDb()
  const delivered = repo.listMessages(destination.id).find((m) => m.content === queued.content)!
  assert.deepEqual(
    messageImages(delivered).map(({ ref: _ref, ...image }) => image),
    copies
  )
  assert.equal(delivered.botId, owner.id)
  assert.equal(delivered.botUsername, owner.username)
  const downstreamRefs = messageImages(delivered).map((image) => image.ref)
  assert.ok(
    downstreamRefs.every((ref) => JSON.stringify(requests.at(-1)?.messages.at(-1)).includes(ref))
  )
  for (const self of [owner, guest, undefined]) {
    const replay = reconstructTurn({ ...delivered, role: 'assistant' }, self)
    assert.equal(
      replay.flatMap((m) => m.images ?? []).length,
      2,
      'foreign and own handoff history keep images'
    )
  }

  // Existing adapters keep real image parts on all supported wires.
  const chatImage = reconstructTurn(delivered)[0]
  const content = openAiContent(chatImage)
  const wire = [{ role: 'user' as const, content }]
  assert.equal(
    (toResponsesInput(wire)[0] as { content: { type: string }[] }).content.filter(
      (p) => p.type === 'input_image'
    ).length,
    2
  )
  const sdk = toModelMessages(wire)[0]
  assert.ok(Array.isArray(sdk.content))
  assert.equal(sdk.content.filter((part) => part.type === 'image').length, 2)

  // An onward copy no longer needs the original user's chat or its workspace.
  const next = repo.createChat({ title: 'Onward', workspacePath: root })
  const nextContext = { cwd: root, sessionId: destination.id }
  const forwarded = await runTool(
    'queue_manage',
    {
      action: 'create',
      session: next.id,
      prompt: 'Onward images',
      image_refs: downstreamRefs,
      not_before: Date.now() + 60000
    },
    nextContext
  )
  assert.ok(forwarded.ok, forwarded.output)
  assert.ok(!forwarded.output.includes(pixel))
  const nextItem = JSON.parse(forwarded.output) as QueueItem
  closeDb()
  await deliver(next.id, true)
  assert.equal(
    repo.listQueue(next.id)[0].state,
    'pending',
    'delayed image delivery survives reload'
  )
  const retained = await runTool(
    'queue_manage',
    { action: 'update', id: nextItem.id, prompt: 'Edited onward images', not_before: 0 },
    nextContext
  )
  assert.ok(retained.ok)
  assert.deepEqual(repo.listQueue(next.id)[0].images, copies)
  repo.removeChat(destination.id)
  closeDb()
  await deliver(next.id)
  assertPayload()
  assert.throws(() => resolveImageRefs(destination.id, downstreamRefs), /source session/)

  // The guest's model wins over its host; bot-to-Roxy uses app defaults in a private chat.
  repo.setChatConfig(source, { providerId: provider.id, model: 'blind' })
  repo.setChatConfig(guest.chatId, { providerId: provider.id, model: 'vision', contextLimit: 4000 })
  for (const recipient of [guest.id, 'roxy']) {
    const result = await runTool(
      'bot_invoke',
      { bot: recipient, prompt: 'Inspect both images', image_refs: refs },
      sourceContext
    )
    assert.ok(result.ok, result.output)
    const item = repo.listQueue(source)[0]
    assert.equal(item.botId, owner.id)
    assert.deepEqual(item.images, copies)
    closeDb()
    assert.deepEqual(repo.listQueue(source)[0], item, 'invited actor and image data survive reload')
    await deliver(source)
    assertPayload()
    assert.equal(
      repo.listMessages(source).at(-1)?.botUsername,
      recipient === 'roxy' ? 'roxy' : guest.username
    )
  }

  // Unsupported and unknown recipients never receive image payloads. Persist a
  // visible explanation as automated queue rows are hidden from the composer.
  for (const model of ['blind', 'unknown', 'not-in-catalog']) {
    repo.setChatConfig(guest.chatId, { providerId: provider.id, model })
    const result = await runTool(
      'bot_invoke',
      { bot: guest.id, prompt: `Cannot view with ${model}`, image_refs: refs },
      sourceContext
    )
    assert.ok(result.ok)
    const before = requests.length
    await deliver(source, true)
    assert.equal(
      requests.length,
      before,
      'no multimodal network request for unsupported/unknown models'
    )
    const failed = repo.listQueue(source)[0]
    assert.deepEqual(failed.images, copies)
    assert.match(failed.error!, /Images were retained but not sent/)
    assert.match(repo.listMessages(source).at(-1)!.content, /Image request could not finish/)
    assert.equal(repo.getChat(guest.chatId)?.model, model, 'never auto-switches')
    const readFailure = await runTool(
      'queue_manage',
      { action: 'read', id: failed.id },
      sourceContext
    )
    assert.ok(readFailure.output.includes('retained but not sent'))
    assert.ok(!readFailure.output.includes(pixel))
    closeDb()
    if (model === 'blind') {
      repo.setChatConfig(guest.chatId, { providerId: provider.id, model: 'vision' })
      const retry = await runTool(
        'queue_manage',
        { action: 'update', id: failed.id },
        sourceContext
      )
      assert.ok(retry.ok)
      await deliver(source)
      assertPayload()
    } else {
      const retry = await runTool(
        'queue_manage',
        { action: 'update', id: failed.id, image_refs: [] },
        sourceContext
      )
      assert.ok(retry.ok)
      await deliver(source)
      assert.ok(requests.at(-1)?.messages.every((message) => typeof message.content === 'string'))
      assert.match(JSON.stringify(requests.at(-1)?.messages), /You have not seen them here/)
    }
  }
  // Omitted image_refs stays text-only, even with screenshots in source history.
  const plain = repo.createChat({ title: 'Text only', workspacePath: root })
  repo.setChatConfig(plain.id, { providerId: provider.id, model: 'blind' })
  const blockedProject = await runTool(
    'session_manage',
    { action: 'send', id: plain.id, prompt: 'Project without vision', image_refs: refs },
    sourceContext
  )
  assert.ok(blockedProject.ok)
  const beforeProject = requests.length
  await deliver(plain.id, true)
  assert.equal(requests.length, beforeProject)
  assert.match(repo.listMessages(source).at(-1)!.content, /retained but not sent/)
  assert.equal(
    repo
      .listMessages(plain.id)
      .find((m) => m.content === 'Project without vision')
      ?.parts.filter((p) => p.type === 'image').length,
    2
  )
  clear(plain.id)
  const textOnly = await runTool(
    'session_manage',
    { action: 'send', id: plain.id, prompt: 'No images needed' },
    sourceContext
  )
  assert.ok(textOnly.ok)
  assert.equal(repo.listQueue(plain.id)[0].images, undefined)
  await deliver(plain.id)
  clear(source)
  assert.ok(requests.at(-1)?.messages.every((message) => typeof message.content === 'string'))
  const attributed = await runTool(
    'queue_manage',
    { action: 'create', session: plain.id, prompt: 'Attributed copy', image_refs: refs },
    sourceContext
  )
  assert.ok(attributed.ok)
  assert.equal(repo.listQueue(plain.id)[0].botUsername, owner.username)
  clear(plain.id)
  assert.ok(
    !attachmentSafeJson({
      image: pixel,
      nested: { dataUrl: pixel, mediaType: 'image/png' }
    }).includes(pixel)
  )
  assert.ok(!attachmentSafeJson({ error: `Provider echoed ${pixel}` }).includes(pixel))
  assert.ok(!new ModelHttpError(400, `Invalid ${pixel}`).message.includes(pixel))
  // Edits replace the exact selection even for a vision recipient. Old images
  // stay visible in history, but must not sneak into the model request.
  repo.setChatConfig(guest.chatId, { providerId: provider.id, model: 'vision' })
  for (const selection of [[], [refs[1]]]) {
    repo.setChatConfig(guest.chatId, { providerId: provider.id, model: 'blind' })
    const pending = await runTool(
      'bot_invoke',
      { bot: guest.id, prompt: 'Edited image selection', image_refs: refs },
      sourceContext
    )
    const pendingId = JSON.parse(pending.output).id
    await deliver(source, true)
    repo.setChatConfig(guest.chatId, { providerId: provider.id, model: 'vision' })
    const edited = await runTool(
      'queue_manage',
      { action: 'update', id: pendingId, image_refs: selection },
      sourceContext
    )
    assert.ok(edited.ok)
    await deliver(source)
    const payloadImages = requests
      .at(-1)!
      .messages.flatMap((message) =>
        typeof message.content === 'string'
          ? []
          : message.content.filter((p) => p.type === 'image_url').map((p) => p.image_url?.url)
      )
    assert.deepEqual(payloadImages, selection.length ? [gif] : [])
  }
  // Renderer-driven follow-ups use the same entry point, so retained forwarded
  // images cannot bypass capability handling after a model change.
  await runAgentTurn({
    providerId: provider.id,
    model: 'unknown',
    messages: [
      ...reconstructTurn(delivered),
      { role: 'user', content: 'Follow up without viewing images' }
    ],
    cwd: root,
    chatId: plain.id,
    signal: new AbortController().signal,
    emit: () => {}
  })
  assert.ok(requests.at(-1)?.messages.every((message) => typeof message.content === 'string'))
  assert.match(JSON.stringify(requests.at(-1)?.messages), /You have not seen them here/)
  // Unknown catalog support does not change established direct-upload behavior.
  await runAgentTurn({
    providerId: provider.id,
    model: 'unknown',
    messages: rebuilt,
    cwd: root,
    chatId: source,
    signal: new AbortController().signal,
    emit: () => {}
  })
  assertPayload('unknown')
  // A failed user-authored Send to collaborator remains user-authored on edit.
  const fromUser = enqueuePrompt(source, 'User request to retry', images, {
    sourceChatId: source,
    fromUser: true,
    asBotId: guest.id
  })
  // Simulate interruption before retry without issuing a paid/model request.
  getDb().prepare("UPDATE queue SET state = 'failed' WHERE id = ?").run(fromUser.id)
  repo.updateQueueItem(fromUser.id, 'Corrected user image request', images)
  await deliver(source)
  const correction = repo
    .listMessages(source)
    .find((m) => m.content === 'Corrected user image request')!
  assert.equal(correction.role, 'user')
  assert.equal(correction.botId, undefined)
  const byHost = await runTool(
    'queue_manage',
    { action: 'create', session: guest.chatId, prompt: 'Host handoff', image_refs: [] },
    { cwd: root, sessionId: plain.id }
  )
  assert.ok(byHost.ok)
  assert.equal(repo.listQueue(guest.chatId)[0].botUsername, 'roxy')
  clear(guest.chatId)
  console.log(
    'IMAGE DELEGATION OK: model-issued session send, ref discovery/access, multiple images, queue reload, onward copies, bot/host routing, adapters, unsupported/unknown models, retry, text-only compatibility'
  )
}

void app
  .whenReady()
  .then(main)
  .then(
    () => {
      stopAutomation()
      globalThis.fetch = originalFetch
      closeDb()
      rmSync(root, { recursive: true, force: true })
      app.exit(0)
    },
    (error) => {
      console.error(error)
      stopAutomation()
      closeDb()
      app.exit(1)
    }
  )
