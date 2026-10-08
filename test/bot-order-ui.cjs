/** Real renderer drag regression. Start the canvas harness on ROXY_TEST_PORT (default 3100). */
const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'roxy-bot-order-')))
const errors = []
let win
const evaluate = (body) => win.webContents.executeJavaScript(`(async () => { ${body} })()`)
async function until(body) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(body)) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('Timed out: ' + body)
}
async function run() {
  win = new BrowserWindow({ show: false, width: 1100, height: 780 })
  win.webContents.on('console-message', (_event, level, text) => {
    if (level >= 3) errors.push(text)
  })

  await win.loadURL(`http://localhost:${process.env.ROXY_TEST_PORT || 3100}/?bots`)
  await until(`return !!document.querySelector('button[title="New bot"]')`)
  const storeUrl =
    '/@fs/' + path.resolve(__dirname, '../src/renderer/src/lib/store.ts').replaceAll('\\', '/')
  await evaluate(`
    const { useRoxyStore: store } = await import(${JSON.stringify(storeUrl)})
    window.contract = { store, api: window.roxy, bots: [] }
  `)
  await evaluate(`
    const f = contract
    f.bots.push(...['alpha', 'beta', 'gamma'].map((username) => ({ id: username, username, instructions: '', chatId: 'bot-chat-' + username, createdAt: 2 })))
    f.api.bots.list = async () => [...f.bots]
    f.api.bots.reorder = async (ids) => {
      const byId = new Map(f.bots.map((bot) => [bot.id, bot]))
      const ordered = new Set(ids)
      f.bots = [...ids.map((id) => byId.get(id)), ...f.bots.filter((bot) => !ordered.has(bot.id))]
    }
    await f.store.getState().refreshBots()
  `)
  await until(`return !!document.querySelector('button[aria-label="@gamma"]')`)
  await evaluate(`
    const source = document.querySelector('button[aria-label="@alpha"]')
    const dataTransfer = window.botDrag = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
  `)
  await evaluate(`
    const target = document.querySelector('button[aria-label="@gamma"]')
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: botDrag, clientX: rect.right - 1, clientY: rect.bottom - 1 }))
  `)
  await evaluate(
    `document.querySelector('button[aria-label="@gamma"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: botDrag }))`
  )
  await until(`return contract.store.getState().bots[2]?.id === 'alpha'`)
  assert.deepEqual(
    await evaluate(
      `return [...document.querySelectorAll('aside button[draggable="true"]')].map((el) => el.getAttribute('aria-label'))`
    ),
    ['@beta', '@gamma', '@alpha']
  )
  await evaluate(`document.querySelector('button[aria-label="@alpha"]').click()`)
  assert.equal(
    await evaluate(`return contract.store.getState().activeChatId`),
    'project-chat',
    'dragging must not open a bot chat'
  )
  await evaluate(`
    const bot = document.querySelector('button[aria-label="@alpha"]')
    bot.focus()
    bot.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowLeft', shiftKey: true }))
  `)
  await until(`return contract.store.getState().bots[1]?.id === 'alpha'`)
  assert.equal(await evaluate(`return document.activeElement.getAttribute('aria-label')`), '@alpha')
  await evaluate(`await contract.store.getState().refreshBots()`)
  assert.deepEqual(await evaluate(`return contract.store.getState().bots.map((bot) => bot.id)`), [
    'beta',
    'alpha',
    'gamma'
  ])
  await evaluate(`
    const bot = document.querySelector('button[aria-label="@alpha"]')
    bot.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'F10', shiftKey: true }))
  `)
  await until(`return !!document.querySelector('[role="menu"]')`)
  await evaluate(`document.querySelector('[role="menu"] button:nth-child(2)').click()`)
  await until(`return contract.store.getState().bots[0]?.id === 'alpha'`)
  assert.equal(await evaluate(`return document.activeElement.getAttribute('aria-label')`), '@alpha')
  assert.deepEqual(errors, [])
  console.log(
    'BOT ORDER UI OK: drag, click isolation, keyboard focus, context-menu moves and persisted refresh'
  )
}
const timeout = setTimeout(() => app.exit(1), 30000)
app
  .whenReady()
  .then(run)
  .then(() => {
    clearTimeout(timeout)
    app.quit()
  })
  .catch((error) => {
    console.error(error.stack || error, errors)
    app.exit(1)
  })
