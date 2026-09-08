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
  await evaluate(
    `const target = document.querySelector(${JSON.stringify(selector)}); if (!target) throw Error('Missing selector: ' + ${JSON.stringify(selector)}); target.click()`
  )
  await wait()
}
const rightClick = async (selector) => {
  const point = await evaluate(
    `const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }`
  )
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'right', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'right', clickCount: 1 })
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
  await type('form[role="dialog"] input', '  @hel per\t\u00a0 ')
  assert.equal(
    await evaluate('return document.querySelector("form[role=dialog] input").value'),
    'helper',
    'pasted username removes whitespace before validation'
  )
  await win.webContents.debugger.sendCommand('Input.insertText', { text: ' ' })
  await wait()
  assert.equal(
    await evaluate('return document.querySelector("form[role=dialog] input").value'),
    'helper',
    'typing a space does not leave an invalid username'
  )
  assert.ok(
    await evaluate(
      'return !document.querySelector("form[role=dialog] button[type=submit]").disabled'
    )
  )
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
  await click('button[title="New bot"]')
  await type('form[role="dialog"] input', 'planner')
  await click('form[role="dialog"] button[type="submit"]')
  await rightClick('button[title="@helper"]')
  assert.deepEqual(
    await evaluate(
      `return [...document.querySelectorAll('[data-bot-menu] button')].map(button => button.textContent.trim())`
    ),
    ['Bot settings', 'Delete bot']
  )
  assert.equal(
    await evaluate(
      `return document.querySelector('button[title="@planner"]').getAttribute('aria-pressed')`
    ),
    'true',
    'right-click does not switch the active chat'
  )
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait()
  assert.ok(
    await evaluate(
      `return !document.querySelector('[data-bot-menu]') && document.activeElement.title === '@helper'`
    ),
    'Escape dismisses the menu and returns focus'
  )
  await rightClick('button[title="@helper"]')
  await evaluate(
    `document.querySelector('header').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`
  )
  await wait()
  assert.ok(
    await evaluate(`return !document.querySelector('[data-bot-menu]')`),
    'outside click dismisses the menu'
  )
  await rightClick('button[title="@helper"]')
  await click('[data-bot-menu] button:first-child')
  assert.equal(
    await evaluate(`return document.querySelector('#bot-settings-pane input').value`),
    'helper',
    'settings opens the clicked bot, not the active one'
  )
  await click('#bot-settings-pane button[title="Close"]')
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
  await evaluate(`window.__botChatCanvas = document.querySelector('canvas')`)
  await click('button[title="Bot settings"]')
  assert.ok(
    await evaluate(`
      const sidebar = document.querySelector('aside:not([aria-label])').getBoundingClientRect();
      const pane = document.querySelector('#bot-settings-pane').getBoundingClientRect();
      const header = document.querySelector('header.reserve-controls-right').getBoundingClientRect();
      const close = document.querySelector('#bot-settings-pane button[title="Close"]').getBoundingClientRect();
      return Math.abs(pane.left - sidebar.right) < 1 && Math.abs(header.left - pane.right) < 1
        && Math.abs(pane.top - header.top) < 1 && close.right < innerWidth - 144;
    `),
    'bot settings dock between the main sidebar and chat, away from Windows controls'
  )
  assert.ok(
    await evaluate(`return window.__botChatCanvas === document.querySelector('canvas')`),
    'opening settings preserves the mounted transcript'
  )
  assert.equal(
    await evaluate(
      `return document.querySelector('button[title="Bot settings"]').getAttribute('aria-expanded')`
    ),
    'true'
  )
  win.setSize(800, 840)
  await wait()
  assert.ok(
    await evaluate(`
      const sidebar = document.querySelector('aside:not([aria-label])').getBoundingClientRect();
      const pane = document.querySelector('#bot-settings-pane').getBoundingClientRect();
      const header = document.querySelector('header.reserve-controls-right').getBoundingClientRect();
      return Math.abs(pane.left - sidebar.right) < 1 && pane.top >= header.bottom
        && pane.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    `),
    'narrow windows keep settings on the left below the title bar without overflow'
  )
  await click('button[title="Collapse sidebar"]')
  win.setSize(390, 840)
  await wait()
  assert.ok(
    await evaluate(`
      const sidebar = document.querySelector('.sidebar-rail').getBoundingClientRect();
      const pane = document.querySelector('#bot-settings-pane').getBoundingClientRect();
      const close = document.querySelector('#bot-settings-pane button[title="Close"]').getBoundingClientRect();
      return Math.abs(pane.left - sidebar.right) < 1 && pane.right <= innerWidth
        && close.bottom <= innerHeight && close.top >= 48
        && document.documentElement.scrollWidth <= innerWidth;
    `),
    'settings remain usable beside the collapsed rail at mobile width'
  )
  await click('#bot-settings-pane button[title="Close"]')
  await evaluate(`document.querySelector('button[title="@planner"]').focus()`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F10', modifiers: ['shift'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F10', modifiers: ['shift'] })
  await wait()
  assert.equal(await evaluate(`return document.activeElement.textContent.trim()`), 'Bot settings')
  assert.ok(
    await evaluate(
      `const r = document.querySelector('[data-bot-menu]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight`
    ),
    'collapsed-rail menu fits narrow windows'
  )
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowDown',
    code: 'ArrowDown',
    windowsVirtualKeyCode: 40
  })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowDown',
    code: 'ArrowDown',
    windowsVirtualKeyCode: 40
  })
  await wait()
  assert.equal(await evaluate(`return document.activeElement.textContent.trim()`), 'Delete bot')
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'char',
    text: '\r',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await wait()
  assert.ok(await text('This cannot be undone.'), 'menu deletion requires confirmation')
  assert.equal(
    await evaluate(`return document.querySelector('#bot-settings-pane input').value`),
    'planner'
  )
  assert.ok(
    await evaluate(`return !!document.querySelector('button[title="@planner"]')`),
    'opening delete does not delete a bot'
  )
  await buttonText('Cancel')
  assert.ok(!(await text('This cannot be undone.')))
  await click('button[title="@helper"]')
  await click('button[title="Bot settings"]')
  await evaluate(`window.__botChatCanvas = document.querySelector('canvas')`)
  win.setSize(1280, 840)
  await wait()
  await click('button[title="Expand sidebar"]')
  await click('aside[aria-label="Bot settings"] button[title="Close"]')
  assert.ok(
    await evaluate(
      `return !document.querySelector('#bot-settings-pane') && window.__botChatCanvas === document.querySelector('canvas')`
    )
  )
  await click('button[title="Bot settings"]')
  await type('aside[aria-label="Bot settings"] textarea', 'Be a helpful daily planner.')
  await type('#bot-settings-pane form input', ' @hel per\t\u00a0 ')
  assert.equal(
    await evaluate('return document.querySelector("#bot-settings-pane form input").value'),
    'helper',
    'renaming applies the same whitespace rule'
  )
  assert.ok(
    await evaluate(`
    const pane = document.querySelector('#bot-settings-pane').getBoundingClientRect();
    const footer = document.querySelector('#bot-settings-pane footer').getBoundingClientRect();
    const save = document.querySelector('button[form="bot-profile-form"]').getBoundingClientRect();
    const remove = document.querySelector('#bot-settings-pane footer button').getBoundingClientRect();
    return Math.abs(footer.bottom - pane.bottom) < 1 && Math.abs(save.right - (pane.right - 17)) < 2
      && remove.left < save.left && Math.abs(remove.top - save.top) < 1;
  `),
    'Delete is bottom-left and the profile Save is bottom-right'
  )
  await click('button[form="bot-profile-form"]')
  assert.ok(await text('Saved'))
  await type('#bot-profile-form input', 'x')
  await click('button[form="bot-profile-form"]')
  assert.ok(
    await evaluate(`return !document.querySelector('#bot-profile-form input').validity.valid`),
    'footer Save retains native form validation'
  )
  assert.ok(await evaluate(`return !!document.querySelector('button[title="@helper"]')`))
  await type('#bot-profile-form input', 'helper')
  await buttonText('Add schedule')
  await type('aside section form input', 'Daily check-in')
  await type('aside section form textarea', 'Plan the day.')
  await type('#bot-profile-form textarea', 'Unsaved profile change')
  await click('aside section form button[type="submit"]')
  assert.equal(
    await win.webContents.executeJavaScript(
      `window.roxy.bots.list().then(bots => bots.find(b => b.username === 'helper').instructions)`
    ),
    'Be a helpful daily planner.',
    'schedule Save does not submit the profile form'
  )
  assert.ok(await text('Every 60 minutes'))
  await buttonText('Pause')
  assert.ok(await text('Enable'))
  const jobsBefore = await win.webContents.executeJavaScript(
    `(async () => { const bot = (await window.roxy.bots.list()).find(b => b.username === 'helper'); return window.roxy.bots.jobs(bot.id) })()`
  )
  await buttonText('Force run')
  assert.ok(await text('Run queued'))
  await evaluate(
    `window.__runJob = window.roxy.bots.runJob; window.roxy.bots.runJob = async () => { throw new Error('Test queue unavailable') }`
  )
  await buttonText('Force run')
  assert.ok(
    await evaluate(
      `return document.querySelector('#bot-settings-pane footer [role=alert]').textContent.includes('Test queue unavailable')`
    ),
    'queue errors are visible beside the footer actions'
  )
  assert.ok(!(await text('Run queued')), 'failed requests do not show queued success')
  await evaluate(`window.roxy.bots.runJob = window.__runJob`)
  const forcedQueue = await win.webContents.executeJavaScript(
    `(async () => { const bot = (await window.roxy.bots.list()).find(b => b.username === 'helper'); return window.roxy.queue.list(bot.chatId) })()`
  )
  assert.equal(
    forcedQueue.filter((item) => item.content === 'Plan the day.').length,
    1,
    'Force run queues the saved prompt once, including paused jobs'
  )
  const jobsAfter = await win.webContents.executeJavaScript(
    `(async () => { const bot = (await window.roxy.bots.list()).find(b => b.username === 'helper'); return window.roxy.bots.jobs(bot.id) })()`
  )
  assert.deepEqual(
    jobsAfter,
    jobsBefore,
    'Force run leaves schedule timing, enabled state and limits unchanged'
  )
  win.setSize(800, 460)
  await wait()
  await evaluate(`document.querySelector('#bot-profile-form').parentElement.scrollTop = 10000`)
  assert.ok(
    await evaluate(
      `const save = document.querySelector('button[form="bot-profile-form"]').getBoundingClientRect(); return save.bottom <= innerHeight && save.top > 0`
    ),
    'footer Save stays visible when schedules scroll'
  )
  win.setSize(1280, 840)
  await wait()
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
  await click('button[title="Bot settings"]')
  await evaluate(`document.querySelector('#bot-settings-pane textarea').focus()`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait()
  assert.ok(
    await evaluate(`return !document.querySelector('#bot-settings-pane')`),
    'Escape closes settings'
  )
  await click('button[title="Bot settings"]')
  await click('button[title="Project session"]')
  assert.ok(await evaluate(`return !document.querySelector('#bot-settings-pane')`))
  await type('textarea', '@he')
  assert.ok(await evaluate('return !!document.querySelector("[role=listbox] [role=option]")'))
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await wait()
  assert.equal(await evaluate('return document.querySelector("textarea").value'), '@helper ')
  await type('textarea', '@helper Tell me what to do next.')
  await click('button[title="Send"]')
  assert.ok(await text('@helper Tell me what to do next.'))
  await rightClick('button[title="@helper"]')
  await click('[data-bot-menu] button:last-child')
  assert.ok(await text('This cannot be undone.'))
  await buttonText('Delete bot')
  assert.ok(
    await evaluate(
      `return !document.querySelector('button[title="@helper"]') && !!document.querySelector('button[title="@planner"]')`
    ),
    'delete only removes the clicked bot'
  )
  await click('button[title="@planner"]')
  await click('button[title="Bot settings"]')
  await buttonText('Delete bot')
  await buttonText('Delete bot')
  for (let i = 0; i < 20 && !(await text('New bot')); i++) await wait()
  assert.ok(await text('New bot'), await evaluate('return document.body.textContent'))
  assert.ok(!errors.length, errors.join('\n'))
  console.log(
    'BOTS UI OK — creation, intro, avatar/canvas identity, left settings layout, bot/mention queue routing, failed retry, instructions, schedules and deletion'
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
