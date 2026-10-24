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
  console.error(
    await evaluate(
      'return {value:window.__editor?.getValue(),position:window.__editor?.getPosition(),text:document.querySelector("[data-workspace-editor]")?.textContent?.slice(0,400)}'
    )
  )
  throw Error(`Timed out: ${code}`)
}
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait()
}
async function key(keyCode, modifiers = []) {
  win.focus()
  win.webContents.focus()
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode === 'Enter')
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
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
    await wait()
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
    await wait()
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
    const changeIcon = await evaluate(
      `return document.querySelector('#workspace-inspector section button[title="src/renderer/src/components/ChatView.tsx"] svg').innerHTML`
    )
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
    const icons = await evaluate(`return Object.fromEntries(
      [...document.querySelectorAll('#workspace-inspector section button[title]')]
        .filter(button => !button.hasAttribute('aria-expanded'))
        .map(button => {
          const icon = button.querySelector('svg');
          const box = icon.getBoundingClientRect();
          if (icon.getAttribute('aria-hidden') !== 'true' || box.width !== 16 || box.height !== 16)
            throw Error('File icon must be decorative and fixed-size: ' + button.title);
          return [button.title, icon.innerHTML];
        })
    )`)
    assert.equal(
      new Set(
        ['app.js', 'app.ts', 'app.tsx', 'app.jsx', 'main.rs', '.env', 'README.md'].map(
          (name) => icons[name]
        )
      ).size,
      7,
      'JavaScript, TypeScript, React, Rust, env and Markdown have distinct icons'
    )
    assert.equal(icons['app.tsx'], changeIcon, 'Changes and Files use the same icon')
    assert.equal(icons['app.ts'], icons['UPPER.TS'], 'extensions are case-insensitive')
    assert.equal(icons['app.ts'], icons['module.mts'])
    assert.equal(icons['app.ts'], icons['module.cts'])
    assert.notEqual(icons['app.ts'], icons['types.d.ts'], 'declarations have a distinct icon')
    assert.equal(icons['.env'], icons['.env.local'])
    assert.equal(icons['.env'], icons['.env.staging.local'])
    assert.equal(icons['README.md'], icons['notes.markdown'])
    assert.equal(icons['unknown'], icons['unknown.extension'], 'unknown files have a fallback')
    for (const name of ['.gitignore', '.prettierrc', 'package.json', 'config.jsonc']) {
      assert.notEqual(icons[name], icons['unknown'], name + ' has a recognized icon')
    }
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
      `document.querySelector('[data-workspace-editor] .view-lines')?.textContent.includes('roxy')`
    )
    assert(
      await evaluate(
        `return document.querySelector('textarea').closest('[inert]') !== null && !document.querySelector('#workspace-inspector [data-canvas-surface]')`
      )
    )
    await screenshot('file-canvas')
    assert.equal(
      await evaluate(
        `return document.querySelector('.workspace-file-toolbar svg[aria-hidden="true"][focusable="false"]').innerHTML`
      ),
      icons['package.json'],
      'file preview uses the same file-type icon'
    )
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
      window.roxy.workspace.read = async () => ({ok:true,before:'',after:window.__longFile,revision:'long'});`)
    await click('#workspace-inspector button[title="package.json"]')
    await until(
      `document.querySelector('[data-workspace-editor] .view-lines')?.textContent.includes('row0')`
    )
    await evaluate(
      `const { monaco } = await import(${JSON.stringify(base + '/lib/workspace-editor.ts')}); window.__monaco = monaco; window.__editor = monaco.editor.getEditors()[0]; window.__editor.setScrollTop(4000);`
    )
    await until(
      `document.querySelector('[data-workspace-editor] .view-lines')?.textContent.includes('row200')`
    )
    await click('[aria-label="Copy file contents"]')
    await until(`window.__canvasTest.copied.includes(window.__longFile)`)
    await evaluate('window.__editor.focus()')
    await key('Escape')
    await evaluate(
      `window.roxy.workspace.read = async () => ({ok:true,before:'',after:'const a = 1\\n'.repeat(40000),revision:'huge'})`
    )
    await click('#workspace-inspector button[title="package.json"]')
    await until('window.__monaco.editor.getEditors()[0]?.getModel()?.getLineCount() === 40001')
    assert(
      await evaluate(
        'return document.querySelectorAll("[data-workspace-editor] .view-line").length < 300'
      )
    )
    await evaluate(
      'window.__editor = window.__monaco.editor.getEditors()[0]; window.__editor.setScrollTop(600000)'
    )
    await until('window.__editor.getScrollTop() > 590000')
    assert(
      await evaluate(
        'return document.querySelectorAll("[data-workspace-editor] .view-line").length < 300'
      )
    )
    await screenshot('editor-light-large')
    await evaluate('window.__editor.focus()')
    await key('Escape')
    await evaluate(`window.roxy.workspace.read = window.__originalRead`)
    // Exercise the real editor's keyboard commands, language workers and draft lifecycle.
    await click('#workspace-inspector button[title="tsconfig.json"]')
    await until('window.__monaco.editor.getEditors().length === 1')
    await evaluate(
      `window.__editor = window.__monaco.editor.getEditors()[0]; window.__editor.focus()`
    )
    await key('A', ['control'])
    await win.webContents.insertText('{}')
    await until(`window.__editor.getValue().includes('{')`)
    await evaluate(
      'window.__editor.getModel().setValue("{}"); window.__editor.getModel().setEOL(0); window.__editor.setPosition({lineNumber:1,column:2}); window.__editor.focus()'
    )
    await key('Enter')
    await until(`window.__editor.getValue() === '{\\n  \\n}'`)
    await key('Tab')
    await until(`window.__editor.getValue() === '{\\n    \\n}'`)
    await key('Tab', ['shift'])
    await until(`window.__editor.getValue() === '{\\n  \\n}'`)
    await win.webContents.insertText('"editable": true')
    const edited = await evaluate('return window.__editor.getValue()')
    await evaluate('window.dispatchEvent(new Event("focus"))')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await evaluate('return window.__editor.getValue()'), edited)
    await click('[aria-label="Back to chat"]')
    await click('#workspace-inspector button[title="package.json"]')
    await until('window.__monaco.editor.getEditors().length === 1')
    await click('[aria-label="Back to chat"]')
    await click('#workspace-inspector button[title="tsconfig.json"]')
    await until('window.__monaco.editor.getEditors().length === 1')
    await evaluate(
      'window.__editor = window.__monaco.editor.getEditors()[0]; window.__editor.focus()'
    )
    assert.equal(await evaluate('return window.__editor.getValue()'), edited)
    await key('Z', ['control'])
    assert.notEqual(await evaluate('return window.__editor.getValue()'), edited)
    await key('Z', ['control', 'shift'])
    assert.equal(await evaluate('return window.__editor.getValue()'), edited)
    await key('S', ['control'])
    await until(`document.querySelector('[aria-label="Save file"]')?.disabled`)
    assert.equal(
      await evaluate(
        `return (await window.__originalRead('project-chat','roxy','tsconfig.json',false)).after`
      ),
      edited
    )
    // A later keystroke must not be marked saved by an earlier in-flight save.
    await evaluate(
      `window.__originalWrite = window.roxy.workspace.write; window.roxy.workspace.write = (...args) => new Promise(resolve => { window.__finishSave = () => window.__originalWrite(...args).then(resolve) }); window.__editor.focus()`
    )
    await key('End', ['control'])
    await win.webContents.insertText(' ')
    await key('S', ['control'])
    await until('!!window.__finishSave')
    await win.webContents.insertText(' ')
    await evaluate('window.__finishSave()')
    await until(
      `!!document.querySelector('[aria-label="Unsaved changes"]') && !document.querySelector('[aria-label="Save file"]')?.disabled`
    )
    await evaluate('window.roxy.workspace.write = window.__originalWrite')
    await key('S', ['control'])
    await until(`document.querySelector('[aria-label="Save file"]')?.disabled`)
    // An external writer wins on disk; a stale save keeps the user's draft intact.
    await evaluate(
      `const disk = await window.__originalRead('project-chat','roxy','tsconfig.json',false); await window.__originalWrite('project-chat','roxy','tsconfig.json','{"external":true}',disk.revision); window.__editor.focus()`
    )
    await win.webContents.insertText(' ')
    const conflictDraft = await evaluate('return window.__editor.getValue()')
    await key('S', ['control'])
    await until('document.body.textContent.includes("This file changed on disk")')
    assert.equal(await evaluate('return window.__editor.getValue()'), conflictDraft)
    await screenshot('editor-conflict')
    await click('[aria-label="Reload file from disk"]')
    await until(`window.__editor.getValue() === '{"external":true}'`)
    await click('[aria-label="Back to chat"]')
    await evaluate(
      `window.roxy.workspace.read = async () => ({ok:true,before:'',after:'function example() {}',revision:'typescript'});`
    )
    await click('#workspace-inspector button[title="test"]')
    await until(`!!document.querySelector('button[title="test/workspace-inspector.ts"]')`)
    await click('button[title="test/workspace-inspector.ts"]')
    await until(
      'window.__monaco.editor.getEditors()[0]?.getModel()?.getLanguageId() === "typescript"'
    )
    await evaluate(
      'window.__editor = window.__monaco.editor.getEditors()[0]; window.__editor.getModel().setEOL(0); window.__editor.setPosition({lineNumber:1,column:21}); window.__editor.focus()'
    )
    await key('Enter')
    await until(`window.__editor.getValue() === 'function example() {\\n  \\n}'`)
    await evaluate(
      `window.__editor.getModel().setValue('const greeting = "hello";\\ngreeting.'); window.__editor.setPosition({lineNumber:2,column:10}); window.__editor.focus(); window.__editor.trigger('test','editor.action.triggerSuggest',{});`
    )
    await until('document.querySelector(".suggest-widget.visible")?.textContent.includes("charAt")')
    await key('Escape')
    assert(
      await evaluate('return !!document.querySelector("[data-workspace-editor]")'),
      'Escape dismisses suggestions before closing the editor'
    )
    await evaluate(`window.__editor.getModel().setValue('const broken: =');`)
    await until(
      'window.__monaco.editor.getModelMarkers({resource:window.__editor.getModel().uri}).length > 0'
    )
    await click('[aria-label="Reload file from disk"]')
    await until(`!document.querySelector('[aria-label="Unsaved changes"]')`)
    await click('[aria-label="Back to chat"]')
    // Existing tab indentation and BOM/CRLF survive editor round trips.
    await evaluate(
      `window.roxy.workspace.read = async () => ({ok:true,before:'',after:'\\ufefffunction tabs() {\\r\\n\\treturn 1\\r\\n}\\r\\n',revision:'tabs'});`
    )
    await click('button[title="test/workspace-inspector.ts"]')
    await until('window.__monaco.editor.getEditors().length === 1')
    assert(
      await evaluate(
        `window.__editor = window.__monaco.editor.getEditors()[0]; return window.__editor.getModel().getValue(undefined,true).startsWith('\\ufeff') && window.__editor.getModel().getEOL() === '\\r\\n' && !window.__editor.getModel().getOptions().insertSpaces`
      )
    )
    await click('[aria-label="Back to chat"]')
    await evaluate(
      `window.roxy.workspace.read = async () => ({ok:true,before:'',after:'first\\r\\nsecond\\n',revision:'mixed'});`
    )
    await click('button[title="test/workspace-inspector.ts"]')
    await until('document.body.textContent.includes("mixed or legacy line endings")')
    assert(
      await evaluate(
        'return window.__monaco.editor.getEditors()[0].getOption(window.__monaco.editor.EditorOption.readOnly)'
      )
    )
    await click('[aria-label="Back to chat"]')
    await evaluate('window.roxy.workspace.read = window.__originalRead')
    // Reload remains locked across navigation, then redetects the new indentation.
    await click('button[title="test/workspace-inspector.ts"]')
    await until('window.__monaco.editor.getEditors().length === 1')
    await evaluate(
      `window.__editor = window.__monaco.editor.getEditors()[0]; window.__editor.trigger('test','type',{text:' '}); window.__reloadReads = []; window.roxy.workspace.read = () => new Promise(resolve => window.__reloadReads.push(resolve));`
    )
    await click('[aria-label="Reload file from disk"]')
    await until('window.__reloadReads.length > 0')
    await click('[aria-label="Back to chat"]')
    await click('button[title="test/workspace-inspector.ts"]')
    await until('window.__monaco.editor.getEditors().length === 1')
    assert(
      await evaluate(
        'return window.__monaco.editor.getEditors()[0].getOption(window.__monaco.editor.EditorOption.readOnly)'
      )
    )
    await evaluate(
      `window.__reloadReads.forEach(resolve => resolve({ok:true,before:'',after:'function tabs() {\\n\\treturn 1\\n}',revision:'reload-tabs'})); window.roxy.workspace.read = window.__originalRead;`
    )
    await until(
      '!window.__monaco.editor.getEditors()[0].getOption(window.__monaco.editor.EditorOption.readOnly)'
    )
    assert.equal(
      await evaluate(
        'return window.__monaco.editor.getEditors()[0].getModel().getOptions().insertSpaces'
      ),
      false
    )
    await click('[aria-label="Back to chat"]')
    // A save completed while closed must release its clean model and reopen safely in StrictMode.
    await click('button[title="tsconfig.json"]')
    await until('window.__monaco.editor.getEditors().length === 1')
    await evaluate(
      `window.__editor = window.__monaco.editor.getEditors()[0]; window.__editor.trigger('test','type',{text:' '}); window.__finishSave = null; window.roxy.workspace.write = (...args) => new Promise(resolve => { window.__finishSave = () => window.__originalWrite(...args).then(resolve) });`
    )
    await click('[aria-label="Save file"]')
    await until('!!window.__finishSave')
    await click('[aria-label="Back to chat"]')
    await evaluate(
      'await window.__finishSave(); window.roxy.workspace.write = window.__originalWrite'
    )
    await click('button[title="tsconfig.json"]')
    await until('window.__monaco.editor.getEditors().length === 1')
    assert(await evaluate('return !window.__monaco.editor.getEditors()[0].getModel().isDisposed()'))
    await click('[aria-label="Back to chat"]')
    for (const [additions, deletions] of [
      [0, 0],
      [5, 0],
      [0, 3]
    ]) {
      await evaluate(`window.roxy.workspace.inspect = async (...args) => {
        const snapshot = structuredClone(await window.__originalInspect(...args));
        for (const root of snapshot.roots) {
          root.changes = root.changes.slice(0, 1).map(change => ({...change, additions:${additions}, deletions:${deletions}}));
        }
        return snapshot;
      };
      window.dispatchEvent(new Event('focus'));`)
      await until(
        additions || deletions
          ? `document.querySelector('[data-workspace-toggle]')?.textContent === '+${additions}-${deletions}'`
          : `document.querySelector('[data-workspace-toggle]')?.textContent === ''`
      )
      assert(await evaluate(`return !!document.querySelector('[data-workspace-toggle] svg')`))
      if (!additions && !deletions) {
        assert.equal(
          await evaluate(`return document.querySelector('[data-workspace-toggle]').title`),
          'Files and changes'
        )
        await click('[data-workspace-toggle]')
        await until(`!document.querySelector('#workspace-inspector')`)
        await click('[data-workspace-toggle]')
        await until(`!!document.querySelector('#workspace-inspector')`)
      }
    }
    await evaluate('window.roxy.workspace.inspect = window.__originalInspect')
    assert.equal(errors.length, 0, errors.join('\n'))
    await click('#inspector-tab-changes')
    await click('#workspace-inspector section button')
    await until(`!!document.querySelector('[aria-label="Edit working file"]')`)
    await click('[aria-label="Edit working file"]')
    await until(
      'window.__monaco.editor.getEditors()[0]?.getModel()?.getLanguageId() === "typescript"'
    )
    await click('[aria-label="Back to chat"]')
    console.log(
      'WORKSPACE UI OK: layout/diff/tree/file-type icons, zero counts, editor virtualization, Enter/Tab/Shift-Tab, undo/redo, save shortcuts, retained drafts, polling/save races, external conflicts, TS completions/diagnostics, BOM/CRLF/tabs, mixed-EOL protection'
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
