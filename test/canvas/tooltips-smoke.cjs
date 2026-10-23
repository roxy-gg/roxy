const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const path = require('node:path')
const temp = mkdtempSync(path.join(require('node:os').tmpdir(), 'roxy-tooltips-'))
app.setPath('userData', temp)
let server
let win
const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))
// Last page call or wait reached. A hang leaves no log by itself, so the watchdog prints this.
let lastStep = 'startup'
const evaluate = (code) => {
  lastStep = `evaluate: ${code.replace(/\s+/g, ' ').slice(0, 140)}`
  return win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
}
async function waitForActive(id, label, timeout = 3000) {
  lastStep = `waitForActive: ${label}`
  const started = Date.now()
  let actual = null
  while (Date.now() - started < timeout) {
    actual = await evaluate(`return document.activeElement?.id ?? null`)
    if (actual === id) return
    await wait(50)
  }
  assert.fail(`${label}: expected focus on #${id}, got #${actual}`)
}
function detachDebugger() {
  try {
    win?.webContents.debugger.detach()
  } catch {}
}
const tip = () =>
  evaluate(`return document.querySelector('[data-app-tooltip]')?.textContent ?? null`)
async function waitForAttr(selector, attr, expected, label, timeout = 3000) {
  const started = Date.now()
  let actual
  while (Date.now() - started < timeout) {
    actual = await evaluate(
      `return document.querySelector(${JSON.stringify(selector)}).getAttribute(${JSON.stringify(attr)})`
    )
    if (actual === expected) return
    await wait(50)
  }
  assert.fail(
    `${label}: ${selector}[${attr}] expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}
async function waitForEvent(name, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await evaluate(`return window.__tipEvents.includes(${JSON.stringify(name)})`)) return
    await wait(50)
  }
  assert.fail(
    `event ${name} never fired. Events: ${await evaluate(`return JSON.stringify(window.__tipEvents)`)}`
  )
}
async function waitForNoTip(label, timeout = 3000) {
  const started = Date.now()
  let actual = null
  while (Date.now() - started < timeout) {
    actual = await tip()
    if (actual === null) return
    await wait(50)
  }
  assert.fail(`${label}: tooltip still showing "${actual}"`)
}
async function waitForTip(expected, label = 'tooltip', timeout = 3000) {
  const started = Date.now()
  let actual = null
  while (Date.now() - started < timeout) {
    actual = await tip()
    if (expected instanceof RegExp ? expected.test(actual ?? '') : actual === expected)
      return actual
    await wait(50)
  }
  const page = await evaluate(
    `return JSON.stringify({ events: window.__tipEvents ?? [], pointerMoves: window.__pointerMoves ?? 0, hasFocus: document.hasFocus(), active: document.activeElement?.id, focusVisible: document.activeElement?.matches(':focus-visible'), tipNodes: document.querySelectorAll('[data-app-tooltip]').length })`
  )
  assert.fail(`${label}: expected ${expected}, got ${actual}. Page state: ${page}`)
}
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
  // Real OS focus is not guaranteed for a hidden window (CI, or another app in front on
  // macOS). Without it :focus-visible never matches, so emulate page focus instead.
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
    enabled: true
  })
  await wait(1000)
  await evaluate(
    `window.__tipEvents = []; window.__pointerMoves = 0
     for (const type of ['blur', 'resize']) window.addEventListener(type, () => window.__tipEvents.push(type))
     document.addEventListener('scroll', (event) => window.__tipEvents.push('scroll:' + (event.target.id || 'document')), true)
     document.addEventListener('pointermove', () => { window.__pointerMoves += 1 }, true)`
  )

  await hover('#native')
  assert.equal(await tip(), null, 'cold hover waits')
  await waitForTip('Initial action')
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
  await waitForTip('Second action')
  await evaluate(`document.querySelector('#unrelated-scroll').scrollTop = 20`)
  await waitForEvent('scroll:unrelated-scroll')
  assert.equal(await tip(), 'Second action', 'unrelated auto-scroll does not close the tooltip')
  await hover('#scroll-trigger')
  await waitForTip('Scrollable action')
  await evaluate(`document.querySelector('#trigger-scroll').scrollTop = 2`)
  await waitForEvent('scroll:trigger-scroll')
  await waitForNoTip('scrolling a trigger ancestor closes the tooltip')
  await hover('#scroll-trigger', 0.55)
  await waitForTip('Scrollable action', 'pointer movement reopens after scrolling')
  await hover('#named')
  await waitForTip('Named action')
  assert.equal(
    await evaluate(`return document.querySelector('#named').getAttribute('aria-describedby')`),
    null,
    'explicit matching accessible name is not repeated'
  )
  await hover('#described')
  await waitForTip('Additional detail')
  assert.equal(
    await evaluate(
      `const e = document.querySelector('#described'); return e.getAttribute('aria-describedby').split(' ').length`
    ),
    2,
    'additional detail preserves existing description'
  )
  await hover('#second')
  await waitForAttr(
    '#described',
    'aria-describedby',
    'existing-description',
    'existing description is restored'
  )
  await hover('#rich')
  await waitForTip(/Rich description/, 'warm hover opens')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  await wait()
  assert.equal(await tip(), null)
  await hover('#rich', 0.6)
  await wait(500)
  assert.equal(await tip(), null, 'Escape stays dismissed until the trigger is left')
  await leave()
  await hover('#disabled')
  await waitForTip('Disabled description')
  await leave()
  await hover('#virtual', 0.25)
  await waitForTip('Left region')
  await hover('#virtual', 0.75)
  await waitForTip('Right region', 'moving inside one canvas changes hit region')
  await leave()
  const activityPoint = await evaluate(
    `const r = document.querySelector('canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 4 * (r.height + 4) / 7 + 5) }`
  )
  win.webContents.sendInputEvent({ type: 'mouseMove', ...activityPoint })

  await waitForTip(/^3 turns/, 'activity graph uses the shared localized tooltip')
  await evaluate(
    `document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true }))`
  )
  await wait()
  assert.equal(await tip(), null, 'wheel dismisses without waiting for scroll')
  await leave()
  await hover('#bounded')
  await waitForTip('Browser toolbar action')
  assert.ok(
    await evaluate(
      `const r = document.querySelector('[data-app-tooltip]').getBoundingClientRect(); return r.top >= 8 && r.bottom <= 72`
    ),
    'browser toolbar tooltip stays above BrowserViews'
  )
  await leave()
  await hover('#edge')
  await waitForTip(/^Long tooltip/)
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
  await hover('#edge', 0.45)
  await waitForTip(/^Long tooltip/, 'window blur does not block reopening')
  await leave()
  win.show()
  win.focus()
  await wait(250)
  await leave()
  await evaluate(`document.querySelector('#described').focus()`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await waitForActive('second', 'Tab reaches the next trigger')
  await waitForTip('Second action', 'keyboard focus opens')
  await evaluate(`document.querySelector('#second').remove()`)
  await waitForNoTip('removed target closes tooltip')
  await leave()
  win.setContentSize(280, 240)
  await wait()
  await hover('#edge')
  await waitForTip(/^Long tooltip/)
  assert.ok(
    await evaluate(
      `const r = document.querySelector('[data-app-tooltip]').getBoundingClientRect(); return r.left >= 8 && r.right <= innerWidth - 8 && r.top >= 8 && r.bottom <= innerHeight - 8`
    ),
    'narrow viewport clamps both axes'
  )
  await evaluate(`window.dispatchEvent(new Event('resize'))`)
  await wait()
  assert.equal(await tip(), null, 'resize dismisses')
  await hover('#edge', 0.45)
  await waitForTip(/^Long tooltip/, 'resize does not block reopening')
  await evaluate(`document.querySelector('#tooltip-dialog').showModal()`)
  await hover('#dialog-trigger')
  await waitForTip('Modal action')
  assert.equal(
    await evaluate(`return !!document.querySelector('#tooltip-dialog [data-app-tooltip]')`),
    true,
    'modal tooltip lives in the top layer'
  )
  console.log(
    'Themed tooltip lifecycle, dynamic titles, accessibility, disabled buttons, canvas regions, bounds, and live themes: OK'
  )
}
// Skipping teardown aborts Electron on macOS (exit 134), but on Windows CI it has hung after the
// assertions passed. Run it bounded, then leave through a forced exit that cannot block.
async function shutdown() {
  setTimeout(() => process.exit(0), 8000)
  await Promise.race([
    (async () => {
      detachDebugger()
      win?.destroy()
      await server?.close()
    })().catch(() => {}),
    wait(3000)
  ])
}
const watchdog = setTimeout(() => {
  console.error(`TOOLTIPS SMOKE TIMEOUT after 120s. Last step: ${lastStep}`)
  app.exit(1)
}, 120000)
app
  .whenReady()
  .then(run)
  .then(async () => {
    // Windows CI: every assertion passes and the OK line prints, then the process never exits.
    // Detaching the debugger there is synchronous and can block the loop, so none of the timers
    // below would fire. Leave at once; the OS reclaims the window and the temp dir is disposable.
    if (process.platform === 'win32' || process.env.TOOLTIPS_FAST_EXIT) process.exit(0)
    clearTimeout(watchdog)
    await shutdown()
    try {
      rmSync(temp, { recursive: true, force: true })
    } catch {}
    app.exit(0)
  })
  .catch(async (error) => {
    clearTimeout(watchdog)
    console.error(error)
    console.error(`Last step: ${lastStep}`)
    detachDebugger()
    await server?.close()
    app.exit(1)
  })
app.on('will-quit', () => rmSync(temp, { recursive: true, force: true }))
