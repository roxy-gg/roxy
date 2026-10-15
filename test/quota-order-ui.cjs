/**
 * Subscription ordering with simulated quotas. Starts an isolated harness on a
 * dedicated test port, or reuses a canvas harness supplied through ROXY_TEST_URL.
 */
const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'roxy-quota-order-')))
let server
let win
const errors = []
const evaluate = (body) => win.webContents.executeJavaScript(`(async () => { ${body} })()`)
async function until(body) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(body)) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('Timed out: ' + body)
}
async function run() {
  let url = process.env.ROXY_TEST_URL
  if (!url) {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'canvas/vite.config.mjs'),
      server: { port: 3190, strictPort: true }
    })
    await server.listen()
    url = server.resolvedUrls.local[0]
  }
  win = new BrowserWindow({ show: false, width: 1100, height: 780 })
  win.webContents.on('console-message', (_event, level, text) => {
    if (level >= 3) errors.push(text)
  })
  await win.loadURL(new URL('quota.html', url).href)
  const moduleUrl = (file) =>
    path.posix.join('/@fs/', path.resolve(__dirname, '../', file).replaceAll('\\', '/'))
  await evaluate(`
    await import('/@vite/client')
    const refresh = await import('/@react-refresh')
    refresh.default.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    window.roxy = { cliproxy: { quota: async (id) => contract.quotas[id] } }
    const { default: React } = await import('/@id/react')
    const { default: { createRoot } } = await import('/@id/react-dom/client')
    await import(${JSON.stringify(moduleUrl('src/renderer/src/i18n.ts'))})
    await import(${JSON.stringify(moduleUrl('src/renderer/src/assets/main.css'))})
    const { useRoxyStore: store } = await import(${JSON.stringify(moduleUrl('src/renderer/src/lib/store.ts'))})
    const { QuotaMeter } = await import(${JSON.stringify(moduleUrl('src/renderer/src/components/QuotaMeter.tsx'))})
    const providers = ['claude-subscription', 'gemini-subscription', 'github-copilot'].map((seedId, i) => ({
      id: seedId, seedId, name: seedId, enabled: true, accountNumber: 1
    }))
    const bucket = (id, remaining, models) => ({ id, label: id, remaining, models })
    const quotas = {
      'claude-subscription': { upstream: 'claude', buckets: [bucket('five_hour', 80), bucket('seven_day', 10)] },
      'gemini-subscription': { upstream: 'antigravity', buckets: [bucket('gemini-pro', 75, ['gemini-pro']), bucket('gemini-flash', 5, ['gemini-flash'])] },
      'github-copilot': { upstream: 'copilot', buckets: [bucket('premium', 60), bucket('chat', 30), bucket('completions', 2)] }
    }
    store.setState({ providers, modelCatalog: {} })
    const root = createRoot(document.getElementById('root'))
    window.contract = { quotas, store, render: (id, model) => root.render(React.createElement(QuotaMeter, { provider: providers.find((p) => p.id === id), model })) }
    document.getElementById('root').style.cssText = 'position:fixed;right:24px;top:24px'
  `)
  for (const [source, model, initial, reordered, percent] of [
    [
      'claude-subscription',
      'claude-sonnet',
      ['seven_day', 'five_hour'],
      ['five_hour', 'seven_day'],
      '80%'
    ],
    [
      'gemini-subscription',
      'gemini-pro',
      ['gemini-pro', 'gemini-flash'],
      ['gemini-flash', 'gemini-pro'],
      '75%'
    ],
    [
      'github-copilot',
      'paid-model',
      ['chat', 'premium', 'completions'],
      ['premium', 'completions', 'chat'],
      '60%'
    ]
  ]) {
    await evaluate(`contract.render(${JSON.stringify(source)}, ${JSON.stringify(model)})`)
    await until(`return document.querySelector('#root > div > button')?.textContent.includes('%')`)
    await evaluate(`document.querySelector('#root > div > button').click()`)
    await until(
      `return document.querySelectorAll('button[draggable="true"]').length === ${initial.length}`
    )
    const labels = () =>
      evaluate(
        `return [...document.querySelectorAll('button[draggable="true"]')].map((b) => b.parentElement.textContent.replace(${JSON.stringify('Applies to ' + model)}, '').trim())`
      )
    assert.deepEqual(
      await labels(),
      initial.map((id) => {
        const values = {
          seven_day: 10,
          five_hour: 80,
          'gemini-pro': 75,
          'gemini-flash': 5,
          chat: 30,
          premium: 60,
          completions: 2
        }
        return id + values[id] + '% left'
      })
    )
    await evaluate(`
      window.quotaDrag = new DataTransfer()
      document.querySelector('button[draggable="true"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: quotaDrag }))
    `)
    await evaluate(`
      const buttons = document.querySelectorAll('button[draggable="true"]')
      const target = buttons[buttons.length - 1].parentElement.parentElement
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: quotaDrag, clientY: rect.bottom - 1 }))
    `)
    await evaluate(`
      const buttons = document.querySelectorAll('button[draggable="true"]')
      buttons[buttons.length - 1].parentElement.parentElement.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: quotaDrag }))
    `)
    const upstream =
      source === 'claude-subscription'
        ? 'claude'
        : source === 'gemini-subscription'
          ? 'antigravity'
          : 'copilot'
    await until(
      `return JSON.stringify(JSON.parse(localStorage.getItem('roxy.quota.order.v1'))?.[${JSON.stringify(upstream)}]) === ${JSON.stringify(JSON.stringify(reordered))}`
    )
    assert.equal(
      await evaluate(`return document.querySelector('#root > div > button').textContent`),
      percent
    )
    assert.ok((await labels())[0].startsWith(reordered[0]))
    if (upstream !== 'claude') {
      const applies = upstream === 'antigravity' ? ['gemini-pro'] : ['premium', 'chat']
      assert.deepEqual(
        await evaluate(`
        return [...document.querySelectorAll('button[draggable="true"]')]
          .filter((b) => b.parentElement.textContent.includes(${JSON.stringify('Applies to ' + model)}))
          .map((b) => b.parentElement.querySelector('.truncate').textContent)
      `),
        reordered.filter((id) => applies.includes(id))
      )
    }
    // Keyboard and click-menu alternatives use the same persisted ordering.
    await evaluate(
      `document.querySelector('button[draggable="true"]').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }))`
    )
    await until(
      `return JSON.parse(localStorage.getItem('roxy.quota.order.v1'))[${JSON.stringify(upstream)}][1] === ${JSON.stringify(reordered[0])}`
    )
    await evaluate(`document.querySelectorAll('button[draggable="true"]')[1].click()`)
    await until(`return !!document.querySelector('[role="menu"]')`)
    await evaluate(`document.querySelector('[role="menuitem"]').click()`)
    await until(
      `return JSON.parse(localStorage.getItem('roxy.quota.order.v1'))[${JSON.stringify(upstream)}][0] === ${JSON.stringify(reordered[0])}`
    )
    await evaluate(`document.querySelector('#root > div > button').click()`)
  }
  // Browse Claude while Copilot is active: handles must remain available.
  await evaluate(`document.querySelector('#root > div > button').click()`)
  await until(`return !!document.querySelector('select')`)
  await evaluate(`
    const select = document.querySelector('select')
    select.value = 'claude-subscription'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  `)
  await until(`return document.querySelectorAll('button[draggable="true"]').length === 2`)
  await evaluate(
    `document.querySelector('button[draggable="true"]').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }))`
  )
  await until(
    `return JSON.parse(localStorage.getItem('roxy.quota.order.v1')).claude[0] === 'seven_day'`
  )
  assert.equal(
    await evaluate(`return document.querySelector('#root > div > button').textContent`),
    '60%'
  )
  // Switching back restores the saved Claude window.
  await evaluate(`contract.render('claude-subscription', 'claude-sonnet')`)
  await until(`return document.querySelector('#root > div > button')?.textContent === '10%'`)
  win.setSize(390, 844)
  await evaluate(`document.querySelector('#root > div > button').click()`)
  await until(`return document.querySelectorAll('button[draggable="true"]').length === 2`)
  assert.equal(
    await evaluate(`
    const grip = document.querySelector('button[draggable="true"]')
    const rect = grip.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
  `),
    true
  )
  assert.deepEqual(errors, [])
  console.log(
    'QUOTA ORDER UI OK: Claude, Gemini and Copilot drag, keyboard, menus, browsed accounts and saved ordering'
  )
}
const timeout = setTimeout(() => app.exit(1), 60000)
app
  .whenReady()
  .then(run)
  .then(async () => {
    clearTimeout(timeout)
    await server?.close()
    app.quit()
  })
  .catch(async (error) => {
    console.error(error.stack || error, errors)
    await server?.close()
    app.exit(1)
  })
