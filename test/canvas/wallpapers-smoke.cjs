const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
let win, server
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => win.webContents.executeJavaScript(`(async()=>{${code}})()`, true)
const until = async (code) => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`return ${code}`)) return
    await wait(50)
  }
  throw Error(`Timeout: ${code}`)
}
const click = async (text) => {
  await evaluate(
    `[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}).click()`
  )
  await wait(100)
}
const input = async (selector, value) => {
  await evaluate(
    `const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));`
  )
  await wait(50)
}
app.whenReady().then(async () => {
  let code = 0
  const timer = setTimeout(() => app.exit(2), 90000)
  try {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { host: '127.0.0.1', port: 3102, strictPort: true }
    })
    await server.listen()
    win = new BrowserWindow({
      width: 1000,
      height: 1000,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    const errors = []
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) {
        errors.push(message)
        console.error(message)
      }
    })
    await win.loadURL('http://127.0.0.1:3102/wallpapers.html')
    await until(`document.querySelector('h3')`)
    assert.equal(await evaluate(`return window.__wallpapers.searches.length`), 0)
    await click('Browse wallpapers')
    await until(`document.querySelectorAll('button[aria-pressed]').length===2`)
    await evaluate(`document.querySelector('button[aria-pressed]').click()`)
    await until(`document.querySelector('h4')`)
    assert.equal(
      await evaluate(`return window.__wallpapers.applied.length`),
      0,
      'preview does not apply'
    )
    await click('Use background')
    assert.equal(await evaluate(`return window.__wallpapers.applied.length`), 1)
    await click('Submit for review')
    assert.equal(
      await evaluate(`return document.querySelector('button[type=submit]').disabled`),
      true
    )
    await input('form label:nth-of-type(1) input', 'My original')
    await input('form label:nth-of-type(5) input', 'Original artwork / MIT')
    await evaluate(`document.querySelector('input[type=checkbox]').click()`)
    await until(`!document.querySelector('button[type=submit]').disabled`)
    await click('Replace local')
    await until(`!document.querySelector('input[type=checkbox]').checked`)
    await evaluate(`document.querySelector('input[type=checkbox]').click()`)
    await click('Send for review')
    assert.equal(await evaluate(`return window.__wallpapers.submissions.length`), 1)
    await until(`document.querySelector('[role=status]').textContent.includes('Submitted')`)
    await input('input[type=search]', 'slow')
    await wait(300)
    await input('input[type=search]', 'fast')
    await wait(1100)
    assert.equal(
      await evaluate(`return document.querySelector('button[aria-pressed] span').textContent`),
      'fast'
    )
    await evaluate(`document.querySelectorAll('button[aria-pressed]')[1].click()`)
    await until(`!!document.querySelector('video')`)
    assert.equal(
      await evaluate(
        `return document.querySelector('video').muted && !document.querySelector('video').autoplay`
      ),
      true
    )
    await click('Reduce motion')
    await until(`!document.querySelector('video')`)
    const searches = await evaluate(`return window.__wallpapers.searches.length`)
    await click('Toggle active')
    await wait(400)
    assert.equal(await evaluate(`return window.__wallpapers.searches.length`), searches)
    assert.equal(await evaluate(`return document.querySelector('input[type=search]')`), null)
    await click('Toggle active')
    await until(`document.querySelectorAll('button[aria-pressed]').length===2`)
    await evaluate(`window.__wallpapers.fail=true`)
    await input('input[type=search]', 'error')
    await until(`!!document.querySelector('[role=alert]')`)
    await evaluate(`window.__wallpapers.fail=false`)
    await click('Retry catalog')
    await until(`document.querySelectorAll('button[aria-pressed]').length===2`)
    win.setContentSize(390, 900)
    await wait(200)
    assert.equal(
      await evaluate(`return document.documentElement.scrollWidth<=innerWidth`),
      true,
      'mobile does not overflow'
    )
    await fs.mkdir(path.join(__dirname, '../.out'), { recursive: true })
    await fs.writeFile(
      path.join(__dirname, '../.out/wallpapers-mobile.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    win.setContentSize(1000, 1000)
    await wait(100)
    await fs.writeFile(
      path.join(__dirname, '../.out/wallpapers-desktop.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    assert.deepEqual(errors, [])
    console.log(
      'WALLPAPER UI OK: explicit browsing, preview/apply, submission consent/reset, races, retry, silent preview, reduced motion, mobile'
    )
  } catch (error) {
    console.error(error)
    code = 1
  }
  clearTimeout(timer)
  win?.destroy()
  await server?.close()
  app.exit(code)
})
