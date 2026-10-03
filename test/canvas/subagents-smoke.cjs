const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync } = require('node:fs')
const { rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const temp = mkdtempSync(path.join(tmpdir(), 'roxy-subagents-ui-'))
app.setPath('userData', temp)
app.on('window-all-closed', () => undefined)
app.commandLine.appendSwitch('disable-renderer-backgrounding')
let win
let server
const errors = []
let lastAction = 'start'
const evaluate = (code) => {
  lastAction = code
  return win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
}
const settle = () =>
  evaluate(
    // An occluded Windows test window can suspend rAF even with background
    // throttling disabled. Like the stream publisher, keep a timer fallback.
    'await new Promise(resolve => { const timer = setTimeout(resolve, 50); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() })) })'
  )
const scene = async () =>
  JSON.parse(await evaluate('return JSON.stringify(window.__canvasTranscript.scene())'))
async function run() {
  let url = process.env.BOTS_TEST_URL
  if (!url) {
    lastAction = 'import Vite'
    const { createServer } = await import('vite')
    lastAction = 'create Vite server'
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { port: 3100, strictPort: true }
    })
    lastAction = 'listen on port 3100'
    await server.listen()
    url = 'http://localhost:3100/?bots'
  }
  lastAction = 'create test window'
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    webPreferences: { backgroundThrottling: false }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  lastAction = `load ${url}`
  await win.loadURL(url)
  for (
    let i = 0;
    i < 100 &&
    !(await evaluate('return !!window.__taskFixture && !!document.querySelector("header")'));
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 50))
  await evaluate(`document.querySelector('button[title="New bot"]').click()`)
  await settle()
  await evaluate('window.__taskFixture("running")')
  await settle()
  let current = await scene()
  assert.equal(current.blocks.length, 2)
  assert.ok(
    current.blocks
      .flatMap((block) => block.regions)
      .some((region) => region.action.type === 'cancel' && region.action.id === 'fixture-parent/0'),
    'persisted detached launch offers per-task cancellation'
  )
  assert.ok(
    await evaluate(`return !!document.querySelector('header button[title*="background"]')`),
    'private bot chat exposes detached-task controls'
  )
  const region = current.blocks
    .flatMap((block) => block.regions)
    .find((region) => region.action.type === 'toggle')
  const point = await evaluate(
    `const el = document.querySelector('[data-canvas-surface]'); const r = el.getBoundingClientRect(); return {x:r.x+${region.x + 30},y:r.y+${region.y + region.h / 2}-el.scrollTop}`
  )
  win.webContents.debugger.attach('1.3')
  for (const type of ['mousePressed', 'mouseReleased'])
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,
      ...point,
      button: 'left',
      clickCount: 1
    })
  await settle()
  assert.ok(
    JSON.stringify(await scene()).includes('Live delegate progress'),
    'expanded card shows the live subagent transcript'
  )
  for (const width of [1280, 390]) {
    win.setContentSize(width, 800)
    if (width === 390)
      await evaluate(`document.querySelector('button[title="Collapse sidebar"]')?.click()`)
    await settle()
    assert.ok(
      await evaluate(
        'const el = document.querySelector("[data-canvas-surface]"); return el.scrollWidth === el.clientWidth && document.documentElement.scrollWidth <= innerWidth'
      ),
      `no horizontal overflow at ${width}px`
    )
  }
  await evaluate('window.__taskFixture("completed")')
  await settle()
  current = await scene()
  assert.equal(current.blocks.length, 2, 'completion stays in the original assistant bubble')
  assert.ok(
    !current.blocks
      .flatMap((block) => block.regions)
      .some((region) => region.action.type === 'cancel'),
    'completed task no longer offers cancellation'
  )
  assert.ok(
    !JSON.stringify(current).includes('fixture-result'),
    'no separate background-done bubble'
  )
  await evaluate('window.__taskFixture("running")')
  await settle()
  const cancel = (await scene()).blocks
    .flatMap((block) => block.regions)
    .find((region) => region.action.type === 'cancel')
  const cancelPoint = await evaluate(
    `const el = document.querySelector('[data-canvas-surface]'); const r = el.getBoundingClientRect(); return {x:r.x+${cancel.x + cancel.w / 2},y:r.y+${cancel.y + cancel.h / 2}-el.scrollTop}`
  )
  for (const type of ['mousePressed', 'mouseReleased'])
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,
      ...cancelPoint,
      button: 'left',
      clickCount: 1
    })
  await settle()
  assert.ok(
    await evaluate('return window.__canvasTest.cancelled.includes("fixture-sub")'),
    'cancel button addresses the detached delegate, not its parent'
  )
  await evaluate(`document.querySelector('header button[title*="background"]').click()`)
  assert.ok(
    await evaluate('return window.__canvasTest.cancelled.includes("fixture-job")'),
    'bot header cancels outstanding background tasks'
  )
  await evaluate('window.__taskFixture("running", true)')
  await settle()
  assert.ok(
    await evaluate(`
    const status = document.querySelector('section[aria-label="1 subagent still running"]')
    const r = status?.getBoundingClientRect()
    return !!r && r.top >= 0 && r.bottom <= innerHeight && status.textContent.includes('provider research')
  `),
    'AFK return: the pending review stays visible beside the composer after later replies'
  )
  assert.ok(
    await evaluate(
      `return !!document.querySelector('textarea') && !document.querySelector('button[title="Stop (Esc)"]')`
    ),
    'background progress does not pretend the parent is still taking its turn'
  )
  await evaluate(
    `document.querySelector('section[aria-label="1 subagent still running"] button[title="provider research"]').click()`
  )
  await settle()
  assert.ok(
    await evaluate(
      'return document.querySelector("header").textContent.includes("Explore: provider research")'
    ),
    'the running-task strip opens the live delegate'
  )
  await evaluate(`document.querySelector('header button[title^="Back to"]').click()`)
  await settle()
  assert.ok(
    await evaluate(
      `return document.querySelector('section[aria-label="1 subagent still running"]') !== null`
    ),
    'returning to the parent retains the detached task status'
  )
  await evaluate(
    `document.querySelector('section[aria-label="1 subagent still running"] button[aria-label="Cancel this subagent"]').click()`
  )
  assert.ok(
    await evaluate(
      'return window.__canvasTest.cancelled.filter(id => id === "fixture-job").length === 2'
    ),
    'the persistent strip can cancel just that background job'
  )
  assert.ok(
    await evaluate(
      `return !!document.querySelector('section[aria-label="1 subagent still running"]')`
    ),
    'a cancellation request cannot hide a task before its terminal update'
  )
  await evaluate('window.__taskFixture("completed", true)')
  await settle()
  assert.ok(
    await evaluate(
      `return !document.querySelector('section[aria-label="1 subagent still running"]')`
    ),
    'the pending strip disappears only when the detached result arrives'
  )
  const retainedParent = (await scene()).blocks.map((block) => block.id)
  await evaluate(`const el = document.querySelector('[data-canvas-surface]'); el.scrollTop = 0`)
  await settle()
  let open = (await scene()).blocks
    .flatMap((block) => block.regions)
    .find((region) => region.action.type === 'session')
  if (!open) {
    const toggle = (await scene()).blocks
      .flatMap((block) => block.regions)
      .find((region) => region.action.type === 'toggle' && region.action.id === 'fixture-parent/0')
    const togglePoint = await evaluate(
      `const r = document.querySelector('[data-canvas-surface]').getBoundingClientRect(); return { x: r.x + ${toggle.x + 30}, y: r.y + ${toggle.y + toggle.h / 2} }`
    )
    for (const type of ['mousePressed', 'mouseReleased'])
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
        ...togglePoint,
        button: 'left',
        clickCount: 1
      })
    await settle()
    open = (await scene()).blocks
      .flatMap((block) => block.regions)
      .find((region) => region.action.type === 'session')
  }
  assert.ok(open, 'completed task retains a link to the full subagent session')
  const openPoint = await evaluate(
    `const el = document.querySelector('[data-canvas-surface]'); el.scrollTop = Math.max(0, ${open.y} - 100); const r = el.getBoundingClientRect(); return { x: r.x + ${open.x + 30}, y: r.y + ${open.y + open.h / 2} - el.scrollTop }`
  )
  for (const type of ['mousePressed', 'mouseReleased'])
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,
      ...openPoint,
      button: 'left',
      clickCount: 1
    })
  await settle()
  assert.ok(
    JSON.stringify(await scene()).includes('Full retained delegate transcript'),
    'finished subagent opens its complete saved transcript from the parent card'
  )
  await evaluate(`document.querySelector('header button[title^="Back to"]').click()`)
  await settle()
  assert.deepEqual(
    (await scene()).blocks.map((block) => block.id),
    retainedParent,
    'opening a completed delegate and returning keeps every parent message'
  )
  await evaluate(`document.querySelector('button[title="Collapse sidebar"]')?.click()`)
  assert.ok(!errors.length, errors.join('\n'))
  console.log(
    'SUBAGENT UI OK - progress after parent completion, navigation, cancellation and narrow layout'
  )
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    console.error('SUBAGENT UI TIMEOUT', { lastAction, url: win?.webContents.getURL(), errors })
    app.exit(2)
  }, 30_000)
  let code = 0
  try {
    await run()
  } catch (error) {
    console.error(error)
    console.error('Last action:', lastAction)
    console.error(errors)
    code = 1
  }
  clearTimeout(watchdog)
  win?.destroy()
  await server?.close()
  await rm(temp, { recursive: true, force: true }).catch(() => {})
  app.exit(code)
})
