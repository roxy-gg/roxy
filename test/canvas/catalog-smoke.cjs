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
    await evaluate(`return document.querySelectorAll('tbody tr').length===8`)
  )
  check(
    'skills show installs; MCP does not invent counts',
    await evaluate(
      `return document.querySelectorAll('section')[0].textContent.includes('24,531') && !document.querySelectorAll('section')[1].textContent.includes('24,531')`
    )
  )
  check(
    'catalogs render semantic tables with installation column, not cards',
    await evaluate(
      `return document.querySelectorAll('table').length===2 && [...document.querySelectorAll('thead th')].some(h=>h.textContent==='Installed') && !document.querySelector('article')`
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
      `return window.__catalogTest.installs.length===1 && document.querySelector('tr[data-installed=true]') && !document.querySelector('[aria-busy]')`
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
      `return window.__catalogTest.installs.length===2 && document.querySelectorAll('section')[1].querySelectorAll('tr[data-installed=true]').length===1 && document.querySelectorAll('section')[1].querySelectorAll('tbody tr').length===4`
    )
  )
  await input('slow')
  await wait(380)
  await input('fast')
  await wait(1000)
  check(
    'late search cannot replace newer results',
    await evaluate(
      `return document.querySelector('section [data-catalog-name]').textContent==='fast'`
    )
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
    'pagination failure retains current rows',
    await evaluate(
      `return document.querySelector('section').querySelectorAll('tbody tr').length===4 && document.querySelector('section').textContent.includes('current results are still available')`
    )
  )
  await evaluate(`window.__catalogTest.failMore=false`)
  await click('Try again')
  check(
    'pagination retry adds only next page',
    await evaluate(
      `return document.querySelector('section').querySelectorAll('tbody tr').length===5`
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
    'narrow layouts scroll the table without overflowing the page',
    await evaluate(
      `return document.querySelector('table').parentElement.scrollWidth>document.querySelector('table').parentElement.clientWidth && document.documentElement.scrollWidth<=innerWidth`
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
  await win.loadURL('http://127.0.0.1:3104/catalog.html?management')
  await wait(700)
  check(
    'real settings hide built-in tools and put manual controls above unified tables',
    await evaluate(
      `return !document.body.textContent.includes('Built-in tools') && document.querySelectorAll('table').length===2 && document.querySelector('#skills-management button').textContent.includes('Add from URL') && document.querySelector('#mcp-management button').textContent.includes('Add MCP server')`
    )
  )
  await evaluate(
    `document.querySelector('button[aria-label="Edit raw SKILL.md for local-workflow"]').click()`
  )
  await wait()
  check(
    'installed skill exposes full frontmatter in raw editor',
    await evaluate(
      `return document.querySelector('#skills-management textarea').value.includes('license: MIT')`
    )
  )
  await evaluate(
    `const el=document.querySelector('#skills-management textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,el.value.replace('Instructions.','Edited.'));el.dispatchEvent(new Event('input',{bubbles:true}));`
  )
  await wait()
  await evaluate(
    `[...document.querySelectorAll('#skills-management button')].find(b=>b.textContent==='Save changes').click()`
  )
  await wait()
  check(
    'raw skill save updates installed list',
    await evaluate(
      `return window.__catalogTest.actions.includes('skill:raw') && !document.querySelector('#skills-management textarea')`
    )
  )
  await evaluate(`document.querySelector('button[aria-label="Reconnect local-mcp"]').click()`)
  await wait()
  check(
    'MCP reconnect remains available from installed table row',
    await evaluate(`return window.__catalogTest.actions.includes('mcp:reconnect')`)
  )
  await evaluate(
    `document.querySelector('button[aria-label="Edit raw configuration for local-mcp"]').click()`
  )
  await wait()
  await evaluate(
    `const el=document.querySelector('#mcp-management textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,el.value.replace('example.com/mcp','example.com/updated'));el.dispatchEvent(new Event('input',{bubbles:true}));`
  )
  await wait()
  await evaluate(
    `[...document.querySelectorAll('#mcp-management button')].find(b=>b.textContent==='Save & reconnect').click()`
  )
  await wait()
  check(
    'MCP raw JSON save reconnects and updates configuration',
    await evaluate(
      `return window.__catalogTest.actions.includes('mcp:raw') && document.querySelector('#mcp-management table').textContent.includes('example.com/updated')`
    )
  )
  await evaluate(`document.querySelector('button[aria-label="Enable local-mcp"]').click()`)
  await wait()
  check(
    'MCP toggle disables connection and reconnect action',
    await evaluate(
      `return document.querySelector('button[aria-label="Enable local-mcp"]').getAttribute('aria-checked')==='false' && document.querySelector('button[aria-label="Reconnect local-mcp"]').disabled`
    )
  )
  check('management has no renderer errors', errors.length === 0)
  const beforeFilter = await evaluate(`return window.__catalogTest.calls.length`)
  await evaluate(
    `const el=document.querySelector('#skills-management select[aria-label="Filter by installation"]');el.value='installed';el.dispatchEvent(new Event('change',{bubbles:true}));`
  )
  await wait(400)
  check(
    'installed-only filter keeps local items without upstream requests',
    await evaluate(
      `return document.querySelector('#skills-management tbody').rows.length===1 && window.__catalogTest.calls.length===${beforeFilter}`
    )
  )
  await evaluate(`document.querySelector('button[aria-label="Remove local-workflow"]').click()`)
  await wait()
  check(
    'skill removal requires explicit confirmation',
    await evaluate(
      `return !window.__catalogTest.actions.includes('skill:remove') && document.querySelector('#skills-management [role=alert]').textContent.includes('local-workflow')`
    )
  )
  await evaluate(
    `[...document.querySelectorAll('#skills-management button')].find(b=>b.textContent==='Delete').click()`
  )
  await wait()
  check(
    'confirmed skill removal updates installed filter',
    await evaluate(
      `return window.__catalogTest.actions.includes('skill:remove') && !document.querySelector('#skills-management tr[data-installed=true]')`
    )
  )
  await evaluate(`document.querySelector('button[aria-label="Remove local-mcp"]').click()`)
  await wait()
  check(
    'MCP removal requires explicit confirmation',
    await evaluate(
      `return !window.__catalogTest.actions.includes('mcp:remove') && document.querySelector('#mcp-management [role=alert]').textContent.includes('local-mcp')`
    )
  )
  await evaluate(
    `[...document.querySelectorAll('#mcp-management button')].find(b=>b.textContent==='Remove').click()`
  )
  await wait()
  check(
    'confirmed MCP removal updates table',
    await evaluate(
      `return window.__catalogTest.actions.includes('mcp:remove') && !document.querySelector('#mcp-management tr[data-installed=true]')`
    )
  )
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
