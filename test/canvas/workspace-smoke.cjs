const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roxy-workspace-ui-'))
app.setPath('userData', temp)
let win
const errors = []
const wait = () => new Promise((resolve) => setTimeout(resolve, 80))
const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
async function until(code) {
  for (let n = 0; n < 100; n++) {
    if (await evaluate(`return ${code}`)) return
    await wait()
  }
  console.error(
    await evaluate(
      'const el=document.querySelector("[data-workspace-canvas] [data-canvas-surface]");return {top:el?.scrollTop,height:el?.scrollHeight,text:el?.textContent?.slice(0,400),window:window.__canvasTranscript?.scene().window}'
    )
  )
  throw Error(`Timed out: ${code}`)
}
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait()
}
async function key(keyCode) {
  win.focus()
  win.webContents.focus()
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  await wait()
}
async function screenshot(name) {
  const directory = path.resolve('test/.out/workspace')
  fs.mkdirSync(directory, { recursive: true })
  await evaluate('await document.fonts.ready')
  fs.writeFileSync(
    path.join(directory, name + '.png'),
    (await win.webContents.capturePage()).toPNG()
  )
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: 'rgba(1, 0, 0, 0)', symbolColor: '#9a9aa3', height: 48 },
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) errors.push(message)
    })
    await win.loadURL(`${process.env.CANVAS_TEST_URL || 'http://localhost:3101/'}?workspace`)
    await until(`document.querySelector('[data-workspace-toggle]')?.textContent.includes('+126')`)
    assert.equal(await evaluate(`return !!document.querySelector('#workspace-inspector')`), false)
    await evaluate(
      `window.__chatCanvas = document.querySelector('[data-canvas-surface]'); const el = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Preserve my draft'); el.dispatchEvent(new Event('input', {bubbles:true}));`
    )
    await screenshot('closed')
    await evaluate(
      'if (!window.__originalInspect) { window.__originalInspect = window.roxy.workspace.inspect; window.roxy.workspace.inspect = async (...args) => structuredClone(await window.__originalInspect(...args)); }'
    )
    await click('[data-workspace-toggle]')
    await until(`!!document.querySelector('#workspace-inspector section button')`)
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('#workspace-inspector')).position`
      ),
      'relative'
    )
    assert(
      await evaluate(
        `return window.__chatCanvas === document.querySelector('[data-canvas-surface]')`
      )
    )
    assert(
      await evaluate(
        `const panel = document.querySelector('#workspace-inspector').getBoundingClientRect(); const sidebar = document.querySelector('[data-sidebar-frame]').getBoundingClientRect(); return panel.top === 0 && panel.bottom === innerHeight && sidebar.top === 0 && sidebar.bottom === innerHeight`
      )
    )
    assert.equal(
      await evaluate(`return document.body.textContent.includes('Read-only preview')`),
      false
    )
    await evaluate(`document.documentElement.dataset.platform = 'win32'`)
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('header.reserve-controls-right')).paddingRight`
      ),
      '16px'
    )
    for (const platform of ['win32', 'darwin']) {
      await evaluate(`document.documentElement.dataset.platform = '${platform}'`)
      assert(
        await evaluate(
          `const toolbar = document.querySelector('.workspace-toolbar'); const panel = document.querySelector('#workspace-inspector'); const box = toolbar.getBoundingClientRect(); const controls = [...toolbar.querySelectorAll('button')].map(node => node.getBoundingClientRect()); const reserved = parseFloat(getComputedStyle(toolbar).paddingRight); return box.top === 0 && box.height === 48 && panel.getBoundingClientRect().bottom === innerHeight && controls.every(control => control.top >= 0 && control.bottom <= 48 && control.right <= box.right - reserved + 1) && controls.every((control, index) => !index || control.left >= controls[index-1].right)`
        ),
        platform + ' toolbar controls fit one row'
      )
      assert.equal(
        await evaluate(
          `return getComputedStyle(document.querySelector('.workspace-toolbar')).paddingRight`
        ),
        platform === 'win32' ? '144px' : '8px'
      )
      assert.equal(
        await evaluate(`return !!document.querySelector('.workspace-window-controls')`),
        false
      )
      await screenshot('titlebar-' + platform)
    }
    await evaluate(`delete document.documentElement.dataset.platform`)
    const originalWidth = await evaluate(
      'return document.querySelector("#workspace-inspector").getBoundingClientRect().width'
    )
    const edge = await evaluate(
      'const r=document.querySelector("#workspace-inspector [role=separator]").getBoundingClientRect(); return {x:Math.round(r.left+2),y:150}'
    )
    win.focus()
    win.webContents.focus()
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...edge
    })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...edge,
      button: 'left',
      buttons: 1,
      clickCount: 1
    })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: edge.x - 80,
      y: edge.y,
      button: 'left',
      buttons: 1
    })
    await wait()
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: edge.x - 80,
      y: edge.y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    })
    win.webContents.debugger.detach()
    await until(
      'document.querySelector("#workspace-inspector").getBoundingClientRect().width > ' +
        originalWidth
    )
    await until('document.body.style.cursor !== "col-resize"')
    await evaluate('document.querySelector("#workspace-inspector [role=separator]").focus()')
    await key('Home')
    await until(
      'document.querySelector("#workspace-inspector").getBoundingClientRect().width === 320'
    )
    await key('Left')
    await until(
      'document.querySelector("#workspace-inspector").getBoundingClientRect().width === 330'
    )
    await click('[aria-label="Close files and changes"]')
    await click('[data-workspace-toggle]')
    await until(
      'document.querySelector("#workspace-inspector").getBoundingClientRect().width === 330'
    )
    await evaluate(
      'document.querySelector("#workspace-inspector [role=separator]").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))'
    )
    await screenshot('changes')
    await click('#workspace-inspector section button')
    await until(`document.querySelectorAll('[data-canvas-surface]').length === 2`)
    for (const platform of ['win32', 'darwin']) {
      await evaluate(`document.documentElement.dataset.platform = '${platform}'`)
      assert.equal(
        await evaluate(
          `return getComputedStyle(document.querySelector('.workspace-file-toolbar')).paddingRight`
        ),
        platform === 'win32' ? '16px' : '12px'
      )
      await screenshot('file-full-height-' + platform)
    }
    await evaluate(`delete document.documentElement.dataset.platform`)
    assert(
      await evaluate(
        `const main = document.querySelector('[data-workspace-canvas]'); const panel = document.querySelector('#workspace-inspector'); const box = main.getBoundingClientRect(); const header = document.querySelector('header.reserve-controls-right'); const hit = document.elementFromPoint(box.left + 80, 24); return main.textContent.includes('ChatView.tsx') && !panel.querySelector('[data-canvas-surface]') && panel.querySelectorAll('section button').length === 4 && box.right <= panel.getBoundingClientRect().left && box.top === 0 && box.bottom === innerHeight && header.hasAttribute('inert') && main.contains(hit)`
      )
    )
    await screenshot('diff')
    await evaluate(
      `document.querySelector('[data-workspace-canvas] [data-canvas-surface]').focus()`
    )
    await key('Escape')
    assert.equal(
      await evaluate(`return !!document.querySelector('[data-workspace-canvas]')`),
      false
    )
    assert.equal(
      await evaluate(`return !!document.querySelector('textarea').closest('[inert]')`),
      false
    )
    await click('#inspector-tab-files')
    await until(`!!document.querySelector('#workspace-inspector button[title="src"]')`)
    await click('#workspace-inspector button[title="src"]')
    await until(`!!document.querySelector('#workspace-inspector button[title="src/renderer"]')`)
    assert.equal(
      await evaluate(`return !!document.querySelector('[aria-label="Refresh files and changes"]')`),
      false
    )
    await evaluate(`window.__originalList = window.roxy.workspace.list;
      window.roxy.workspace.list = async (...args) => {
        const result = await window.__originalList(...args);
        if (args[2] === 'src') result.entries.push({name:'auto.txt',path:'src/auto.txt',kind:'file'});
        return result;
      };
      window.dispatchEvent(new Event('focus'));`)
    await until(`!!document.querySelector('#workspace-inspector button[title="src/auto.txt"]')`)
    await evaluate('window.roxy.workspace.list = window.__originalList')
    await until(`!!document.querySelector('#workspace-inspector button[title="src/renderer"]')`)
    await screenshot('files')
    await click('#workspace-inspector button[title="package.json"]')
    await until(
      `document.querySelector('[data-workspace-canvas] [data-canvas-surface]')?.textContent.includes('roxy')`
    )
    assert(
      await evaluate(
        `return document.querySelector('textarea').closest('[inert]') !== null && !document.querySelector('#workspace-inspector [data-canvas-surface]')`
      )
    )
    await screenshot('file-canvas')
    await click('[aria-label="Copy file contents"]')
    assert(await evaluate(`return window.__canvasTest.copied.some(text => text.includes('roxy'))`))
    await click('[aria-label="Back to chat"]')
    assert.equal(
      await evaluate('return document.activeElement.hasAttribute("data-workspace-toggle")'),
      true
    )
    await evaluate(`document.querySelector('#inspector-tab-files').focus()`)
    await key('Left')
    assert.equal(await evaluate(`return document.activeElement.id`), 'inspector-tab-changes')
    for (const width of [1100, 760, 480]) {
      win.setContentSize(width, 720)
      await wait()
      if (width === 480) {
        await click('[title="Collapse sidebar"]')
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      assert(
        await evaluate(`return document.documentElement.scrollWidth <= innerWidth`),
        `no overflow at ${width}`
      )
      assert.equal(
        await evaluate(
          `return getComputedStyle(document.querySelector('#workspace-inspector')).position`
        ),
        'absolute'
      )
      const box = await evaluate(
        `const r = document.querySelector('#workspace-inspector').getBoundingClientRect(); return {right:r.right,left:r.left,width:r.width}`
      )
      assert(box.left >= 0 && box.right <= width && box.width <= 640)
      await screenshot('overlay-' + width)
      for (const platform of ['win32', 'darwin']) {
        await evaluate(`document.documentElement.dataset.platform = '${platform}'`)
        assert(
          await evaluate(
            `const toolbar = document.querySelector('.workspace-toolbar'); const box = toolbar.getBoundingClientRect(); const controls = [...toolbar.querySelectorAll('button')].map(node => node.getBoundingClientRect()); return box.top === 0 && controls.every(control => control.top >= 0 && control.bottom <= 48 && control.right <= box.right - parseFloat(getComputedStyle(toolbar).paddingRight) + 1) && controls.every((control, index) => !index || control.left >= controls[index-1].right)`
          ),
          platform + ' explorer toolbar at ' + width
        )
      }
      await evaluate(`delete document.documentElement.dataset.platform`)
      await click('#workspace-inspector section button')
      await until(`!!document.querySelector('[data-workspace-canvas] [data-canvas-surface]')`)
      for (const platform of ['win32', 'darwin']) {
        await evaluate(`document.documentElement.dataset.platform = '${platform}'`)
        assert.equal(
          await evaluate(
            `return document.querySelector('[data-workspace-canvas]').getBoundingClientRect().top`
          ),
          0
        )
        assert.equal(
          await evaluate(
            `return getComputedStyle(document.querySelector('.workspace-file-toolbar')).paddingRight`
          ),
          platform === 'win32' ? '144px' : '12px'
        )
        assert(
          await evaluate(
            `const main = document.querySelector('[data-workspace-canvas]'); const box = main.getBoundingClientRect(); return main.contains(document.elementFromPoint(box.left + 40, 24)) && main.contains(document.elementFromPoint(box.left + 40, innerHeight - 40))`
          )
        )
      }
      await evaluate(`delete document.documentElement.dataset.platform`)
      assert.equal(
        await evaluate(
          `return getComputedStyle(document.querySelector('#workspace-inspector')).display`
        ),
        'none'
      )
      await click('[aria-label="Back to chat"]')
    }
    await evaluate(`document.querySelector('#workspace-inspector').focus()`)
    await key('Escape')
    assert.equal(await evaluate(`return !!document.querySelector('#workspace-inspector')`), false)
    assert.equal(
      await evaluate(`return document.activeElement.hasAttribute('data-workspace-toggle')`),
      true
    )
    assert.equal(
      await evaluate(`return document.querySelector('textarea').value`),
      'Preserve my draft'
    )
    assert(
      await evaluate(
        `return window.__chatCanvas === document.querySelector('[data-canvas-surface]')`
      )
    )
    win.setContentSize(1440, 900)
    const base = '/@fs/' + path.resolve('src/renderer/src').replaceAll('\\', '/')
    const shared = '/@fs/' + path.resolve('src/shared/theme.ts').replaceAll('\\', '/')
    await evaluate(`const { applyTheme } = await import(${JSON.stringify(base + '/lib/theme.ts')});
      const { BUILT_IN_THEMES, resolveTheme } = await import(${JSON.stringify(shared)});
      applyTheme(resolveTheme(BUILT_IN_THEMES.find(theme => theme.id === 'roxy-light')));`)
    await click('[data-workspace-toggle]')
    await click('#inspector-tab-files')
    await screenshot('files-light')
    await evaluate(`window.__originalRead = window.roxy.workspace.read;
      window.__longFile = Array.from({length: 300}, (_, i) => 'const row' + i + ' = "' + 'wide '.repeat(120) + '";').join('\\r\\n') + '\\r\\n';
      window.roxy.workspace.read = async () => ({ok:true,before:'',after:window.__longFile});`)
    await click('#workspace-inspector button[title="package.json"]')
    await until(
      `document.querySelector('[data-workspace-canvas] [data-canvas-surface]')?.textContent.includes('row0')`
    )
    await until(
      `document.querySelector('[data-workspace-canvas] [data-canvas-surface]')?.scrollHeight > 5000`
    )
    await evaluate(
      `document.querySelector('[data-workspace-canvas] [data-canvas-surface]').scrollTop = 4000`
    )
    await until(
      `document.querySelector('[data-workspace-canvas] [data-canvas-surface]')?.textContent.includes('row200')`
    )
    await evaluate(
      `document.querySelector('[data-workspace-canvas] [data-canvas-surface]').focus()`
    )
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] })
    await until(`window.__canvasTest.copied.includes(window.__longFile)`)
    const fileBox = await evaluate(
      `const r = document.querySelector('[data-workspace-canvas] [data-canvas-surface]').getBoundingClientRect(); return {x:Math.round(r.left+100),y:Math.round(r.top+100)}`
    )
    assert(
      await evaluate(
        `const el = document.querySelector('[data-workspace-canvas] [data-canvas-surface]'); const wheel = new WheelEvent('wheel', {clientX:${fileBox.x},clientY:${fileBox.y},deltaX:500,cancelable:true,bubbles:true}); el.dispatchEvent(wheel); return wheel.defaultPrevented`
      )
    )
    await key('Escape')
    await evaluate(
      `window.roxy.workspace.read = async () => ({ok:true,before:'',after:'const a = 1\\n'.repeat(40000)})`
    )
    await click('#workspace-inspector button[title="package.json"]')
    await until(
      `document.querySelector('[data-workspace-canvas] [data-canvas-surface]')?.scrollHeight > 700000`
    )
    assert(
      await evaluate(
        'return window.__canvasTranscript.scene().blocks.reduce((sum,b)=>sum+b.selectable.length,0) < 300'
      )
    )
    await evaluate(
      `document.querySelector('[data-workspace-canvas] [data-canvas-surface]').scrollTop = 600000`
    )
    await until('window.__canvasTranscript.scene().window.scrollTop > 590000')
    assert(
      await evaluate(
        'return window.__canvasTranscript.scene().blocks.reduce((sum,b)=>sum+b.selectable.length,0) < 300'
      )
    )
    await key('Escape')
    await evaluate(`window.roxy.workspace.read = window.__originalRead`)
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log(
      'WORKSPACE UI OK: closed default, header totals, dock/overlay, preserved transcript/draft, diff, file tree/refresh, file preview/copy, tab arrows/Escape/focus, narrow layouts'
    )
  } catch (error) {
    console.error(error)
    console.error(errors.join('\n'))
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.exit(process.exitCode || 0)
  }
})
