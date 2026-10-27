import { app, BrowserWindow, Menu, webContents } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as browser from '../src/main/services/browser'
import { closeDb } from '../src/main/db/database'
import { runTool } from '../src/main/harness/tools'
import { optimizer } from '@electron-toolkit/utils'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await sleep(50)
  }
  assert.fail('Timed out waiting for browser event')
}

async function main(): Promise<void> {
  delete process.env.ELECTRON_RENDERER_URL
  console.log('Browser DevTools: preparing isolated Electron session')
  const root = await mkdtemp(path.join(os.tmpdir(), 'roxy-devtools-'))
  app.setPath('userData', root)
  app.on('window-all-closed', () => undefined)
  app.on('browser-window-created', (_event, window) => {
    queueMicrotask(() => {
      if (!window.isDestroyed() && browser.keyForContents(window.webContents) === null)
        optimizer.watchWindowShortcuts(window)
    })
  })
  await app.whenReady()
  console.log('Browser DevTools: Electron ready')
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/api' }).end()
    } else if (url.pathname === '/api') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Fixture': 'yes',
          'X-Auth-Token': 'response-secret',
          'Set-Cookie': 'fixture=secret; SameSite=Lax'
        })
        res.end(JSON.stringify({ answer: 42, body }))
      })
    } else if (url.pathname === '/binary') {
      res
        .writeHead(200, { 'Content-Type': 'application/octet-stream' })
        .end(Buffer.from([0, 1, 2, 255]))
    } else if (url.pathname === '/missing') {
      res.writeHead(404).end('not here')
    } else if (url.pathname === '/broken') {
      req.socket.destroy()
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
        .end(`<!doctype html><title>DevTools fixture</title>
        <h1>Diagnostics</h1><script>
        console.log('fixture-console', { structured: true });
        window.fixtureReady = fetch('/api', { method: 'POST', headers: { Authorization: 'Bearer fixture-secret' }, body: 'post-fixture' }).then(r => r.json());
        setTimeout(() => { throw new Error('fixture-uncaught') }, 0);
        setTimeout(() => Promise.reject(new Error('fixture-rejection')), 0);
        </script>`)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}`
  const key = 'devtools-chat-a'
  const call = (name: string, input: Record<string, unknown> = {}, sessionId = key) => {
    return runTool(name, input, { cwd: root, sessionId })
  }
  const data = async (
    name: string,
    input: Record<string, unknown> = {},
    sessionId = key
  ): Promise<any> => {
    const out = await call(name, input, sessionId)
    assert(out.ok, out.output)
    return JSON.parse(out.output).result
  }
  const evaluate = async (expression: string, tabId?: string): Promise<any> => {
    const result = await data('browser_evaluate', { expression, tabId })
    assert(!result.exceptionDetails, JSON.stringify(result))
    return result.result.value
  }
  try {
    assert(!(await call('browser_network')).ok, 'Inspection must not create a browser')
    assert.equal(browser.listTabs(key).length, 0)
    assert((await call('browser_open', { url: base })).ok)
    assert.equal((await evaluate('window.fixtureReady')).answer, 42)
    await eventually(async () =>
      (await data('browser_network', { url: '/api' })).requests.some((r: any) => r.finished)
    )
    const firstTab = browser.listTabs(key)[0].id
    const network = await data('browser_network')
    assert(network.attached, JSON.stringify(network))
    console.log('Browser DevTools: network, bodies and runtime events')
    assert(
      network.requests.some((r: any) => r.url === base + '/'),
      'Initial navigation was captured'
    )
    assert(
      !network.requests.some((r: any) => /google/.test(r.url)),
      'No competing homepage navigation'
    )
    const post = network.requests.find((r: any) => r.url === base + '/api')
    const detail = await data('browser_network_request', {
      id: post.id,
      requestBody: true,
      responseBody: true
    })
    assert.equal(detail.request.requestHeaders.Authorization, '[redacted]')
    assert.equal(
      Object.entries(detail.request.responseHeaders).find(
        ([name]) => name.toLowerCase() === 'x-auth-token'
      )?.[1],
      '[redacted]'
    )
    assert.equal(detail.requestBody.text, 'post-fixture')
    assert.equal(JSON.parse(detail.responseBody.text).answer, 42)
    assert.equal(detail.responseBody.base64Encoded, false)
    assert.equal(typeof detail.request.durationMs, 'number')
    const sensitive = await data('browser_network_request', { id: post.id, includeSensitive: true })
    assert.equal(sensitive.request.requestHeaders.Authorization, 'Bearer fixture-secret')
    const limited = await data('browser_network_request', {
      id: post.id,
      responseBody: true,
      maxChars: 5
    })
    assert(limited.responseBody.truncated && limited.responseBody.text.length === 5)
    assert.equal((await data('browser_network', { limit: 1 })).requests.length, 1)
    assert(
      (await data('browser_network', { offset: 1, limit: 1 })).requests[0].id !==
        network.requests[0].id
    )
    assert((await call('browser_console')).output.includes('fixture-console'))
    await eventually(
      async () =>
        (await data('browser_debug_events', { method: 'exceptionThrown' })).events.length >= 2
    )
    const errors = await data('browser_debug_events', { method: 'exceptionThrown' })
    assert(JSON.stringify(errors).includes('fixture-uncaught'))
    assert(JSON.stringify(errors).includes('fixture-rejection'))
    assert(JSON.stringify(errors).includes('stackTrace'))
    assert.equal(
      (await data('browser_debug_events', { after: errors.nextAfter, method: 'exceptionThrown' }))
        .events.length,
      0
    )
    assert.deepEqual(await evaluate('Promise.resolve({ value: 7 })'), { value: 7 })
    assert.equal(await evaluate('typeof require'), 'undefined')
    const metrics = await data('browser_devtools', { method: 'Performance.getMetrics' })
    assert(metrics.metrics.some((m: any) => m.name === 'JSHeapUsedSize' && m.value > 0))
    const dom = await data('browser_devtools', { method: 'DOM.getDocument', params: { depth: 1 } })
    assert(dom.root.nodeId > 0)
    for (const method of [
      'Browser.getVersion',
      'Target.getTargets',
      'Network.disable',
      'Network.getAllCookies'
    ]) {
      assert(!(await call('browser_devtools', { method })).ok, `Blocked ${method}`)
    }
    assert(!(await call('browser_devtools', { method: 'DOM.getDocument', params: [] })).ok)
    const exception = await data('browser_evaluate', {
      expression: `throw new Error('evaluation-error')`
    })
    assert(JSON.stringify(exception.exceptionDetails).includes('evaluation-error'))
    await evaluate(
      `Promise.all(['/redirect', '/missing', '/broken', '/binary'].map(p => fetch(p).then(r => r.arrayBuffer()).catch(() => null)))`
    )
    await eventually(async () =>
      (await data('browser_network', { url: '/binary' })).requests.some((r: any) => r.finished)
    )
    const binary = (await data('browser_network', { url: '/binary' })).requests[0]
    const binaryBody = (
      await data('browser_network_request', { id: binary.id, responseBody: true })
    ).responseBody
    assert(binaryBody.base64Encoded)
    assert.deepEqual(Buffer.from(binaryBody.text, 'base64'), Buffer.from([0, 1, 2, 255]))
    const redirected = (await data('browser_network', { url: '/redirect' })).requests[0]
    assert.equal(redirected.status, 302)
    assert(redirected.redirectedTo.endsWith('/api'))
    assert(
      (await data('browser_network_request', { id: redirected.id, responseBody: true }))
        .responseBody.unavailable
    )
    const failures = await data('browser_network', { failed: true })
    assert(failures.requests.some((r: any) => r.status === 404))
    assert(failures.requests.some((r: any) => r.url.endsWith('/broken') && r.error))

    console.log('Browser DevTools: native frontend, picker and capture recovery')
    const page = webContents.getAllWebContents().find((wc) => wc.getURL() === base + '/')!
    await browser.toggleDevTools(key)
    assert(page.isDevToolsOpened(), 'Native DevTools opens for the page')
    const frontend = page.devToolsWebContents!
    assert(
      await frontend.executeJavaScript(`(async () => {
      const UI = await import('./ui/legacy/legacy.js');
      return ['console', 'elements', 'network', 'sources', 'timeline'].every(
        name => UI.InspectorView.InspectorView.instance().hasPanel(name)
      );
    })()`)
    )
    assert(
      !(await data('browser_network')).attached,
      'Agent capture reports native frontend ownership'
    )
    assert((await data('browser_network')).unavailable.includes('developer tools'))
    await browser.inspectElement(key)
    await eventually(async () =>
      frontend.executeJavaScript(`(async () => {
      const UI = await import('./ui/legacy/legacy.js');
      return UI.ActionRegistry.ActionRegistry.instance().getAction('elements.toggle-element-search').toggled();
    })()`)
    )
    await frontend.executeJavaScript(`DevToolsAPI.showPanel('network')`)
    await page.executeJavaScript(`fetch('/api?native-network').then(r => r.json())`)
    await eventually(async () =>
      frontend.executeJavaScript(`(async () => {
      const Logs = await import('./models/logs/logs.js');
      return Logs.NetworkLog.NetworkLog.instance().requests().some(r => r.url().includes('native-network'));
    })()`)
    )
    await browser.toggleDevTools(key)
    await eventually(async () => {
      await browser.inspector(firstTab, key).inspector.ready
      return (await data('browser_network')).attached
    })
    assert((await data('browser_network')).captureGap)
    assert.equal(browser.currentUrl(key), base + '/', 'Reattachment never navigates the page')
    assert.equal((await evaluate('window.fixtureReady')).answer, 42)
    await evaluate(`fetch('/api?after-devtools').then(r => r.json())`)
    await eventually(async () =>
      (await data('browser_network', { url: 'after-devtools' })).requests.some(
        (r: any) => r.finished
      )
    )
    const buildMenu = Menu.buildFromTemplate
    let pageMenu: Electron.Menu | undefined
    try {
      Menu.buildFromTemplate = (template) => {
        pageMenu = buildMenu(template)
        pageMenu.popup = () => undefined
        return pageMenu
      }
      page.emit(
        'context-menu',
        {},
        {
          x: 20,
          y: 20,
          isEditable: false,
          selectionText: '',
          linkURL: '',
          editFlags: {},
          formControlType: ''
        }
      )
    } finally {
      Menu.buildFromTemplate = buildMenu
    }
    assert(pageMenu, 'Blank-page right-click offers debugging actions')
    const inspectItem = pageMenu.items.find((item) => item.label === 'Inspect element')!
    assert(inspectItem)
    inspectItem.click(undefined, undefined, {})
    await eventually(() => page.isDevToolsOpened())
    await browser.toggleDevTools(key)
    await eventually(() => !page.isDevToolsOpened())
    await browser.inspector(firstTab, key).inspector.ready
    const shortcut = async (wc: Electron.WebContents, key: string): Promise<void> => {
      wc.focus()
      const modifiers =
        key === 'F12' ? [] : process.platform === 'darwin' ? ['meta', 'alt'] : ['control', 'shift']
      wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
      wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    }
    await shortcut(page, 'j')
    await eventually(() => page.isDevToolsOpened())
    await eventually(async () =>
      page.devToolsWebContents!.executeJavaScript(`(async () => {
      const UI = await import('./ui/legacy/legacy.js');
      return UI.InspectorView.InspectorView.instance().tabbedPane.selectedTabId === 'console';
    })()`)
    )
    await shortcut(page, 'F12')
    await eventually(() => !page.isDevToolsOpened())
    await browser.inspector(firstTab, key).inspector.ready

    browser.newTab(base + '/second', key)
    const secondTab = browser.listTabs(key).find((t) => t.active)!.id
    await eventually(() => browser.currentUrl(key) === base + '/second')
    await evaluate('window.fixtureReady')
    const secondPage = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL() === base + '/second')!
    const chrome = BrowserWindow.fromBrowserView(
      BrowserWindow.getAllWindows()
        .flatMap((w) => w.getBrowserViews())
        .find((v) => v.webContents === secondPage)!
    )!.webContents
    await shortcut(chrome, 'i')
    await eventually(() => secondPage.isDevToolsOpened())
    assert(!page.isDevToolsOpened(), 'Chrome shortcut debugs only the active tab')
    assert(!chrome.isDevToolsOpened(), 'Global dev shortcuts never inspect browser chrome')
    browser.activateTab(firstTab, key)
    assert(!page.isDevToolsOpened(), 'Switching tabs never retargets an existing frontend')
    assert(secondPage.isDevToolsOpened())
    browser.activateTab(secondTab, key)
    await browser.toggleDevTools(key)
    await eventually(() => !secondPage.isDevToolsOpened())
    await browser.inspector(secondTab, key).inspector.ready
    await shortcut(chrome, 'F12')
    await eventually(() => secondPage.isDevToolsOpened())
    assert(!chrome.isDevToolsOpened(), 'F12 targets the page even from the URL bar')
    await shortcut(chrome, 'F12')
    await eventually(() => !secondPage.isDevToolsOpened())
    await browser.inspector(secondTab, key).inspector.ready
    assert(!(await data('browser_network')).requests.some((r: any) => r.url === base + '/'))
    assert(
      (await data('browser_network', { tabId: firstTab })).requests.some(
        (r: any) => r.url === base + '/'
      )
    )
    assert(!(await call('browser_network_request', { id: post.id })).ok)
    await evaluate(`console.log('first-tab-only')`, firstTab)
    assert(!(await call('browser_console')).output.includes('first-tab-only'))
    assert((await call('browser_console', { tabId: firstTab })).output.includes('first-tab-only'))
    assert((await call('browser_open', { url: base + '/other' }, 'devtools-chat-b')).ok)
    assert(
      !(await data('browser_network', {}, 'devtools-chat-b')).requests.some(
        (r: any) => r.url === base + '/second'
      )
    )
    browser.newTab(base + '/manual')
    assert.equal(browser.listTabs().length, 1, 'Cold newTab creates only one tab')
    await eventually(() => browser.currentUrl() === base + '/manual')
    assert(!(await data('browser_network')).requests.some((r: any) => r.url.endsWith('/manual')))
    assert(!(await call('browser_network', { tabId: 'missing-tab' })).ok)
    await data('browser_devtools', { method: 'Debugger.enable' })
    console.log('Browser DevTools: debugger, profiling and retention')
    const pausedEvaluation = data('browser_evaluate', {
      expression: '(() => { const localValue = 23; debugger; return localValue })()'
    })
    let paused: any
    try {
      await eventually(async () => {
        paused = (await data('browser_debug_events')).paused
        return !!paused
      })
      const local = await data('browser_devtools', {
        method: 'Debugger.evaluateOnCallFrame',
        params: {
          callFrameId: paused.callFrames[0].callFrameId,
          expression: 'localValue',
          returnByValue: true
        }
      })
      assert.equal(local.result.value, 23)
    } finally {
      await data('browser_devtools', { method: 'Debugger.resume' })
    }
    assert.equal((await pausedEvaluation).result.value, 23)
    await data('browser_devtools', { method: 'Debugger.disable' })
    await data('browser_devtools', { method: 'Profiler.enable' })
    await data('browser_devtools', { method: 'Profiler.start' })
    await evaluate('Array.from({length: 10000}, (_, i) => Math.sqrt(i)).length')
    const profile = await data('browser_devtools', { method: 'Profiler.stop' })
    assert(profile.profile.nodes.length > 0)

    const controller = new AbortController()
    controller.abort()
    const stopped = await runTool(
      'browser_evaluate',
      { expression: 'window.shouldNotRun = true' },
      { cwd: root, sessionId: key, signal: controller.signal }
    )
    assert(!stopped.ok && stopped.output.includes('Cancellation'))
    assert.equal(await evaluate('!!window.shouldNotRun'), false)
    await evaluate(
      'Promise.all(Array.from({length: 310}, (_, i) => fetch("/api?overflow=" + i).then(r => r.text())))'
    )
    const overflow = await data('browser_network', { limit: 100 })
    assert.equal(overflow.total, 300)
    assert(overflow.retention.droppedRequests > 0)
    await evaluate('for (let i = 0; i < 310; i++) console.log("event-overflow", i)')
    assert((await data('browser_debug_events')).retention.droppedEvents > 0)
    const held = browser.inspector(secondTab, key).inspector
    await browser.toggleDevTools(key)
    const closingFrontend = secondPage.devToolsWebContents!
    browser.closeTab(secondTab, key)
    await eventually(() => closingFrontend.isDestroyed())
    await assert.rejects(held.command('Performance.getMetrics'), /closed/)
    browser.close(key)
    await eventually(() => browser.listTabs(key).length === 0)
    assert((await call('browser_open', { url: base + '/fresh' })).ok)
    assert(!(await data('browser_network')).requests.some((r: any) => r.url.includes('overflow')))
    const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === base + '/fresh')!
    contents.debugger.detach()
    const detached = await data('browser_network')
    assert(!detached.attached && detached.unavailable.includes('detached'))
    assert(!(await call('browser_evaluate', { expression: '1' })).ok)
    console.log('BROWSER DEVTOOLS OK')
  } finally {
    browser.closeAll()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    closeDb()
    await sleep(100)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

const watchdog = setTimeout(() => {
  console.error('Browser DevTools smoke timed out')
  app.exit(1)
}, 90_000)
void main()
  .then(() => {
    clearTimeout(watchdog)
    app.exit(0)
  })
  .catch((error) => {
    clearTimeout(watchdog)
    console.error(error)
    app.exit(1)
  })
