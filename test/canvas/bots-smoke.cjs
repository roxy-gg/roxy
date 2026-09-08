const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'roxy-bots-ui-'))
app.setPath('userData', temp)
let win
const errors = []
const wait = () => new Promise((resolve) => setTimeout(resolve, 200))
const evaluate = (code) => win.webContents.executeJavaScript(`(() => { ${code} })()`, true)
const click = async (selector) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait()
}
const type = async (selector, value) => {
  await evaluate(
    `const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select()`
  )
  await win.webContents.debugger.sendCommand('Input.insertText', { text: value })
  await wait()
}
const text = (value) =>
  evaluate(`return document.body.textContent.includes(${JSON.stringify(value)})`)
const buttonText = async (value) => {
  await evaluate(
    `const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(value)}); if (!button) throw Error('Missing button'); button.click()`
  )
  await wait()
}
async function run() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })
  win.webContents.debugger.attach('1.3')
  await win.loadURL(process.env.BOTS_TEST_URL || 'http://localhost:3114/?bots')
  win.focus()
  await new Promise((resolve) => setTimeout(resolve, 2000))
  assert.ok(await text('New bot'))
  await click('button[title="New bot"]')
  await type('form[role="dialog"] input', 'helper')
  await click('form[role="dialog"] button[type="submit"]')
  assert.ok(
    await text('What do you want me to be or do?'),
    await evaluate('return document.body.textContent')
  )
  assert.equal(
    await evaluate('return document.querySelectorAll("aside section button[title=helper]").length'),
    0
  )
  assert.ok(
    await evaluate(
      `return [...document.querySelectorAll('button')].some((el) => el.title === '@helper' && el.querySelector('[data-facehash]'))`
    )
  )
  await type('textarea', 'Help me plan my day.')
  await click('button[title="Send"]')
  assert.ok(await text('Help me plan my day.'))
  await click('#failed')
  assert.ok(await text('Failed — edit to retry'))
  await click('button[title="Edit and retry"]')
  await buttonText('Save & retry')
  assert.ok(!(await text('Failed — edit to retry')))
  await click('#answer')
  await wait()
  const canvasBot = await evaluate(
    `const scene = window.__canvasTranscript.scene(); return JSON.stringify(scene.blocks).includes('@helper') && JSON.stringify(scene.blocks).includes('data:image/svg+xml,')`
  )
  assert.ok(canvasBot)
  assert.ok(await evaluate('return window.__canvasTest.botPaints > 0'))
  await click('button[title="Bot settings"]')
  await type('aside[aria-label="Bot settings"] textarea', 'Be a helpful daily planner.')
  await click('aside[aria-label="Bot settings"] form button[type="submit"]')
  assert.ok(await text('Saved'))
  await buttonText('Add schedule')
  await type('aside section form input', 'Daily check-in')
  await type('aside section form textarea', 'Plan the day.')
  await click('aside section form button[type="submit"]')
  assert.ok(await text('Every 60 minutes'))
  await buttonText('Pause')
  assert.ok(await text('Enable'))
  await click('button[title="Edit schedule"]')
  await evaluate(
    `const el = document.querySelector('aside section form select'); el.value = 'cron'; el.dispatchEvent(new Event('change', { bubbles: true }))`
  )
  await wait()
  await click('aside section form button[type="submit"]')
  assert.ok(await text('0 9 * * *'))
  await click('button[title="Edit schedule"]')
  await evaluate(
    `const el = document.querySelector('aside section form select'); el.value = 'timestamps'; el.dispatchEvent(new Event('change', { bubbles: true }))`
  )
  await wait()
  await buttonText('Add time')
  assert.equal(
    await evaluate('return document.querySelectorAll("input[type=datetime-local]").length'),
    2
  )
  await buttonText('Cancel')
  await click('button[title="Delete schedule"]')
  assert.ok(await text('No schedules yet.'))
  await click('aside[aria-label="Bot settings"] button[title="Close"]')
  await click('button[title="Project session"]')
  await type('textarea', '@he')
  assert.ok(await evaluate('return !!document.querySelector("[role=listbox] [role=option]")'))
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await wait()
  assert.equal(await evaluate('return document.querySelector("textarea").value'), '@helper ')
  await type('textarea', '@helper Tell me what to do next.')
  await click('button[title="Send"]')
  assert.ok(await text('@helper Tell me what to do next.'))
  await click('button[title="@helper"]')
  await click('button[title="Bot settings"]')
  await buttonText('Delete bot')
  assert.ok(await text('This cannot be undone.'))
  await buttonText('Delete bot')
  for (let i = 0; i < 20 && !(await text('New bot')); i++) await wait()
  assert.ok(await text('New bot'), await evaluate('return document.body.textContent'))
  assert.ok(!errors.length, errors.join('\n'))
  console.log(
    'BOTS UI OK — creation, intro, avatar/canvas identity, bot/mention queue routing, failed retry, instructions, schedules and deletion'
  )
}
app
  .whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error?.stack || String(error))
    console.error(errors)
    app.exit(1)
  })
