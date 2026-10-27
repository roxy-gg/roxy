const assert = require('node:assert/strict')
const { app, BrowserWindow, ipcMain, desktopCapturer, nativeImage, screen } = require('electron')
const { build } = require('esbuild')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { resolve, join } = require('node:path')
const exec = promisify(execFile)
let owner,
  service,
  snapshots = 0
const handlers = new Map()
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (probe) => {
  for (let n = 0; n < 150; n++) {
    const result = await probe()
    if (result) return result
    await wait()
  }
  throw Error('Timed out waiting for native capture')
}
const evaluate = (window, code) =>
  window.webContents.executeJavaScript(`(async()=>{${code}})()`, true)
const move = (point) => {
  const p = screen.dipToScreenPoint(point)
  return `[NativeMouse]::SetCursorPos(${p.x},${p.y}) | Out-Null`
}
const native = async (script) => {
  const command = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NativeMouse { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,int data,UIntPtr extra); [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra); }'; [NativeMouse]::SetProcessDPIAware() | Out-Null; ${script}`
  await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')
    ],
    { windowsHide: true }
  )
}
const click = async (point) =>
  native(
    `${move(point)}; Start-Sleep -Milliseconds 60; ${move(point)};[NativeMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 40;${move(point)};[NativeMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`
  )
const drag = async (from, to, ctrl = true, releaseEarly = false, armDelay = 80) =>
  native(
    `${move(from)};Start-Sleep -Milliseconds 120;${ctrl ? `[NativeMouse]::keybd_event(17,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds ${armDelay};` : ''}[NativeMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 120;${move(to)};Start-Sleep -Milliseconds 120;${releaseEarly ? '[NativeMouse]::keybd_event(17,0,2,[UIntPtr]::Zero);Start-Sleep -Milliseconds 100;[NativeMouse]::keybd_event(17,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 100;' : ''}[NativeMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero);${ctrl ? '[NativeMouse]::keybd_event(17,0,2,[UIntPtr]::Zero);' : ''}`
  )
const controlPoint = async (window, selector) => {
  const b = window.getBounds()
  const r = await evaluate(
    window,
    `const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}`
  )
  return { x: Math.round(b.x + r.x), y: Math.round(b.y + r.y) }
}
app
  .whenReady()
  .then(async () => {
    if (process.platform !== 'win32') {
      console.log('Native pointer smoke currently targets Windows')
      app.exit(0)
      return
    }
    const directory = resolve('out')
    global.__narreteLive = {
      ...require('electron'),
      desktopCapturer: {
        getSources: async (options) => {
          snapshots++
          return desktopCapturer.getSources(options)
        }
      },
      ipcMain: {
        handle: (name, callback) => {
          handlers.set(name, callback)
          ipcMain.handle(name, callback)
        }
      },
      BrowserWindow: class extends BrowserWindow {
        constructor(options) {
          super(options)
          this.webContents.on('console-message', (_event, level, message) => {
            if (level >= 2) console.log('OVERLAY:', message)
          })
          this.webContents.on('preload-error', (_event, path, error) =>
            console.error('PRELOAD', path, error)
          )
        }
      }
    }
    await build({
      entryPoints: ['src/main/services/narrete.ts'],
      outfile: join(directory, 'main/narrete-live.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      plugins: [
        {
          name: 'boundaries',
          setup(plugin) {
            plugin.onResolve({ filter: /^electron$|^\.\.\/db\/repo$/ }, (args) => ({
              path: args.path === 'electron' ? 'electron' : 'repo',
              namespace: 'mock'
            }))
            plugin.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
              contents:
                args.path === 'electron'
                  ? 'module.exports=global.__narreteLive'
                  : 'exports.getSettings=()=>({narreteEnabled:true,language:"en"});exports.getChat=id=>id==="original"?{id}:null;exports.setNarreteEnabled=()=>({narreteEnabled:true})'
            }))
          }
        }
      ]
    })
    service = require(join(directory, 'main/narrete-live.cjs'))
    ipcMain.handle('voice:state', () => ({
      settings: { enabled: false, modelId: null },
      supported: true,
      installed: [],
      download: null,
      error: null
    }))
    owner = new BrowserWindow({
      x: 40,
      y: 80,
      width: 900,
      height: 700,
      show: true,
      alwaysOnTop: true
    })
    await owner.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<html><body style="background:#164566;color:white;height:2000px;margin:0"><button style="position:absolute;left:100px;top:100px;width:200px;height:60px" onclick="window.clicks++">Click through</button><input id="input" style="position:absolute;left:100px;top:200px;width:200px;height:40px"><div id="text" style="position:fixed;left:350px;top:330px;width:350px;font:24px/36px sans-serif">Selectable text to capture.<br>Dragging normally selects.<br>Ctrl dragging must not.<br>Keep the screenshot clean.<br>No highlighted text here.<br>Capture only this region.</div><script>window.clicks=0;window.wheels=0;window.downs=0;window.dragStarts=0;addEventListener("wheel",()=>window.wheels++);addEventListener("mousedown",()=>window.downs++);addEventListener("dragstart",()=>window.dragStarts++)</script></body></html>'
        )
    )
    // Production requires the main app URL; only the test owner's URL is projected.
    const realGetURL = owner.webContents.getURL.bind(owner.webContents)
    owner.webContents.getURL = () =>
      require('node:url').pathToFileURL(join(directory, 'renderer/index.html')).href
    service.setNarreteWindow(owner)
    service.registerNarreteIpc()
    owner.focus()
    await wait(300)
    const baseline = owner.getContentBounds()
    await evaluate(
      owner,
      `addEventListener('mousedown',e=>window.lastClick={x:e.clientX,y:e.clientY,target:e.target.tagName})`
    )
    await click({ x: baseline.x + 150, y: baseline.y + 130 })
    await until(() => evaluate(owner, 'return window.clicks > 0'))
    await evaluate(owner, 'window.clicks=0')
    const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame }
    const capture = handlers.get('narrete:start')(event, 'native', 'original')
    const overlay = await until(async () => {
      const w = BrowserWindow.getAllWindows().find((w) => w !== owner && w.isVisible())
      return w && (await evaluate(w, `return !!document.querySelector('[data-narrete-overlay]')`))
        ? w
        : null
    })
    await wait(300)
    assert.equal(snapshots, 0, 'Arming does not take a screenshot')
    assert.deepEqual(await evaluate(overlay, `return Object.keys(window.roxy)`), ['voice'])
    assert.equal(await evaluate(overlay, `return typeof window.electron`), 'undefined')
    const client = owner.getContentBounds()
    await click({ x: client.x + 150, y: client.y + 130 })
    await until(() => evaluate(owner, 'return window.clicks > 0'))
    await click({ x: client.x + 150, y: client.y + 220 })
    await native(
      '[NativeMouse]::keybd_event(65,0,0,[UIntPtr]::Zero);[NativeMouse]::keybd_event(65,0,2,[UIntPtr]::Zero);[NativeMouse]::mouse_event(2048,0,0,-120,[UIntPtr]::Zero)'
    )
    assert.equal(
      (await evaluate(owner, `return document.querySelector('#input').value`)).toLowerCase(),
      'a',
      'Keyboard remains in underlying app'
    )
    assert(await evaluate(owner, 'return window.wheels>0'), 'OS wheel reaches underlying app')
    const from = { x: client.x + 350, y: client.y + 350 },
      to = { x: client.x + 650, y: client.y + 550 }
    await drag(from, { x: from.x + 8, y: from.y + 8 })
    await drag(from, to, false)
    assert(
      await evaluate(owner, 'return getSelection().toString().length > 0'),
      'Ordinary native dragging still selects underlying text'
    )
    await evaluate(owner, 'getSelection().removeAllRanges();window.downs=0;window.dragStarts=0')
    await drag(from, to, true, true)
    assert.equal(
      await evaluate(owner, 'return window.downs'),
      0,
      'Cancelled Ctrl drag never leaks a press'
    )
    assert.equal(await evaluate(owner, 'return getSelection().toString()'), '')
    assert.equal(
      snapshots,
      0,
      'Tiny Ctrl-drags, ordinary dragging and released/re-pressed Ctrl do not capture'
    )
    assert.equal(
      await evaluate(overlay, `return !!document.querySelector('[data-narrete-region]')`),
      false,
      'Releasing Ctrl removes the outline immediately'
    )
    await drag(from, to)
    await until(() => evaluate(overlay, `return !!document.querySelector('#narrete-note')`))
    assert.equal(snapshots, 1)
    assert.equal(
      await evaluate(owner, 'return getSelection().toString()'),
      '',
      'Capture cannot highlight underlying text'
    )
    assert.equal(
      await evaluate(owner, 'return window.downs'),
      0,
      'Capture press is intercepted before reaching underlying app'
    )
    assert.equal(
      await evaluate(owner, 'return window.dragStarts'),
      0,
      'Capture cannot start native content dragging'
    )
    await until(() =>
      evaluate(overlay, `return document.querySelector('[data-narrete-preview]')?.naturalWidth > 0`)
    )
    const preview = await evaluate(
      overlay,
      `return document.querySelector('[data-narrete-preview]').src`
    )
    assert.equal(
      await evaluate(
        overlay,
        `const image=document.querySelector('[data-narrete-preview]');return image.getBoundingClientRect().bottom <= document.querySelector('#narrete-note').getBoundingClientRect().top && image.draggable === false`
      ),
      true,
      'Current region preview sits above the note'
    )
    assert.equal(await evaluate(overlay, 'return document.activeElement.id'), 'narrete-note')
    assert.equal(
      await evaluate(
        overlay,
        `const overlay=document.querySelector('[data-narrete-overlay]');return overlay.children.length === 1 && overlay.firstElementChild.getAttribute('role') === 'dialog'`
      ),
      true,
      'Only the feedback widget appears over the desktop'
    )
    const transparency = await require('sharp')((await overlay.webContents.capturePage()).toPNG())
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    assert.equal(transparency.data[3], 0, 'No full-screen screenshot or tint behind the widget')
    const clicksBefore = await evaluate(owner, 'return window.clicks')
    await evaluate(owner, `scrollTo(0,0)`)
    await click({ x: client.x + 150, y: client.y + 130 })
    assert.equal(
      await evaluate(owner, 'return window.clicks'),
      clicksBefore + 1,
      'Desktop remains clickable while the widget is open'
    )
    assert.equal(
      await evaluate(overlay, `return !!document.querySelector('#narrete-note')`),
      true,
      'Clicking outside preserves the widget'
    )
    await click(await controlPoint(overlay, '#narrete-note'))
    await evaluate(
      overlay,
      `const el=document.querySelector('#narrete-note');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'First native region');el.dispatchEvent(new Event('input',{bubbles:true}))`
    )
    await click(await controlPoint(overlay, '[aria-label="Add & next"]'))
    await until(() =>
      evaluate(
        overlay,
        `return !document.querySelector('#narrete-note') && !!document.querySelector('[data-narrete-saved-bar]')`
      )
    )
    assert.equal(snapshots, 1, 'Next returns live without screenshot')
    assert.equal(
      await evaluate(overlay, `return document.querySelector('[data-narrete-sequence] img').src`),
      preview,
      'Saved crop matches preview exactly'
    )
    await click({ x: client.x + 150, y: client.y + 130 })
    // Scroll may move the underlying button. Focus and typing still remain live.
    await evaluate(owner, 'getSelection().removeAllRanges();window.downs=0;window.dragStarts=0')
    await drag(from, to, true, false, 5)
    await until(() => evaluate(overlay, `return !!document.querySelector('#narrete-note')`))
    assert.equal(await evaluate(owner, 'return getSelection().toString()'), '')
    assert.equal(
      await evaluate(owner, 'return window.downs'),
      0,
      'Fast Ctrl-then-drag still intercepts before mouse-down'
    )
    await evaluate(
      overlay,
      `const el=document.querySelector('#narrete-note');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Second native region');el.dispatchEvent(new Event('input',{bubbles:true}))`
    )
    await click(await controlPoint(overlay, '[aria-label="Add & next"]'))
    await until(() =>
      evaluate(
        overlay,
        `return document.querySelector('[data-narrete-saved-bar] [role="status"]')?.textContent==='2 saved'`
      )
    )
    await click(await controlPoint(overlay, '[aria-label="Add to prompt"]'))
    const result = await Promise.race([
      capture,
      new Promise((_, reject) => setTimeout(() => reject(Error('Completion hung')), 12000))
    ])
    assert.equal(result.ok, true)
    assert.equal(result.text, '1. First native region\n\n2. Second native region')
    assert(!nativeImage.createFromDataURL(result.image.dataUrl).isEmpty())
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    assert.equal(service.isNarreteCapturing(), false)
    const cancelled = handlers.get('narrete:start')(event, 'escape', 'original')
    await until(async () => {
      const w = BrowserWindow.getAllWindows().find((w) => w !== owner && w.isVisible())
      return w && (await evaluate(w, `return !!document.querySelector('[data-narrete-overlay]')`))
    })
    await native(
      '[NativeMouse]::keybd_event(27,0,0,[UIntPtr]::Zero);[NativeMouse]::keybd_event(27,0,2,[UIntPtr]::Zero)'
    )
    assert.equal((await cancelled).error, 'cancelled')
    assert.equal(service.isNarreteCapturing(), false)
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    owner.webContents.getURL = realGetURL
    console.log(
      'NARRETE LIVE OK: Ctrl-drag without underlying text selection or content dragging, ordinary text selection, early Ctrl cancellation, visible crop preview, native Add & next, draft append and cleanup'
    )
    owner.destroy()
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    BrowserWindow.getAllWindows().forEach((w) => w.destroy())
    app.exit(1)
  })
