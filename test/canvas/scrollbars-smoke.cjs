const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')

const temp = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'roxy-scrollbars-'))
app.setPath('userData', temp)
let server, win
let checks = 0
const errors = []
const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => win.webContents.executeJavaScript(code, true)
const check = (name, value) => {
  assert.ok(value, name)
  checks++
  console.log(`  OK ${name}`)
}
const visible = (id = 'scroll-test') =>
  evaluate(`Number(getComputedStyle(document.getElementById('${id}'))
    .getPropertyValue('--scrollbar-visibility'))`)
const move = async (x, y) => {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  await wait()
}
const pixel = async () => {
  await evaluate(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
  )
  const image = await win.webContents.capturePage({ x: 343, y: 80, width: 1, height: 1 })
  return [...image.toBitmap()].slice(0, 3)
}

async function run() {
  let url = process.env.CANVAS_TEST_URL
  if (!url) {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { host: '127.0.0.1', port: 3111, strictPort: true }
    })
    await server.listen()
    url = 'http://127.0.0.1:3111/'
  }
  win = new BrowserWindow({
    width: 900,
    height: 720,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true
    }
  })
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })
  await win.loadURL(url)
  win.webContents.focus()
  await wait(1000)
  await evaluate(`(() => {
    document.getElementById('root').style.display = 'none';
    const scroller = document.createElement('div');
    scroller.id = 'scroll-test'; scroller.tabIndex = 0;
    scroller.style.cssText = 'position:fixed;left:50px;top:50px;width:300px;height:200px;overflow:auto;background:rgb(10,10,10);--theme-scrollbar-thumb:rgb(200,200,200)';
    scroller.innerHTML = '<div style="height:800px;width:800px"><div id="nested-test" style="position:relative;left:40px;top:80px;width:160px;height:90px;overflow:auto;background:rgb(10,10,10)"><div style="height:500px"></div></div></div>';
    document.body.append(scroller);
    const textarea = document.createElement('textarea');
    textarea.id = 'textarea-test';
    textarea.style.cssText = 'position:fixed;left:400px;top:50px;width:200px;height:100px;overflow:auto';
    textarea.value = Array(80).fill('text').join('\\n');
    document.body.append(textarea);
    window.scrollbarGeometry = () => ({width:scroller.clientWidth,height:scroller.clientHeight,children:scroller.children.length,position:getComputedStyle(scroller).position});
    window.beforeScrollbars = scrollbarGeometry();
  })()`)
  await move(700, 400)
  check('native handles start hidden', (await visible()) === 0)
  const hiddenPixel = await pixel()
  await move(150, 70)
  check('hovering content does not reveal the handle', (await visible()) === 0)
  await move(328, 70)
  check('approaching within 24px reveals the handle', (await visible()) === 1)
  const paintedPixel = await pixel()
  check(
    'the native scrollbar actually paints, not just its state',
    paintedPixel[0] > hiddenPixel[0] + 50
  )
  check('revealing a parent does not reveal nested scrollers', (await visible('nested-test')) === 0)
  await wait(1300)
  check('a stationary pointer near the edge keeps the handle visible', (await visible()) === 1)
  await move(150, 70)
  await wait(1250)
  check('moving away fades the handle back out', (await visible()) === 0)
  check('the native handle stops painting after the fade', (await pixel())[0] === hiddenPixel[0])
  check(
    'idle animation state is cleaned up',
    await evaluate(
      `!document.getElementById('scroll-test').style.getPropertyValue('--scrollbar-visibility')`
    )
  )

  await move(328, 70)
  await move(150, 70)
  await wait(850)
  const fading = await visible()
  check('idle hiding interpolates instead of popping off', fading > 0 && fading < 1)
  await move(328, 70)
  check('returning during the fade restores the handle', (await visible()) === 1)
  await wait(300)
  check('an interrupted fade cannot clear the new visible state', (await visible()) === 1)
  await move(150, 70)
  await wait(1250)

  win.webContents.sendInputEvent({ type: 'mouseWheel', x: 150, y: 70, deltaY: -80, deltaX: 0 })
  await wait(250)
  check('wheel scrolling reveals the handle', (await visible()) === 1)
  check(
    'native wheel scrolling still moves content',
    await evaluate(`document.getElementById('scroll-test').scrollTop > 0`)
  )
  await wait(1250)
  check('wheel scrolling fades after inactivity', (await visible()) === 0)
  await evaluate(`document.getElementById('scroll-test').focus()`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'PAGEDOWN' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'PAGEDOWN' })
  await wait(300)
  check('keyboard scrolling reveals the handle', (await visible()) === 1)
  await wait(1250)
  check('keyboard focus alone does not leave a handle permanently visible', (await visible()) === 0)

  await evaluate(`document.getElementById('scroll-test').scrollTop = 0`)
  await move(200, 230)
  check('approaching the bottom reveals horizontal scrollbars', (await visible()) === 1)
  await move(240, 150)
  check('nested scrolling regions reveal independently', (await visible('nested-test')) === 1)
  await move(580, 80)
  check('textareas use the same reveal behavior', (await visible('textarea-test')) === 1)

  await move(328, 80)
  await move(343, 80)
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    x: 343,
    y: 80,
    clickCount: 1
  })
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 343, y: 140 })
  await wait(1400)
  check('a held native thumb does not disappear', (await visible()) === 1)
  check(
    'native thumb dragging still moves content',
    await evaluate(`document.getElementById('scroll-test').scrollTop > 100`)
  )
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: 343, y: 140, clickCount: 1 })
  await move(700, 400)
  await wait(1250)
  check('releasing and leaving a thumb restores idle hiding', (await visible()) === 0)

  await evaluate(`(() => {
    document.documentElement.dataset.appearance = 'light';
    const el = document.getElementById('scroll-test');
    el.style.background = 'rgb(250,250,250)';
    el.style.setProperty('--theme-scrollbar-thumb', 'rgb(20,20,20)');
    el.scrollTop = 0;
  })()`)
  await move(328, 70)
  check('light themes keep their own thumb color', (await pixel())[0] < 60)
  await move(700, 400)
  await wait(1250)
  check('light theme handles also disappear completely', (await pixel())[0] > 240)

  await evaluate(`document.getElementById('scroll-test').style.direction = 'rtl'`)
  await move(65, 70)
  check('RTL reveals at the left edge', (await visible()) === 1)
  await move(700, 400)
  await wait(1250)
  await evaluate(`document.documentElement.dataset.motion = 'reduced'`)
  await move(65, 70)
  check('reduced motion still reveals the handle', (await visible()) === 1)
  check(
    'reduced motion leaves no running fade',
    await evaluate(`document.getElementById('scroll-test').getAnimations().length === 0`)
  )
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'forced-colors', value: 'active' }]
  })
  await move(700, 400)
  await wait(1250)
  check('high contrast keeps handles discoverable', (await visible()) === 1)
  await evaluate(`document.getElementById('scroll-test').style.direction = 'ltr'`)
  check(
    'visibility never changes layout or inserts overlay nodes',
    await evaluate(`JSON.stringify(beforeScrollbars) === JSON.stringify(scrollbarGeometry())`)
  )
  check('no renderer errors', errors.length === 0)
  console.log(`SCROLLBARS OK - ${checks} checks passed`)
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => app.exit(2), 45000)
  let code = 0
  try {
    await run()
  } catch (error) {
    console.error(error, errors)
    code = 1
  }
  clearTimeout(watchdog)
  win?.destroy()
  await server?.close()
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  app.exit(code)
})
