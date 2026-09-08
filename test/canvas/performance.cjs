const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const assert = require('node:assert/strict')
const temp = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'roxy-canvas-perf-'))
app.setPath('userData', temp)
app.commandLine.appendSwitch('disable-renderer-backgrounding')
let server, win
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => app.exit(2), 120000)
  let code = 0
  try {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { port: 3114, strictPort: true }
    })
    await server.listen()
    console.log('Performance harness: Vite ready')
    win = new BrowserWindow({
      width: 1280,
      height: 840,
      show: true,
      webPreferences: { backgroundThrottling: false }
    })
    win.webContents.on('render-process-gone', (_event, details) =>
      console.error('Renderer exited', details)
    )
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) console.error(message)
    })
    await win.loadURL(
      `http://localhost:3114/?performance&scale=${process.env.CANVAS_PERF_SCALE || 1}`
    )
    console.log('Performance harness: loaded')
    win.focus()
    await wait(800)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Profiler.enable')
    await win.webContents.debugger.sendCommand('Profiler.start')
    const results = []
    for (const session of ['main', 'agent', 'main', 'agent']) {
      console.log('Switching', session)
      await win.webContents.executeJavaScript(
        `document.querySelector('#perf-${session}').click()`,
        true
      )
      await wait(200)
      results.push(
        await win.webContents
          .executeJavaScript(`(() => {const p=window.__canvasTranscript; const s=p.scene();const el=document.querySelector('[data-canvas-surface]');return {
        session:${JSON.stringify(session)}, switchMs:p.debug.firstPaint.at-window.__switchStarted, layoutMs:p.debug.layoutMs,
        paintMs:p.debug.paintMs, layouts:p.debug.layouts, blocks:s.blocks.length,
        nodes:s.blocks.reduce((n,b)=>n+b.nodes.length,0), lines:s.blocks.reduce((n,b)=>n+b.selectable.length,0),
        mirrorBytes:el.querySelector('.sr-only').textContent.length, bottom:Math.abs(el.scrollTop-el.scrollHeight+el.clientHeight)<2,
        measured:s.blocks.filter(b=>b.nodes.length>0).length
      }} )()`)
      )
    }
    for (const result of results) {
      assert.ok(
        result.switchMs < 500,
        `Slow ${result.session} switch: ${result.switchMs.toFixed(1)}ms`
      )
      assert.ok(result.lines < 500, 'Opening measured too many offscreen text rows')
      assert.ok(result.mirrorBytes < 20000, 'Accessibility mirror grew with hidden tool payloads')
      assert.ok(result.bottom, 'Opening lost the last message')
    }
    const inspect = (code) =>
      win.webContents.executeJavaScript(
        `(() => {const p=window.__canvasTranscript;const s=p.scene();const el=document.querySelector('[data-canvas-surface]');${code}})()`
      )
    await inspect('el.scrollTop=0')
    await wait(80)
    assert.ok(
      await inspect(
        `return s.blocks.flatMap(b=>b.selectable).some(l=>l.text.includes('Investigation 0_0'))`
      ),
      'First step is unreachable'
    )
    await inspect('el.scrollTop=el.scrollHeight/2')
    await wait(80)
    assert.ok(
      await inspect(
        'return s.window.start<=el.scrollTop && s.window.end>=el.scrollTop+el.clientHeight'
      ),
      'Middle viewport is not materialized'
    )
    await inspect('el.scrollTop=el.scrollHeight')
    await wait(80)
    await win.webContents.executeJavaScript(`document.querySelector('#perf-update').click()`, true)
    await wait(80)
    assert.ok(
      await inspect(
        `return s.blocks.flatMap(b=>b.selectable).some(l=>l.text.includes('fresh final result'))`
      ),
      'Cache hid an updated agent answer'
    )
    const copyLength = await inspect('return s.copyText().length')
    assert.ok(copyLength > 1000000, 'Source/copy lost unmeasured history')
    // Exercise the actual Select All/Copy handlers, not just the retained source getter.
    await win.webContents
      .executeJavaScript(`(() => {const el=document.querySelector('[data-canvas-surface]');el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true}));
      el.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true,cancelable:true}));})()`)
    await wait(30)
    assert.ok(
      await win.webContents.executeJavaScript(
        `window.__canvasTest.copied.at(-1).includes('Investigation 0_0') && window.__canvasTest.copied.at(-1).includes('fresh final result')`
      ),
      'Select All only copied the visible page'
    )
    const { profile } = await win.webContents.debugger.sendCommand('Profiler.stop')
    const counts = new Map()
    profile.samples.forEach((sample, i) =>
      counts.set(sample, (counts.get(sample) ?? 0) + (profile.timeDeltas[i] ?? 0))
    )
    const hot = profile.nodes
      .map((node) => ({
        fn: node.callFrame.functionName,
        file: node.callFrame.url.split('/').pop(),
        ms: Math.round((counts.get(node.id) ?? 0) / 1000)
      }))
      .filter((node) => node.ms > 0)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 15)
    console.log(JSON.stringify({ results, hot }, null, 2))
    await fs.mkdir(path.join(__dirname, '../.out'), { recursive: true })
    await fs.writeFile(
      path.join(__dirname, '../.out/canvas-perf.json'),
      JSON.stringify({ results, hot }, null, 2)
    )
    await fs.writeFile(path.join(__dirname, '../.out/canvas.cpuprofile'), JSON.stringify(profile))
  } catch (error) {
    console.error(error)
    code = 1
  }
  clearTimeout(watchdog)
  win?.destroy()
  await server?.close()
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  app.exit(code)
})
