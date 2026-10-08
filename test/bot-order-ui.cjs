/**
 * Real renderer drag regression for the sidebar bot strip. Starts its own canvas
 * harness (port 3189) unless ROXY_TEST_URL points at one already running.
 */
const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'roxy-bot-order-')))
const errors = []
let win
let server
const evaluate = (body) => win.webContents.executeJavaScript(`(async () => { ${body} })()`)
async function until(body) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(body)) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('Timed out: ' + body)
}
async function run() {
  let url = process.env.ROXY_TEST_URL
  if (!url) {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'canvas/vite.config.mjs'),
      server: { port: 3189, strictPort: true }
    })
    await server.listen()
    url = 'http://localhost:3189/'
  }
  win = new BrowserWindow({ show: false, width: 1100, height: 780 })
  win.webContents.on('console-message', (_event, level, text) => {
    if (level >= 3) errors.push(text)
  })

  const harnessUrl = new URL(url)
  harnessUrl.searchParams.set('bots', '')
  await win.loadURL(harnessUrl.href)
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
  assert.equal(
    await evaluate(
      `return document.querySelector('button[aria-label="@alpha"]').getAttribute('aria-description')`
    ),
    null
  )
  assert.equal(
    await evaluate(
      `const id = document.querySelector('button[aria-label="@alpha"]').getAttribute('aria-describedby'); return document.getElementById(id)?.textContent`
    ),
    'Drag to reorder bots. Use Shift + arrow keys or the context menu to move a bot.'
  )
  assert.deepEqual(
    await evaluate(`
      const dt = new DataTransfer()
      document.querySelector('button[aria-label="@alpha"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
      document.querySelector('button[aria-label="@alpha"]').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
      return [...dt.types]
    `),
    ['application/x-roxy-bot'],
    'a dropped bot must not insert its id as composer text'
  )
  await evaluate(`
    contract.bots = contract.bots.filter((bot) => bot.id === 'alpha')
    await contract.store.getState().refreshBots()
  `)
  await until(`return !document.querySelector('button[aria-label="@beta"]')`)
  await evaluate(`
    const bot = document.querySelector('button[aria-label="@alpha"]')
    const r = bot.getBoundingClientRect()
    bot.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom }))
  `)
  await until(`return !!document.querySelector('[role="menu"]')`)
  assert.deepEqual(
    await evaluate(
      `return [...document.querySelectorAll('[role="menu"] button')].map((b) => b.disabled)`
    ),
    [false, false],
    'a single bot shows only settings and delete'
  )
  assert.equal(
    await evaluate(
      `return document.querySelector('button[aria-label="@alpha"]').getAttribute('draggable')`
    ),
    'false'
  )
  assert.deepEqual(errors, [])
  console.log(
    'BOT ORDER UI OK: drag, click isolation, keyboard focus, context-menu moves and persisted refresh'
  )
}
const timeout = setTimeout(() => app.exit(1), 30000)
app
  .whenReady()
  .then(run)
  .then(async () => {
    clearTimeout(timeout)
    await server?.close()
    app.quit()
  })
  .catch(async (error) => {
    console.error(error.stack || error, errors)
    await server?.close()
    app.exit(1)
  })
