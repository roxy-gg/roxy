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
    await until(`document.querySelectorAll('button[aria-pressed]').length===10`)
    assert.equal(await evaluate(`return window.__wallpapers.queries[0].limit`), 10)
    assert.equal(await evaluate(`return window.__wallpapers.queries[0].sort`), 'mostUsed')
    assert.equal(
      await evaluate(
        `return document.querySelector('button[aria-expanded]').getAttribute('aria-expanded')`
      ),
      'true'
    )
    await until(`document.querySelectorAll('button[aria-pressed] img').length===10`)
    assert.equal(
      await evaluate(`return [...document.images].every(image=>image.src.startsWith('data:'))`),
      true
    )
    assert.equal(
      await evaluate(`return !!document.querySelector('#actions button[title]')`),
      true,
      'submit sits next to reset effects'
    )
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
    await until(`!!document.querySelector('h4')`)
    assert.equal(
      await evaluate(`return document.querySelector('video')`),
      null,
      'video selection remains thumbnail-only'
    )
    assert.equal(
      await evaluate(
        `return performance.getEntriesByType('resource').some(entry=>entry.name.includes('do-not-load'))`
      ),
      false
    )
    await click('Reduce motion')
    await until(`!document.querySelector('video')`)
    const searches = await evaluate(`return window.__wallpapers.searches.length`)
    await click('Toggle active')
    await wait(400)
    assert.equal(await evaluate(`return window.__wallpapers.searches.length`), searches)
    assert.equal(await evaluate(`return document.querySelector('input[type=search]')`), null)
    await click('Toggle active')
    await until(`document.querySelectorAll('button[aria-pressed]').length===10`)
    await evaluate(`window.__wallpapers.fail=true`)
    await input('input[type=search]', 'error')
    await until(`!!document.querySelector('[role=alert]')`)
    await evaluate(`window.__wallpapers.fail=false`)
    await click('Retry catalog')
    await until(`document.querySelectorAll('button[aria-pressed]').length===10`)
    await evaluate(
      `const el=document.querySelector('select[aria-label="Sort wallpapers"]');el.value='recentApproved';el.dispatchEvent(new Event('change',{bubbles:true}));`
    )
    await until(
      `window.__wallpapers.queries.at(-1).sort==='recentApproved' && document.querySelectorAll('button[aria-pressed]').length===10`
    )
    await click('Load more')
    await until(`document.querySelectorAll('button[aria-pressed]').length===20`)
    await win.loadURL('http://127.0.0.1:3102/?background')
    await until(`document.querySelector('#wallpaper-settings #wallpaper-workshop-heading')`)
    assert.equal(
      await evaluate(
        `return !!(document.querySelector('#wallpaper-workshop-heading').compareDocumentPosition(document.querySelector('#background-heading')) & Node.DOCUMENT_POSITION_FOLLOWING)`
      ),
      true,
      'Workshop appears before background controls'
    )
    assert.equal(
      await evaluate(
        `const reset=[...document.querySelectorAll('#wallpaper-settings button')].find(button=>button.textContent.trim()==='Reset effects');return !!reset?.parentElement.querySelector('button[title]')`
      ),
      true,
      'real settings place submit beside reset'
    )
    await evaluate(
      `[...document.querySelectorAll('#wallpaper-settings button')].find(button=>['Choose background','Change background'].includes(button.textContent.trim())).click()`
    )
    await until(
      `![...document.querySelectorAll('#wallpaper-settings button')].find(button=>button.textContent.trim()==='Submit for review').disabled`
    )
    await evaluate(`location.hash='fail'`)
    await click('Save background')
    await until(
      `document.querySelector('#wallpaper-settings [role=alert]')?.textContent.includes('Could not save')`
    )
    assert.equal(
      await evaluate(
        `return document.querySelector('#wallpaper-settings [role=status]')?.textContent.includes('Nothing was uploaded')`
      ),
      false
    )
    await evaluate(`location.hash='slow'`)
    await click('Save background')
    await until(
      `document.querySelector('#wallpaper-settings [role=status]')?.textContent.includes('Nothing was uploaded')`
    )
    assert.equal(
      await evaluate(`return window.__backgroundActions.submissions`),
      0,
      'Save background never publishes'
    )
    assert.equal(
      await evaluate(`return window.__backgroundActions.updates>=2`),
      true,
      'explicit save writes local settings'
    )
    await evaluate(`location.hash='';document.querySelector('#background-glass').click()`)
    await until(
      `!document.querySelector('#wallpaper-settings [role=status]')?.textContent.includes('Nothing was uploaded')`
    )
    await evaluate(
      `[...document.querySelectorAll('#wallpaper-settings button')].find(button=>button.textContent.trim()==='Submit for review').click()`
    )
    await until(`!!document.querySelector('#wallpaper-settings form')`)
    win.setContentSize(390, 900)
    await wait(200)
    assert.equal(
      await evaluate(
        `const host=document.querySelector('#wallpaper-settings');return host.scrollWidth<=host.clientWidth`
      ),
      true,
      'real wallpaper settings and expanded submission form do not overflow on mobile'
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
      'WALLPAPER UI OK: default top10, sorting/pagination, thumbnail-only browse/selection, consent, retry/races, top placement, submit beside reset, mobile'
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
