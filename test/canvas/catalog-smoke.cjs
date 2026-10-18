const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
let server, win
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms))
const evaluate = (code) => win.webContents.executeJavaScript(`(() => { ${code} })()`, true)
let checks = 0
const check = (name, value) => {
  assert.ok(value, name)
  console.log(`ok ${++checks} - ${name}`)
}
const click = async (text, section = 0) => {
  await evaluate(
    `const scope=document.querySelectorAll('section')[${section}]; [...scope.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`
  )
  await wait()
}
const input = async (value, section = 0, selector = 'input[type=search]') => {
  await evaluate(
    `const el=document.querySelectorAll('section')[${section}].querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true}));`
  )
}
async function run() {
  const { createServer } = await import('vite')
  server = await createServer({
    configFile: path.join(__dirname, 'vite.config.mjs'),
    server: {
      host: '127.0.0.1',
      port: 3104,
      strictPort: true,
      fs: {
        allow: [
          path.join(__dirname, '../..'),
          await fs.realpath(path.join(__dirname, '../../node_modules'))
        ]
      }
    }
  })
  await server.listen()
  win = new BrowserWindow({
    width: 1100,
    height: 850,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  await win.loadURL('http://127.0.0.1:3104/catalog.html')
  await wait(2000)
  check(
    'both catalogs browse independently',
    await evaluate(`return document.querySelectorAll('article').length===8`)
  )
  check(
    'skills show installs; MCP does not invent counts',
    await evaluate(
      `return document.querySelectorAll('section')[0].textContent.includes('24,531 installs') && !document.querySelectorAll('section')[1].textContent.includes('24,531')`
    )
  )
  check(
    'wide container renders two columns',
    await evaluate(
      `return getComputedStyle(document.querySelector('article').parentElement).gridTemplateColumns.split(' ').length===2`
    )
  )
  await click('Review files')
  check(
    'review renders untrusted markdown as escaped text',
    await evaluate(
      `return document.querySelector('pre').textContent.includes('<script>') && !document.querySelector('[role=region] script')`
    )
  )
  await evaluate(
    `const select=document.querySelector('[role=region] select'); select.value='references/example.md'; select.dispatchEvent(new Event('change',{bubbles:true}));`
  )
  await wait()
  check(
    'companion files are reviewable before installing',
    await evaluate(
      `return document.querySelector('pre').textContent==='Companion reference preview.'`
    )
  )
  await click('Install skill globally')
  check(
    'explicit skill confirmation refreshes installed state',
    await evaluate(
      `return window.__catalogTest.installs.length===1 && document.querySelector('section').textContent.includes('Name already in use') && !document.querySelector('[role=region]')`
    )
  )
  await click('Review setup', 1)
  check(
    'MCP requires secrets and masks preview',
    await evaluate(
      `return document.querySelector('input[type=password]') && [...document.querySelectorAll('button')].find(b=>b.textContent.includes('Install MCP server')).disabled && document.querySelector('pre').textContent.includes('[REDACTED]')`
    )
  )
  await input('fixture-token', 1, 'input[type=password]')
  await wait()
  await click('Install MCP server', 1)
  check(
    'MCP confirmation uses reviewed option and refreshes list',
    await evaluate(
      `return window.__catalogTest.installs.length===2 && document.querySelectorAll('section')[1].textContent.includes('Name already in use')`
    )
  )
  await input('slow')
  await wait(380)
  await input('fast')
  await wait(1000)
  check(
    'late search cannot replace newer results',
    await evaluate(`return document.querySelector('section article h3').textContent==='fast'`)
  )
  await input('x')
  await wait(400)
  check(
    'single-character query does not call relay',
    await evaluate(`return !window.__catalogTest.calls.some(c=>c.query==='x')`)
  )
  await input('error')
  await wait(450)
  check(
    'search error offers retry',
    await evaluate(
      `return document.querySelector('section [role=alert]').textContent.includes('Try again')`
    )
  )
  await input('')
  await wait(100)
  await evaluate(`window.__catalogTest.failMore=true`)
  await click('Load more')
  check(
    'pagination failure retains current cards',
    await evaluate(
      `return document.querySelector('section').querySelectorAll('article').length===4 && document.querySelector('section').textContent.includes('current results are still available')`
    )
  )
  await evaluate(`window.__catalogTest.failMore=false`)
  await click('Try again')
  check(
    'pagination retry adds only next page',
    await evaluate(
      `return document.querySelector('section').querySelectorAll('article').length===5`
    )
  )
  await evaluate(`document.querySelector('#toggle-active').click()`)
  await wait()
  const calls = await evaluate(`return window.__catalogTest.calls.length`)
  await wait(400)
  check(
    'inactive settings make no new requests',
    await evaluate(`return window.__catalogTest.calls.length===${calls}`)
  )
  await evaluate(`document.querySelector('#toggle-active').click()`)
  await wait()
  win.setContentSize(390, 850)
  await wait(250)
  check(
    'mobile container uses one column without horizontal overflow',
    await evaluate(
      `return getComputedStyle(document.querySelector('article').parentElement).gridTemplateColumns.split(' ').length===1 && document.documentElement.scrollWidth<=innerWidth`
    )
  )
  await fs.writeFile(
    path.join(__dirname, '../.out/catalog-mobile.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  win.setContentSize(1100, 850)
  await wait(200)
  await fs.writeFile(
    path.join(__dirname, '../.out/catalog-desktop.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  check('no renderer errors', errors.length === 0)
  console.log(`CATALOG UI OK - ${checks} checks passed`)
}
app.whenReady().then(async () => {
  const timer = setTimeout(() => {
    console.error('Catalog UI test timed out')
    app.exit(2)
  }, 60000)
  let code = 0
  try {
    await run()
  } catch (e) {
    console.error(e)
    code = 1
  }
  clearTimeout(timer)
  win?.destroy()
  await server?.close()
  app.exit(code)
})
