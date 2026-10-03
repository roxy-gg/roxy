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
const compactConfirmation = async (stacked = false) => {
  assert.ok(
    await evaluate(`
      const dialog = document.querySelector('[aria-labelledby="bot-unsaved-title"]');
      const rect = dialog.getBoundingClientRect();
      const buttons = [...dialog.querySelectorAll('button')].map(el => el.getBoundingClientRect());
      return Math.abs(rect.width - Math.min(448, innerWidth - 32)) < 1
        && Math.abs(rect.left + rect.width / 2 - innerWidth / 2) < 1
        && Math.abs(rect.top + rect.height / 2 - innerHeight / 2) < 1
        && rect.top >= 16 && rect.bottom <= innerHeight - 16
        && dialog.scrollWidth <= dialog.clientWidth
        && buttons.every(button => button.left >= rect.left + 20 && button.right <= rect.right - 20
          && button.top >= rect.top && button.bottom <= rect.bottom)
        && (${stacked}
          ? buttons.every((button, i) => !i || button.top >= buttons[i - 1].bottom + 7)
          : buttons.every(button => Math.abs(button.top - buttons[0].top) < 1));
    `),
    `confirmation is compact, viewport-centered and ${stacked ? 'stacked' : 'grouped'} without overflow`
  )
}
const key = async (keyCode, modifiers = []) => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
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
  assert.ok(
    await evaluate(`
      const section = document.querySelector('button[title="New bot"]').parentElement;
      const styles = getComputedStyle(section);
      return styles.paddingTop === '12px' && styles.paddingBottom === '0px';
    `),
    'the new-bot-only row is separated from New project without adding bottom padding'
  )
  // Creating a bot asks NOTHING: one click lands in its chat, ready to be told
  // who it is. No dialog, no username, no empty form to abandon.
  await click('button[title="New bot"]')
  assert.ok(
    await evaluate(`return !document.querySelector('[role=dialog]')`),
    'creating a bot opens no dialog'
  )
  assert.ok(
    await text('Tell me who to be and what to do. I save it and keep it.'),
    await evaluate('return document.body.textContent')
  )
  assert.equal(
    await evaluate(
      `return document.body.textContent.match(/You're talking to @bot\\./g)?.length ?? 0`
    ),
    1,
    'the bot identity appears only in the centered empty state'
  )
  assert.ok(
    !(await text('For example: "You are Atlas.')),
    'the empty state does not show example helper copy'
  )
  assert.ok(
    await evaluate(
      `return [...document.querySelectorAll('button')].some((el) => el.title === '@bot' && el.querySelector('[data-facehash]'))`
    ),
    'the new bot is selected and carries a generated handle'
  )
  assert.ok(
    await evaluate(`
      const avatar = document.querySelector('button[title="@bot"] [data-facehash]');
      const bounds = avatar.getBoundingClientRect();
      const button = avatar.parentElement.getBoundingClientRect();
      const avatars = [...document.querySelectorAll('[data-facehash]')];
      return bounds.width === 32 && bounds.height === 32
        && button.width === bounds.width && button.height === bounds.height
        && getComputedStyle(avatar.parentElement).padding === '0px'
        && avatars.every(el => getComputedStyle(el).containerType === 'normal'
          && parseFloat(getComputedStyle(el).borderRadius) === el.getBoundingClientRect().width / 4)
        && document.querySelector('header [data-facehash]').parentElement.getBoundingClientRect().width >= 28;
    `),
    'avatar surfaces fill their buttons and do not collapse parent layout width'
  )
  assert.ok(
    await evaluate(`
      const section = document.querySelector('button[title="New bot"]').parentElement;
      const styles = getComputedStyle(section);
      return styles.paddingTop === '12px' && styles.paddingBottom === '12px';
    `),
    'bot rows keep vertical padding above the projects list'
  )
  // You configure a bot by TALKING to it, so the caret has to already be in the
  // composer: otherwise one click creates the bot and a second is needed before
  // you can type the sentence that defines it.
  assert.ok(
    await evaluate(`return document.activeElement === document.querySelector('textarea')`),
    'the composer is focused, ready for the first instruction'
  )
  // Bot composer edits standing chat inference config without opening settings.
  assert.ok(
    await evaluate(`return !!document.querySelector('button[aria-label="Model: Reasoning"]')`)
  )
  assert.ok(
    await evaluate(`return !!document.querySelector('button[aria-label="Thinking effort: High"]')`)
  )
  await click('button[aria-label="Thinking effort: High"]')
  assert.deepEqual(
    await evaluate(
      `return [...document.querySelectorAll('[role="listbox"][aria-label="Thinking effort"] [role="option"]')].map(el => el.textContent.trim())`
    ),
    ['Low', 'HighDefault'],
    'only supported effort levels are offered'
  )
  await click('[role="listbox"][aria-label="Thinking effort"] [role="option"]:first-child')
  assert.ok(
    await evaluate(`return !!document.querySelector('button[aria-label="Thinking effort: Low"]')`)
  )
  await click('button[aria-label="Model: Reasoning"]')
  await type('[data-model-picker-menu] input', 'Fast')
  await click('[data-model-picker-menu] span[title="Fast"]')
  assert.ok(await evaluate(`return !!document.querySelector('button[aria-label="Model: Fast"]')`))
  assert.ok(
    await evaluate(`return !document.querySelector('button[aria-label^="Thinking effort:"]')`),
    'non-reasoning models hide effort'
  )
  await click('button[aria-label="Model: Fast"]')
  await click('[data-model-picker-menu] span[title="Reasoning"]')
  assert.ok(
    await evaluate(`return !!document.querySelector('button[aria-label="Thinking effort: Low"]')`)
  )
  // Renamed in conversation, exactly as the bot itself would with bot_manage.
  await evaluate(`return window.__renameBot('bot', 'helper')`)
  await wait()
  assert.ok(
    await evaluate(
      `return [...document.querySelectorAll('button')].some((el) => el.title === '@helper')`
    ),
    'a rename from the conversation shows up in the sidebar'
  )
  // A creation that fails has to say so. Its error used to render only inside
  // the delete dialog, which is closed here, so the button just re-enabled.
  await evaluate(`window.__failNextCreate = 'Bot limit reached'`)
  await click('button[title="New bot"]')
  assert.ok(await text('Bot limit reached'), 'a failed creation reports why')
  await click('button[title="New bot"]')
  assert.ok(!(await text('Bot limit reached')), 'and the next attempt clears it')
  assert.ok(
    await evaluate(`return !!document.querySelector('button[aria-label="Model: Reasoning"]')`),
    'a new bot inherits the last selected model'
  )
  await click('button[title="@helper"]')
  assert.ok(
    await evaluate(`return !!document.querySelector('button[aria-label="Thinking effort: Low"]')`),
    'switching back restores the first bot effort'
  )
  assert.deepEqual(
    await evaluate(
      `return window.roxy.chats.list().then(chats => chats.filter(chat => chat.kind === 'bot').map(chat => [chat.model, chat.reasoningEffort]))`
    ),
    [
      ['reasoning', 'low'],
      [null, null]
    ],
    'composer changes persist only on the active bot chat'
  )
  await click('button[title="@bot"]')
  await evaluate(`return window.__renameBot('bot', 'planner')`)
  await wait()
  await rightClick('button[title="@helper"]')
  assert.deepEqual(
    await evaluate(
      `return [...document.querySelectorAll('[data-bot-menu] button')].map(button => button.textContent.trim())`
    ),
    ['Edit settings', 'Delete bot']
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
  assert.equal(await evaluate(`return document.activeElement.textContent.trim()`), 'Edit settings')
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
  assert.ok(
    await evaluate(
      `return document.querySelector('[role=alertdialog]').textContent.includes('@planner')`
    ),
    'the confirm names the bot picked in the menu, not the active one'
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
  assert.ok(await text('Save bot settings?'), 'footer Save opens a save-specific confirmation')
  await compactConfirmation()
  assert.ok(!(await text('Discard and close')), 'ordinary Save does not offer discard-and-close')
  await buttonText('Cancel')
  assert.equal(
    await evaluate('return document.querySelector("#bot-profile-form textarea").value'),
    'Be a helpful daily planner.',
    'canceling Save keeps the profile draft'
  )
  await click('button[form="bot-profile-form"]')
  await evaluate(
    `window.__updateBot = window.roxy.bots.update;
      window.roxy.bots.update = () => new Promise((resolve, reject) => { window.__rejectBotUpdate = reject })`
  )
  await buttonText('Save changes')
  await key('Tab')
  assert.ok(
    await evaluate(
      `return document.activeElement === document.querySelector('[aria-labelledby="bot-unsaved-title"]')`
    ),
    'focus stays inside the confirmation while all actions are disabled'
  )
  await key('Escape')
  assert.ok(await text('Save bot settings?'), 'Escape cannot dismiss an in-flight save')
  await evaluate(`window.__rejectBotUpdate(new Error('Test profile write failure'))`)
  await wait()
  await key('Tab')
  assert.equal(await evaluate(`return document.activeElement.textContent.trim()`), 'Cancel')
  assert.ok(
    await evaluate(
      `return document.querySelector('[role=alertdialog]')?.textContent.includes('Test profile write failure')`
    ),
    'failed Save keeps the confirmation and shows the error'
  )
  assert.equal(
    await evaluate('return document.querySelector("#bot-profile-form textarea").value'),
    'Be a helpful daily planner.',
    'failed Save preserves the draft'
  )
  await evaluate(`window.roxy.bots.update = window.__updateBot`)
  await buttonText('Save changes')
  assert.ok(await text('Saved'))
  await wait()
  assert.ok(
    await evaluate(`return !!document.querySelector('#bot-settings-pane')`),
    'ordinary Save leaves settings open'
  )
  assert.ok(!(await text('Save bot settings?')), 'successful Save dismisses the confirmation')
  await type('#bot-profile-form textarea', 'Save after closing prompt')
  await evaluate(`window.__botConfirmTrigger = document.activeElement`)
  await click('#bot-settings-pane button[title="Close"]')
  assert.ok(await text('Save changes before closing?'), 'X prompts for unsaved edits')
  assert.ok(await text('Discard and close'), 'close prompt offers discard')
  assert.equal(await evaluate(`return document.activeElement.textContent.trim()`), 'Keep editing')
  await key('Tab', ['shift'])
  assert.equal(await evaluate(`return document.activeElement.textContent.trim()`), 'Save and close')
  await key('Tab')
  assert.equal(await evaluate(`return document.activeElement.textContent.trim()`), 'Keep editing')
  await key('Tab')
  assert.equal(
    await evaluate(`return document.activeElement.textContent.trim()`),
    'Discard and close'
  )
  await key('Tab')
  assert.equal(await evaluate(`return document.activeElement.textContent.trim()`), 'Save and close')
  for (const [width, height] of [
    [1440, 900],
    [800, 840],
    [390, 840],
    [320, 460]
  ]) {
    win.setSize(width, height)
    await wait()
    await compactConfirmation(width < 480)
  }
  win.setSize(1280, 840)
  await wait()
  await compactConfirmation()
  await key('Escape')
  assert.ok(
    await evaluate(`return !document.querySelector('[aria-labelledby="bot-unsaved-title"]')
      && document.activeElement === window.__botConfirmTrigger`),
    'Escape only dismisses the confirmation and restores focus'
  )
  await key('Escape')
  assert.ok(await text('Save changes before closing?'), 'Escape protects unsaved edits')
  await buttonText('Keep editing')
  assert.ok(
    await evaluate(`return document.activeElement === window.__botConfirmTrigger`),
    'keep editing restores focus to the editor'
  )
  assert.equal(
    await evaluate('return document.querySelector("#bot-profile-form textarea").value'),
    'Save after closing prompt',
    'keep editing retains draft'
  )
  await click('button[title="Bot settings"]')
  assert.ok(await text('Save changes before closing?'), 'header toggle uses close confirmation')
  await buttonText('Save and close')
  assert.ok(
    !(await evaluate(`return !!document.querySelector('#bot-settings-pane')`)),
    'save and close closes settings'
  )
  await click('button[title="Bot settings"]')
  assert.equal(
    await evaluate('return document.querySelector("#bot-profile-form textarea").value'),
    'Save after closing prompt',
    'save and close persisted the edit'
  )
  await type('#bot-profile-form input', 'x')
  await click('button[form="bot-profile-form"]')
  assert.ok(
    await evaluate(`return !document.querySelector('#bot-profile-form input').validity.valid`),
    'footer Save retains native form validation'
  )
  assert.ok(!(await text('Save bot settings?')), 'invalid Save does not open confirmation')
  assert.ok(await evaluate(`return !!document.querySelector('button[title="@helper"]')`))
  await type('#bot-profile-form input', 'helper')
  await type('#bot-profile-form textarea', 'Enter confirmation draft')
  await evaluate(`document.querySelector('#bot-profile-form').requestSubmit()`)
  await wait()
  assert.ok(await text('Save bot settings?'), 'form submission also requires Save confirmation')
  await buttonText('Cancel')
  await buttonText('Add schedule')
  await type('aside section form input', 'Daily check-in')
  await type('aside section form textarea', 'Plan the day.')
  await type('#bot-profile-form textarea', 'Unsaved profile change')
  await click('aside section form button[type="submit"]')
  assert.equal(
    await win.webContents.executeJavaScript(
      `window.roxy.bots.list().then(bots => bots.find(b => b.username === 'helper').instructions)`
    ),
    'Save after closing prompt',
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
  assert.ok(
    await text('Save changes before closing?'),
    'X protects the unsaved schedule-era profile edit'
  )
  await buttonText('Discard and close')
  await click('button[title="Bot settings"]')
  assert.equal(
    await evaluate(`return document.querySelector('#bot-profile-form textarea').value`),
    'Save after closing prompt',
    'discard and close does not persist the profile draft'
  )
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
  await click('#requests')
  assert.ok(
    await evaluate(`
      const blocks = window.__canvasTranscript.scene().blocks;
      const bot = blocks.find(block => block.copyText().includes('Implement the avatar fixes'));
      const human = blocks.find(block => block.copyText().includes('Human request mentioning'));
      const findImage = nodes => nodes.flatMap(node => node.kind === 'group' ? findImage(node.children) : node.kind === 'image' ? [node.src] : []);
      const src = findImage(bot.nodes).find(src => src.startsWith('data:image/svg+xml,'));
      const svg = src ? decodeURIComponent(src.split(',')[1]) : '';
      return JSON.stringify(bot.nodes).includes('data:image/svg+xml,')
        && svg.includes('<rect width="100" height="100" rx="25"')
        && svg.includes('x="20" y="30" width="60" height="40"')
        && !svg.includes('preserveAspectRatio="none"')
        && !JSON.stringify(bot.nodes).includes('"name":"user"')
        && JSON.stringify(human.nodes).includes('"name":"user"')
        && !JSON.stringify(human.nodes).includes('data:image/svg+xml,');
    `),
    'bot-authored project prompts use their avatar while human mentions keep the person icon'
  )
  await click('button[title="@helper"]')
  await click('button[title="Project session"]')
  assert.ok(
    await evaluate(`
      const block = window.__canvasTranscript.scene().blocks.find(block => block.copyText().includes('Implement the avatar fixes'));
      return JSON.stringify(block.nodes).includes('data:image/svg+xml,');
    `),
    'bot prompt avatars survive transcript reload'
  )
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
