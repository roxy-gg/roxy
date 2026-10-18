const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'roxy-voice-ui-'))
app.setPath('userData', temp)
let win
const errors = []
const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
const click = async (selector) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait()
}
const until = async (code) => {
  for (let n = 0; n < 100; n++) {
    if (await evaluate(`return ${code}`)) return
    await wait(50)
  }
  throw Error(`Timed out: ${code}`)
}
const setInput = async (selector, value, type = 'HTMLInputElement') => {
  await evaluate(`const el = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(${type}.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));`)
  await wait()
}
const draft = () => evaluate(`return document.querySelector('textarea').value`)
const cleanup = () => {
  try {
    fs.rmSync(temp, { recursive: true, force: true })
  } catch (error) {
    if (!['EPERM', 'EBUSY'].includes(error.code)) throw error
  }
}
app
  .whenReady()
  .then(async () => {
    win = new BrowserWindow({
      width: 1100,
      height: 820,
      show: true,
      webPreferences: { contextIsolation: true, backgroundThrottling: false }
    })
    win.webContents.on('console-message', (_event, level, text) => {
      if (level >= 3) errors.push(text)
    })
    await win.loadURL('http://localhost:3105/?voice')
    await until(`!!document.querySelector('[role="switch"]')`)
    assert.equal(
      await evaluate(
        `return document.querySelector('[role="switch"]').getAttribute('aria-checked')`
      ),
      'false'
    )
    assert.equal(await evaluate(`return document.querySelectorAll('article').length`), 2)
    await click('[role="switch"]')
    await click('#voice-ready')
    await setInput('input[aria-label="Search models by name..."]', 'Nemotron')
    assert.equal(await evaluate(`return document.querySelectorAll('article').length`), 1)
    await setInput('input[aria-label="Search models by name..."]', '')
    win.setSize(420, 820)
    await wait()
    assert.equal(await evaluate(`return document.documentElement.scrollWidth > innerWidth`), false)
    win.setSize(1100, 820)
    await click('#voice-page')
    await until(`!!document.querySelector('textarea')`)
    await setInput('textarea', 'Existing draft ', 'HTMLTextAreaElement')
    assert.equal(await draft(), 'Existing draft ')
    await click('[aria-label="Start voice transcription"]')
    assert.equal(
      await evaluate(`return document.querySelector('.composer-gutter [role="status"]')`),
      null,
      'No listening status'
    )
    await click('#voice-partial')
    assert.equal(await draft(), 'Existing draft Hello')
    await click('#voice-partial')
    assert.equal(await draft(), 'Existing draft Hello streaming world')
    await click('[aria-label="Stop voice transcription"]')
    assert.equal(await draft(), 'Existing draft Hello streaming world.')
    await click('#voice-late')
    assert.equal(await draft(), 'Existing draft Hello streaming world.')
    await click('#voice-hotkey')
    await click('#voice-partial')
    await setInput('textarea', 'Typed edit wins', 'HTMLTextAreaElement')
    await click('#voice-late')
    assert.equal(await draft(), 'Typed edit wins')
    await click('#voice-route')
    await click('#voice-hotkey')
    await click('#voice-late')
    await click('#voice-route')
    assert.equal(await draft(), 'Typed edit wins')
    await click('#voice-hotkey')
    await click('#voice-route')
    await click('#voice-late')
    await click('#voice-route')
    assert.equal(await draft(), 'Typed edit wins')
    await click('#voice-hotkey')
    await click('#voice-remount')
    await click('#voice-remount')
    await click('#voice-late')
    assert.equal(await draft(), 'Typed edit wins')
    await click('#voice-hotkey')
    await click('#voice-partial')
    await click('button[title="Send"]')
    await click('#voice-late')
    assert.equal(await draft(), '')
    await click('#voice-slow')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    await evaluate(`document.documentElement.dataset.motion = 'full'`)
    await click('[aria-label="Start voice transcription"]')
    assert.equal(
      await evaluate(`return document.querySelector('.composer-gutter [role="status"]')`),
      null,
      'Loading hidden initially'
    )
    const before = await evaluate(
      `return getComputedStyle(document.querySelector('.composer-gutter .animate-spin')).transform`
    )
    await wait(100)
    const after = await evaluate(
      `return getComputedStyle(document.querySelector('.composer-gutter .animate-spin')).transform`
    )
    assert.notEqual(
      before,
      after,
      'Spinner rotates even if system motion is reduced but Roxy motion is on'
    )
    await wait(1400)
    assert.equal(
      await evaluate(`return document.querySelector('.composer-gutter [role="status"]')`),
      null,
      'Still hidden before 2 seconds'
    )
    await until(`!!document.querySelector('.composer-gutter [role="status"]')`)
    assert(
      await evaluate(`const status = document.querySelector('.composer-gutter [role="status"]');
      return status.getBoundingClientRect().bottom <= document.querySelector('.composer-panel').getBoundingClientRect().top`),
      'Slow status sits above input'
    )
    await click('#voice-started')
    assert.equal(
      await evaluate(`return document.querySelector('.composer-gutter [role="status"]')`),
      null,
      'Listening hides status immediately'
    )
    await click('[aria-label="Stop voice transcription"]')
    assert.equal(
      await evaluate(`return document.querySelector('.composer-gutter [role="status"]')`),
      null,
      'Finishing hidden initially'
    )
    await until(
      `document.querySelector('.composer-gutter [role="status"]')?.textContent.includes('Finishing')`
    )
    await until(`!!document.querySelector('[aria-label="Start voice transcription"]')`)
    assert.equal(
      await evaluate(`return document.querySelector('.composer-gutter [role="status"]')`),
      null,
      'No stale finishing status'
    )
    await click('[aria-label="Start voice transcription"]')
    await click('[aria-label="Stop voice transcription"]')
    await wait(2100)
    assert.equal(
      await evaluate(`return document.querySelector('.composer-gutter [role="status"]')`),
      null,
      'Cancelled loading timer stays cleared'
    )
    win.webContents.debugger.detach()
    assert.deepEqual(errors, [])
    console.log(
      'VOICE UI OK: catalog, streaming, isolation, quiet status, 2-second delayed status above input, rotating spinner, cancelled timer'
    )
  })
  .then(() => {
    win?.destroy()
    cleanup()
    app.exit(0)
  })
  .catch((error) => {
    console.error(error, errors)
    win?.destroy()
    cleanup()
    app.exit(1)
  })
