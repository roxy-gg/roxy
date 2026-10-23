const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const path = require('node:path')
const temp = mkdtempSync(path.join(require('node:os').tmpdir(), 'roxy-tooltips-'))
app.setPath('userData', temp)
let server
let win
const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
const tip = () =>
  evaluate(`return document.querySelector('[data-app-tooltip]')?.textContent ?? null`)
async function hover(selector, side = 0.5) {
  const point = await evaluate(
    `const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width * ${side}), y: Math.round(r.top + r.height / 2) }`
  )
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await wait()
}
async function leave() {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 350, y: 320 })
  await wait(350)
}
async function run() {
  const { createServer } = await import('vite')
  server = await createServer({
    configFile: path.join(__dirname, 'vite.config.mjs'),
    server: { port: 3105, strictPort: true }
  })
  await server.listen()
  win = new BrowserWindow({
    width: 700,
    height: 450,
    show: false,
    webPreferences: { backgroundThrottling: false }
  })

  await win.loadURL('http://localhost:3105/?tooltips')
  await wait(1000)

  await hover('#native')
  assert.equal(await tip(), null, 'cold hover waits')
  await wait(600)
  assert.equal(await tip(), 'Initial action')
  assert.deepEqual(
    await evaluate(
      `const e = document.querySelector('#native'); return [e.title, e.getAttribute('aria-label'), e.getAttribute('aria-describedby')]`
    ),
    ['', 'Initial action', null]
  )
  await evaluate(`window.__setTooltipTitle('Updated action')`)
  await wait()
  assert.equal(await tip(), 'Updated action', 'React title updates while hovered')
  assert.deepEqual(
    await evaluate(
      `const e = document.querySelector('#native'); return [e.getAttribute('aria-label'), e.getAttribute('aria-describedby')]`
    ),
    ['Updated action', null],
    'dynamic accessible name is not repeated as a description'
  )
  await evaluate(`window.__setTooltipTitle(undefined)`)
  await wait()
  assert.equal(await tip(), null)
  assert.equal(
    await evaluate(`return document.querySelector('#native').hasAttribute('title')`),
    false,
    'removed title stays removed'
  )
  await hover('#second')
  await wait(600)
  assert.equal(await tip(), 'Second action')
  await evaluate(`document.querySelector('#unrelated-scroll').scrollTop = 20`)
  await wait()
  assert.equal(await tip(), 'Second action', 'unrelated auto-scroll does not close the tooltip')
  await hover('#scroll-trigger')
  await wait(600)
  assert.equal(await tip(), 'Scrollable action')
  await evaluate(`document.querySelector('#trigger-scroll').scrollTop = 2`)
  await wait()
  assert.equal(await tip(), null, 'scrolling a trigger ancestor closes the tooltip')
  await hover('#scroll-trigger', 0.55)
  await wait(600)
  assert.equal(await tip(), 'Scrollable action', 'pointer movement reopens after scrolling')
  await hover('#named')
  assert.equal(
    await evaluate(`return document.querySelector('#named').getAttribute('aria-describedby')`),
    null,
    'explicit matching accessible name is not repeated'
  )
  await hover('#described')
  assert.equal(
    await evaluate(
      `const e = document.querySelector('#described'); return e.getAttribute('aria-describedby').split(' ').length`
    ),
    2,
    'additional detail preserves existing description'
  )
  await hover('#second')
  assert.equal(
    await evaluate(`return document.querySelector('#described').getAttribute('aria-describedby')`),
    'existing-description',
    'existing description is restored'
  )
  await hover('#rich')
  assert.match(await tip(), /Rich description/, 'warm hover opens immediately')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  await wait()
  assert.equal(await tip(), null)
  await hover('#rich', 0.6)
  await wait(500)
  assert.equal(await tip(), null, 'Escape stays dismissed until the trigger is left')
  await leave()
  await hover('#disabled')
  await wait(500)
  assert.equal(await tip(), 'Disabled description')
  await leave()
  await hover('#virtual', 0.25)
  await wait(500)
  assert.equal(await tip(), 'Left region')
  await hover('#virtual', 0.75)
  assert.equal(await tip(), 'Right region', 'moving inside one canvas changes hit region')
  await leave()
  const activityPoint = await evaluate(
    `const r = document.querySelector('canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 4 * (r.height + 4) / 7 + 5) }`
  )
  win.webContents.sendInputEvent({ type: 'mouseMove', ...activityPoint })

  await wait(600)
  assert.match(await tip(), /^3 turns/, 'activity graph uses the shared localized tooltip')
  await evaluate(
    `document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true }))`
  )
  await wait()
  assert.equal(await tip(), null, 'wheel dismisses without waiting for scroll')
  await leave()
  await hover('#bounded')
  await wait(500)
  assert.ok(
    await evaluate(
      `const r = document.querySelector('[data-app-tooltip]').getBoundingClientRect(); return r.top >= 8 && r.bottom <= 72`
    ),
    'browser toolbar tooltip stays above BrowserViews'
  )
  await leave()
  await hover('#edge')
  await wait(500)
  assert.ok(
    await evaluate(
      `const r = document.querySelector('[data-app-tooltip]').getBoundingClientRect(); return r.left >= 8 && r.right <= innerWidth - 8 && r.top >= 8 && r.bottom <= innerHeight - 8`
    ),
    'long content stays in viewport'
  )
  await evaluate(`document.documentElement.style.setProperty('--color-elevated', '#123456')`)
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('[data-app-tooltip]')).backgroundColor`
    ),
    'rgb(18, 52, 86)',
    'live theme token applies'
  )
  await evaluate(`window.dispatchEvent(new Event('blur'))`)
  await wait()
  assert.equal(await tip(), null, 'window blur closes tooltip')
  await leave()
  win.show()
  win.focus()
  await wait(250)
  await leave()
  await evaluate(`document.querySelector('#described').focus()`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await wait()
  assert.equal(
    await evaluate(`return document.activeElement.id`),
    'second',
    'Tab reaches the next trigger'
  )
  assert.equal(await tip(), 'Second action', 'keyboard focus opens immediately')
  await evaluate(`document.querySelector('#second').remove()`)
  await wait(350)
  assert.equal(await tip(), null, 'removed target closes tooltip')
  await leave()
  win.setContentSize(280, 240)
  await wait()
  await hover('#edge')
  await wait(600)
  assert.ok(
    await evaluate(
      `const r = document.querySelector('[data-app-tooltip]').getBoundingClientRect(); return r.left >= 8 && r.right <= innerWidth - 8 && r.top >= 8 && r.bottom <= innerHeight - 8`
    ),
    'narrow viewport clamps both axes'
  )
  await evaluate(`window.dispatchEvent(new Event('resize'))`)
  await wait()
  assert.equal(await tip(), null, 'resize dismisses')
  await evaluate(`document.querySelector('#tooltip-dialog').showModal()`)
  await hover('#dialog-trigger')
  await wait(600)
  assert.equal(
    await evaluate(`return !!document.querySelector('#tooltip-dialog [data-app-tooltip]')`),
    true,
    'modal tooltip lives in the top layer'
  )
  console.log(
    'Themed tooltip lifecycle, dynamic titles, accessibility, disabled buttons, canvas regions, bounds, and live themes: OK'
  )
  win.destroy()
  await server.close()
}
app
  .whenReady()
  .then(run)
  .then(() => app.quit())
  .catch(async (error) => {
    console.error(error)
    await server?.close()
    app.exit(1)
  })
app.on('will-quit', () => rmSync(temp, { recursive: true, force: true }))
