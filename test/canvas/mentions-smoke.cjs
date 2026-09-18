const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const path = require('node:path')
const temp = mkdtempSync(path.join(require('node:os').tmpdir(), 'roxy-mentions-ui-'))
app.setPath('userData', temp)
let win
const wait = () => new Promise((resolve) => setTimeout(resolve, 150))
const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
const click = async (selector) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait()
}
const type = async (text) => {
  await evaluate(`const el = document.querySelector('textarea'); el.focus(); el.select()`)
  await win.webContents.debugger.sendCommand('Input.insertText', { text })
  await wait()
}
const highlights = () =>
  evaluate(
    `return [...document.querySelectorAll('[aria-hidden] span.text-accent')].map(el => el.textContent)`
  )
const send = () => click('button[title="Send"], button[title="Add to queue"]')
async function run() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.debugger.attach('1.3')
  await win.loadURL(process.env.BOTS_TEST_URL || 'http://localhost:3130/?bots')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await click('button[title="New bot"]')
  await evaluate(`await window.__renameBot('bot', 'reviewer')`)
  await wait()
  const bot = await evaluate(`return (await window.roxy.bots.list())[0]`)
  await type('Hola @roxy!')
  await send()
  const privateItem = await evaluate(
    `return (await window.roxy.queue.list(${JSON.stringify(bot.chatId)})).at(-1)`
  )
  assert.equal(privateItem.content, 'Hola @roxy!')
  assert.equal(privateItem.asBotId, undefined)
  await click('button[title="Project session"]')
  await click('#busy')
  for (const draft of [
    'Hola @reviewer',
    '@reviewer hola',
    'Hola @reviewer y @roxy',
    'Implementa @modelcontextprotocol/sdk y luego llama a @reviewer',
    'Quiero hablar sobre @reviewer',
    'Hola @does-not-exist'
  ]) {
    await type(draft)
    assert.deepEqual(
      await highlights(),
      draft.includes('@reviewer')
        ? draft.includes('@roxy')
          ? ['@reviewer', '@roxy']
          : ['@reviewer']
        : []
    )
    await send()
    const item = await evaluate(`return (await window.roxy.queue.list('project-chat')).at(-1)`)
    assert.equal(item.content, draft)
    assert.equal(item.asBotId, undefined, 'no guest selected by the UI')
    assert.equal(item.recipientId, undefined, 'no obsolete recipient option')
    assert.ok(await evaluate(`return !document.querySelector('[role=alert]')`))
  }
  await type('@reviewer/sdk user@reviewer.com @reviewer-other @unknown')
  assert.deepEqual(await highlights(), [])
  await type('Hola @reviewer!')
  await evaluate(`await window.__renameBot('reviewer', 'renamed')`)
  await wait()
  assert.deepEqual(await highlights(), [], 'removed handles stop highlighting')
  await type('Hola @RENAMED!')
  assert.deepEqual(await highlights(), ['@RENAMED'])
  await type('Hola @ro')
  await click('[role=option]')
  assert.equal(await evaluate(`return document.querySelector('textarea').value`), 'Hola @roxy ')
  win.setSize(390, 840)
  await wait()
  if (await evaluate(`return !!document.querySelector('button[title="Collapse sidebar"]')`))
    await click('button[title="Collapse sidebar"]')
  assert.ok(
    await evaluate(
      `const r = document.querySelector('textarea').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight`
    )
  )
  assert.equal(await evaluate(`return document.querySelectorAll('select').length`), 0)
  console.log(
    'MENTIONS UI OK: known highlights only, no automatic routing, unrestricted sends, renames, autocomplete and mobile'
  )
}
app
  .whenReady()
  .then(run)
  .then(() => {
    win.destroy()
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
app.on('will-quit', () => {
  try {
    rmSync(temp, { recursive: true, force: true })
  } catch {}
})
