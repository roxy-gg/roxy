const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')

let server
let win
let checks = 0
const errors = []
const temp = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'roxy-canvas-'))
app.setPath('userData', temp)
app.commandLine.appendSwitch('disable-renderer-backgrounding')
const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () =>
  evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
const check = (name, value) => {
  assert.ok(value, name)
  checks++
  console.log(`  OK ${name}`)
}
// Keep each assertion's lexical declarations local to that evaluation.
const evaluate = (code) => win.webContents.executeJavaScript(`{\n${code}\n}`, true)
const probe = (code) =>
  evaluate(
    `(() => { const probe = window.__canvasTranscript; const scene = probe.scene(); const el = document.querySelector('[data-canvas-surface]'); ${code} })()`
  )
const railCentered = () =>
  evaluate(`(() => {
  const rail = document.querySelector('[data-prompt-history]').getBoundingClientRect();
  const viewport = document.querySelector('[data-canvas-viewport]').getBoundingClientRect();
  return Math.abs(rail.top + rail.height / 2 - viewport.top - viewport.height / 2) < 1;
})()`)

let buttons = 0
async function mouse(type, x, y, button = 'left', extra = {}) {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  if (type === 'mouseDown') buttons = button === 'right' ? 2 : 1
  if (type === 'mouseUp') buttons = 0
  // CDP still delivers trusted Chromium input, without competing with the user's OS pointer.
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: { mouseMove: 'mouseMoved', mouseDown: 'mousePressed', mouseUp: 'mouseReleased' }[type],
    x: Math.round(x),
    y: Math.round(y),
    button: type === 'mouseMove' && !buttons ? 'none' : button,
    buttons,
    clickCount: type === 'mouseMove' ? 0 : 1,
    ...extra
  })
  await settle()
}
async function click(x, y, button = 'left') {
  await mouse('mouseMove', x, y)
  await mouse('mouseDown', x, y, button)
  await mouse('mouseUp', x, y, button)
}
async function multiClick(x, y, times) {
  await mouse('mouseMove', x, y)
  for (let i = 1; i <= times; i++) {
    await mouse('mouseDown', x, y, 'left', { clickCount: i })
    await mouse('mouseUp', x, y, 'left', { clickCount: i })
  }
}
async function doubleClick(x, y) {
  await multiClick(x, y, 2)
}
async function clickDom(selector) {
  const rect = await evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
  )
  await click(rect.x, rect.y)
}
async function target(filter) {
  await probe(
    `const r = scene.blocks.flatMap(b => b.regions).find(r => ${filter}); if (!r) throw new Error('Missing region: ' + ${JSON.stringify(filter)}); el.scrollTop = Math.max(0, r.y - 150); return r;`
  )
  await wait()
  return probe(
    `const r = scene.blocks.flatMap(b => b.regions).find(r => ${filter}); const b = el.getBoundingClientRect(); return { x: b.x + r.x + r.w / 2, y: b.y + r.y - el.scrollTop + r.h / 2 };`
  )
}
async function activate(filter) {
  const point = await target(filter)
  await click(point.x, point.y)
}
async function key(keyCode, modifiers = []) {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  const code = keyCode.length === 1 ? `Key${keyCode.toUpperCase()}` : keyCode
  const virtualKey =
    {
      Enter: 13,
      Escape: 27,
      Home: 36,
      End: 35,
      ArrowDown: 40,
      ArrowUp: 38,
      PageDown: 34,
      PageUp: 33
    }[keyCode] ?? keyCode.toUpperCase().charCodeAt(0)
  const mask = modifiers.reduce(
    (value, name) => value | ({ control: 2, meta: 4, shift: 8, alt: 1 }[name] ?? 0),
    0
  )
  const params = { key: keyCode, code, windowsVirtualKeyCode: virtualKey, modifiers: mask }
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    ...params
  })
  if (keyCode === 'Enter')
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'char',
      ...params,
      text: '\r'
    })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  await settle()
}
async function menuAction(label) {
  const point = await evaluate(
    `(() => { const b = [...document.querySelectorAll('[data-canvas-menu] button')].find(b => b.textContent.includes(${JSON.stringify(label)})); if (!b) throw new Error('Missing menu item'); const r = b.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`
  )
  await click(point.x, point.y)
}

async function run() {
  let url = process.env.CANVAS_TEST_URL
  if (!url) {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { port: 3114, strictPort: true }
    })
    await server.listen()
    url = 'http://localhost:3114/'
  }
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })
  const harnessUrl = new URL(url)
  harnessUrl.searchParams.set('holdLogo', '1')
  await win.loadURL(harnessUrl.href)
  win.focus()
  await wait(1000)
  check(
    'real Electron canvas paints',
    await probe(
      'return probe.debug.frames > 0 && scene.blocks.length === 3 && el.clientHeight > 100'
    )
  )
  check(
    'first chat paint already shows the bottom',
    await probe(`
    const first = probe.debug.firstPaint;
    return first && first.bottom > 0 && Math.abs(first.top - first.bottom) < 1;
  `)
  )
  check(
    'no transcript horizontal overflow',
    await probe('return el.scrollWidth === el.clientWidth')
  )
  check(
    'backing canvas uses scrollport width',
    await probe(
      'return Math.abs(document.querySelector("canvas").width / devicePixelRatio - el.clientWidth) <= 1'
    )
  )

  await clickDom('#top')
  await clickDom('#stream')
  await clickDom('#stream')
  await clickDom('#session')
  await clickDom('#top')
  check(
    'pending avatar keeps a brand fallback visible',
    await evaluate('window.__canvasTest.logoFallbacks > 0 && window.__canvasTest.logoPaints === 0')
  )
  check(
    'message churn and chat switches share one logo decode',
    await evaluate('window.__canvasTest.logoDecodes === 1')
  )
  const logoScrollTop = await probe('return el.scrollTop')
  await evaluate('window.__canvasTest.releaseLogo()')
  for (let i = 0; i < 50 && !(await evaluate('window.__canvasTest.logoPaints > 0')); i++)
    await wait(50)
  check(
    'decoded logo repaints without another token or interaction',
    await evaluate('window.__canvasTest.logoPaints > 0')
  )
  check(
    'avatar arrival preserves reading position',
    await probe(`return el.scrollTop === ${logoScrollTop}`)
  )
  await clickDom('#standalone')
  await clickDom('#standalone')
  await clickDom('#top')
  const cachedPaints = await evaluate('window.__canvasTest.logoPaints')
  await clickDom('#session')
  await clickDom('#top')
  check(
    'cached logo paints after transcript remounts',
    await evaluate(
      `window.__canvasTest.logoDecodes === 1 && window.__canvasTest.logoPaints > ${cachedPaints}`
    )
  )
  await evaluate(
    `const style=document.createElement('style'); style.id='smooth-test';style.textContent='[data-canvas-surface] { scroll-behavior: smooth !important }';document.head.append(style)`
  )
  await clickDom('#delayed-session')
  await wait(250)
  check(
    'asynchronously loaded chat paints at bottom without a scroll animation',
    await probe(
      `const first=probe.debug.firstPaint;return first && first.bottom>0 && Math.abs(first.top-first.bottom)<1 && Math.abs(el.scrollTop-first.bottom)<1`
    )
  )
  await evaluate(`document.getElementById('smooth-test').remove()`)
  await clickDom('#resize-composer')
  check(
    'composer growth keeps the last message visible when pinned',
    await probe('return Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2')
  )
  await clickDom('#top')
  await clickDom('#resize-composer')
  check(
    'composer resize does not pull a reader back to the bottom',
    await probe('return el.scrollTop===0')
  )

  const link = await target(
    `r.action.type === 'link' && r.action.href === 'https://example.com/docs'`
  )
  await mouse('mouseMove', link.x, link.y)
  check(
    'link cursor is pointer immediately',
    await probe('return getComputedStyle(el).cursor === "pointer"')
  )
  const beforeHover = await probe('return probe.debug.layouts')
  await mouse('mouseMove', 10, link.y)
  check(
    'blank space resets cursor',
    await probe('return getComputedStyle(el).cursor === "default"')
  )
  check(
    'hover does not relayout history',
    await probe(`return probe.debug.layouts === ${beforeHover}`)
  )
  await click(link.x, link.y)
  check(
    'href opens through bridge',
    await evaluate(`window.__canvasTest.opened.includes('https://example.com/docs')`)
  )
  await click(link.x, link.y, 'right')
  await menuAction('Copy link')
  check(
    'right-click link copying uses the href',
    await evaluate(`window.__canvasTest.copied.at(-1)==='https://example.com/docs'`)
  )
  await activate(`r.action.type === 'link' && r.action.href === 'https://example.com/api'`)
  check(
    'inline-code href is clickable',
    await evaluate(`window.__canvasTest.opened.includes('https://example.com/api')`)
  )

  const textPoint = await probe(
    `const line = scene.blocks[1].selectable[0]; const r = el.getBoundingClientRect(); return { x: r.x+line.x+3, y: r.y+line.y-el.scrollTop+7 }`
  )
  await mouse('mouseMove', textPoint.x, textPoint.y)
  check('plain text has an I-beam', await probe('return getComputedStyle(el).cursor === "text"'))
  await mouse('mouseDown', textPoint.x, textPoint.y)
  await wait(150)
  check('single press does not create selection', await probe('return probe.selection() === null'))
  await mouse('mouseMove', textPoint.x + 1, textPoint.y + 1)
  check('sub-threshold movement stays unselected', await probe('return probe.selection() === null'))
  await mouse('mouseUp', textPoint.x + 1, textPoint.y + 1)
  check('single click remains unselected', await probe('return probe.selection() === null'))
  await wait(550)
  await doubleClick(textPoint.x, textPoint.y)
  const doubleClickSelection = await probe(`
    const s=probe.selection();
    const line=s && scene.blocks.flatMap(b=>b.selectable).find(line=>line.index===s.startLine);
    return { selection:s, text:line && s ? line.text.slice(s.startChar,s.endChar) : null };
  `)
  check(
    `double click selects one canvas word: ${JSON.stringify(doubleClickSelection)}`,
    doubleClickSelection.selection &&
      doubleClickSelection.selection.startLine === doubleClickSelection.selection.endLine &&
      doubleClickSelection.selection.startChar !== doubleClickSelection.selection.endChar &&
      doubleClickSelection.text.trim().split(/\s+/).length === 1
  )
  await wait(550)
  await multiClick(textPoint.x, textPoint.y, 3)
  const tripleClickSelection = await probe(`
    const s=probe.selection();
    const lines=scene.blocks.flatMap(b=>b.selectable);
    const first=s && lines.find(line=>line.index===s.startLine);
    const last=s && lines.find(line=>line.index===s.endLine);
    return {
      selection:s,
      startsAtLineStart: !!s && s.startChar === 0,
      endsAtLineEnd: !!last && s.endChar === last.text.length,
      wholeLine: !!first && first.text.length > 0
    };
  `)
  check(
    `triple click selects the whole line: ${JSON.stringify(tripleClickSelection.selection)}`,
    tripleClickSelection.selection &&
      tripleClickSelection.startsAtLineStart &&
      tripleClickSelection.endsAtLineEnd &&
      tripleClickSelection.wholeLine
  )
  await wait(550)
  await mouse('mouseDown', textPoint.x, textPoint.y)
  await mouse('mouseMove', textPoint.x + 100, textPoint.y)
  await mouse('mouseUp', textPoint.x + 100, textPoint.y)
  check(
    'drag creates nonempty selection',
    await probe(
      'const s=probe.selection(); return s && (s.startLine !== s.endLine || s.startChar !== s.endChar)'
    )
  )
  await click(textPoint.x + 30, textPoint.y, 'right')
  check(
    'right click offers selection copy',
    await evaluate(
      `document.querySelector('[data-canvas-menu]').textContent.includes('Copy selection')`
    )
  )
  await menuAction('Copy selection')
  check(
    'menu copies canvas selection',
    await evaluate('window.__canvasTest.copied.at(-1).length > 0')
  )

  check(
    'menu action does not activate a link underneath',
    await evaluate('window.__canvasTest.opened.length === 2')
  )
  const nativeCopy = await evaluate(
    `(() => { const el=document.querySelector('[data-canvas-surface]');const data=new DataTransfer();const e=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}); el.dispatchEvent(e); return e.defaultPrevented&&data.getData('text/plain').length>0; })()`
  )
  check('native Copy event reads canvas selection', nativeCopy)
  const copies = await evaluate('window.__canvasTest.copied.length')
  await clickDom('#composer')
  await evaluate(`const e=document.querySelector('#composer'); e.value='composer only'; e.select()`)
  await key('c', ['control'])
  check(
    'composer copy is not hijacked',
    await evaluate(`window.__canvasTest.copied.length === ${copies}`)
  )
  await activate(`r.action.type==='image'`)
  check(
    'image click opens an accessible preview',
    await evaluate('document.querySelector("dialog")?.open===true')
  )
  await key('Escape')
  check('Escape dismisses the image preview', await evaluate('!document.querySelector("dialog")'))
  await clickDom('#top')
  const settled = await probe('return probe.debug.layouts')
  await probe('el.scrollTop += 30')
  await wait()
  check(
    'native transcript scrolling does not trigger layout',
    await probe(`return probe.debug.layouts === ${settled}`)
  )
  await clickDom('#top')

  const header = await target(`r.action.type === 'toggle' && r.action.id === 'm2/4'`)
  const height = await probe('return scene.height')
  await click(header.x, header.y, 'right')
  check('right click does not toggle tool', await probe(`return scene.height === ${height}`))
  await key('Escape')
  await mouse('mouseDown', 10, header.y)
  await mouse('mouseMove', header.x, header.y)
  await mouse('mouseUp', header.x, header.y)
  check(
    'release over another control does not activate',
    await probe(`return scene.height === ${height}`)
  )

  await terminalCards()

  await activate(`r.action.type === 'toggle' && r.action.id === 'm2/5'`)
  await wait(1500)
  check(
    'large diff has scrollable body',
    await probe(`return scene.blocks.flatMap(b=>b.scrollRegions).some(r=>r.id==='m2/5')`)
  )
  const countBeforeGap = await probe('return scene.blocks.flatMap(b=>b.selectable).length')
  await activate(`r.action.type === 'diff' && r.action.id === 'm2/5' && r.action.command === 'gap'`)
  check(
    'collapsed context expands on click',
    await probe(`return scene.blocks.flatMap(b=>b.selectable).length > ${countBeforeGap}`)
  )
  await activate(
    `r.action.type === 'diff' && r.action.id === 'm2/5' && r.action.command === 'context'`
  )
  check(
    'full file exposes all rows',
    await probe(
      `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5'); return r.contentHeight > 3000 && r.h <= 400`
    )
  )
  await activate(
    `r.action.type === 'diff' && r.action.id === 'm2/5' && r.action.command === 'split'`
  )
  check(
    'split comparison registers both sides',
    await probe(
      `const rows=scene.blocks.flatMap(b=>b.selectable);return rows.some(r=>r.group==='m2/5:before') && rows.some(r=>r.group==='m2/5:after')`
    )
  )
  check(
    'diff text is syntax highlighted',
    await probe(
      `return new Set(scene.blocks.flatMap(b=>b.selectable).filter(l=>l.group==='m2/5:after').flatMap(l=>l.runs.map(r=>r.color))).size > 3`
    )
  )
  check(
    'diff has inline highlights',
    await probe(
      `return scene.blocks.flatMap(b=>b.selectable).some(l=>l.group==='m2/5:after' && l.runs.some(r=>r.background))`
    )
  )
  await activate(
    `r.action.type === 'diff' && r.action.id === 'm2/5' && r.action.command === 'wrap'`
  )
  check(
    'unwrapped long lines retain scrollable width',
    await probe(
      `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5');return r.contentWidth>r.w`
    )
  )
  check(
    'inner overflow does not leak to history',
    await probe('return el.scrollWidth===el.clientWidth')
  )
  await activate(`r.action.type==='scroll' && r.action.id==='m2/5' && r.title==='Next'`)
  check(
    'next change navigation moves within the diff',
    await probe(`return scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5').top > 0`)
  )

  const diffPoint = await probe(
    `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5');el.scrollTop=r.y-100; const b=el.getBoundingClientRect();return{x:b.x+r.x+100,y:b.y+100+100};`
  )
  await wait()
  await click(diffPoint.x, diffPoint.y)
  win.webContents.sendInputEvent({
    type: 'mouseWheel',
    x: Math.round(diffPoint.x),
    y: Math.round(diffPoint.y),
    deltaX: -220,
    deltaY: 0,
    canScroll: true
  })
  await wait(150)
  check(
    'horizontal wheel stays inside the unwrapped diff',
    await probe(
      `return scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5').left > 0 && el.scrollLeft === 0`
    )
  )
  const horizontalThumb = await probe(
    `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5');const b=el.getBoundingClientRect();return {x:b.x+r.x+4,y:b.y+r.y-el.scrollTop+r.h+5,right:b.x+r.x+r.w-6};`
  )
  await mouse('mouseDown', horizontalThumb.x, horizontalThumb.y)
  await mouse('mouseMove', horizontalThumb.right, horizontalThumb.y)
  await mouse('mouseUp', horizontalThumb.right, horizontalThumb.y)
  check(
    'rightmost code column is reachable with the scrollbar',
    await probe(
      `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5');return r.left===r.contentWidth-r.w`
    )
  )
  await mouse('mouseDown', horizontalThumb.x, horizontalThumb.y)
  await mouse('mouseMove', horizontalThumb.x - 50, horizontalThumb.y)
  await mouse('mouseUp', horizontalThumb.x - 50, horizontalThumb.y)
  const topBefore = await probe('return el.scrollTop')
  win.webContents.sendInputEvent({
    type: 'mouseWheel',
    x: Math.round(diffPoint.x),
    y: Math.round(diffPoint.y),
    deltaX: 0,
    deltaY: -220,
    canScroll: true
  })
  await wait(200)
  check(
    'wheel scrolls inside diff',
    await probe(`return scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5').top > 0`)
  )
  check(
    'inner wheel does not move history',
    await probe(`return Math.abs(el.scrollTop-${topBefore})<1`)
  )
  await key('End')
  check(
    'last diff row is reachable',
    await probe(
      `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5');return r.top===r.contentHeight-r.h`
    )
  )
  const scrollbar = await probe(
    `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5');const b=el.getBoundingClientRect();return { x:b.x+r.x+r.w-5, top:b.y+r.y-el.scrollTop+4, bottom:b.y+r.y-el.scrollTop+r.h-4 };`
  )
  await mouse('mouseDown', scrollbar.x, scrollbar.bottom)
  await mouse('mouseMove', scrollbar.x, scrollbar.top)
  await mouse('mouseUp', scrollbar.x, scrollbar.top)
  check(
    'inner scrollbar thumb is draggable',
    await probe(`return scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5').top===0`)
  )
  await click(diffPoint.x, diffPoint.y)
  await key('Home')
  const splitSelection = await probe(
    `const row=scene.blocks.flatMap(b=>b.selectable).find(l=>l.group==='m2/5:after'&&l.text.includes('item0'));const r=el.getBoundingClientRect();return{x:r.x+row.x+3,y:r.y+row.y-el.scrollTop+5};`
  )
  await mouse('mouseDown', splitSelection.x, splitSelection.y)
  await mouse('mouseMove', splitSelection.x + 100, splitSelection.y + 22)
  await mouse('mouseUp', splitSelection.x + 100, splitSelection.y + 22)
  check(
    'split selection stays on its source side',
    await probe(`return probe.selection()?.group==='m2/5:after'`)
  )
  await key('c', ['control'])
  check(
    'split copy does not interleave the original pane',
    await evaluate(`window.__canvasTest.copied.at(-1).split('item0').length === 2`)
  )
  await key('End')
  await click(diffPoint.x, diffPoint.y, 'right')
  await menuAction('Copy modified')
  check(
    'diff copy includes final source line',
    await evaluate(`window.__canvasTest.copied.at(-1).includes('item159')`)
  )
  await activate(`r.action.type==='diff' && r.action.id==='m2/5' && r.action.command==='patch'`)
  check(
    'copy patch exports a unified diff',
    await evaluate(
      `window.__canvasTest.copied.at(-1).includes('@@') && window.__canvasTest.copied.at(-1).includes('src/catalog.ts')`
    )
  )
  const image = await win.webContents.capturePage()
  await fs.mkdir(path.resolve(__dirname, '../.out'), { recursive: true })
  await fs.writeFile(path.resolve(__dirname, '../.out/canvas-dark.png'), image.toPNG())

  await activate(`r.action.type==='toggle' && r.action.id==='m2/10'`)
  await activate(`r.action.type==='toggle' && r.action.id==='m2/10/4'`)
  check(
    'nested subagent uses the shared diff viewer',
    await probe(`return scene.blocks.flatMap(b=>b.scrollRegions).some(r=>r.id==='m2/10/4')`)
  )
  await activate(`r.action.type==='diff' && r.action.id==='m2/10/4' && r.action.command==='split'`)
  check(
    'nested split mode is independent',
    await probe(`return scene.blocks.flatMap(b=>b.selectable).some(l=>l.group==='m2/10/4:after')`)
  )
  await clickDom('#stream')
  await wait(1400)
  await activate(`r.action.type==='cancel' && r.action.id==='__streaming__/2'`)
  check(
    'cancel wins over encompassing header toggle',
    await evaluate(`window.__canvasTest.cancelled.includes('sub-2')`)
  )
  await activate(`r.action.type==='cancel' && r.action.id==='__streaming__/1'`)
  check(
    'delayed tool cancellation is clickable',
    await evaluate(`window.__canvasTest.cancelled.includes('live-1')`)
  )
  await clickDom('#stream')

  await clickDom('#theme')
  await wait(200)
  check(
    'light theme repaints',
    await evaluate(
      `const c=document.querySelector('canvas');const d=c.getContext('2d').getImageData(0,0,1,1).data;d[0]===255 && d[1]===255`
    )
  )
  win.setContentSize(420, 780)
  await wait(200)
  check(
    'narrow viewport has no horizontal bar',
    await probe('return el.scrollWidth===el.clientWidth && el.clientWidth < 450')
  )
  check(
    'diff toolbar fits above its viewport',
    await probe(
      `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='m2/5'); return scene.blocks.flatMap(b=>b.regions).filter(a=>a.action.id==='m2/5'&&a.action.type==='diff').every(a=>a.y+a.h<=r.y)`
    )
  )
  await fs.writeFile(
    path.resolve(__dirname, '../.out/canvas-narrow.png'),
    (await win.webContents.capturePage()).toPNG()
  )

  win.setContentSize(1180, 820)
  await clickDom('#standalone')
  await wait(500)
  check(
    'standalone host uses same diff',
    await probe(`return scene.blocks.length===1 && scene.blocks[0].scrollRegions[0].id==='diff'`)
  )
  await activate(`r.action.type==='diff' && r.action.command==='split'`)
  check(
    'standalone controls work',
    await probe(`return scene.blocks[0].selectable.some(l=>l.group==='diff:after')`)
  )
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 780,
    deviceScaleFactor: 2,
    mobile: false
  })
  await wait(200)
  check(
    'HiDPI backing buffer uses device pixel ratio',
    await evaluate(
      `document.querySelector('canvas').width === Math.round(window.__canvasTranscript.size().width * window.devicePixelRatio) && window.devicePixelRatio===2`
    )
  )
  win.webContents.debugger.detach()
  await clickDom('#standalone')
  await clickDom('#session')
  await wait(200)
  check(
    'session switches reset expanded diffs and selections',
    await probe(
      `return !scene.blocks.flatMap(b=>b.scrollRegions).length && probe.selection()===null`
    )
  )
  check(
    'session switch lands on newest content',
    await probe('return Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2')
  )
  check(
    'switched chat starts at bottom on its very first paint',
    await probe(
      `const first=probe.debug.firstPaint;return first && Math.abs(first.top-first.bottom)<1`
    )
  )
  await clickDom('#tail')
  await clickDom('#stream')
  await wait(250)
  check(
    'streaming follows the tail when pinned',
    await probe('return Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2')
  )
  await clickDom('#top')
  await clickDom('#stream')
  await wait(200)
  check('streaming updates preserve a scrolled-up viewport', await probe('return el.scrollTop===0'))
  check('no renderer errors', errors.length === 0)
  const idleFrames = await probe('return probe.debug.frames')
  await wait(300)
  check(
    'settled canvas is idle instead of running a permanent paint loop',
    await probe(`return probe.debug.frames===${idleFrames}`)
  )
  await promptHistory()
  console.log(`CANVAS OK - ${checks} checks passed`)
}

async function promptHistory() {
  const marker = (id) => `[data-prompt-id="${id}"]`
  const point = async (selector) =>
    evaluate(
      `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
    )
  const hover = async (id) => {
    const p = await point(marker(id))
    await mouse('mouseMove', p.x, p.y)
    await wait(180)
  }
  check(
    'prompt rail only indexes authored messages',
    await evaluate(
      `document.querySelectorAll('[data-prompt-id]').length===2 && !document.querySelector('[data-prompt-id="m2"]')`
    )
  )
  check('prompt rail is vertically centered for short histories', await railCentered())
  await clickDom('#tail')
  // Motion defaults to On: let the previously active marker settle to its idle opacity.
  await wait(180)
  check(
    'latest prompt is active on arrival at the tail',
    await evaluate(
      `document.querySelector('[data-prompt-id="m3"]').getAttribute('aria-current')==='location'`
    )
  )
  check(
    'idle prompt markers stay visually quiet',
    await evaluate(
      `Number(getComputedStyle(document.querySelector('[data-prompt-id="m1"] span')).opacity) < 0.6`
    )
  )
  const top = await probe('return el.scrollTop')
  const layouts = await probe('return probe.debug.layouts')
  await hover('m1')
  check(
    'hover previews the original prompt',
    await evaluate(
      `document.querySelector('[data-prompt-preview]').textContent.includes('Replace the DOM transcript with canvas.')`
    )
  )
  check(
    'preview includes the message timestamp and position',
    await evaluate(
      `const p=document.querySelector('[data-prompt-preview]');p.querySelector('time').dateTime.length>0 && p.textContent.includes('1 / 2')`
    )
  )
  check(
    'hover alone never scrolls or lays out history',
    await probe(`return el.scrollTop===${top} && probe.debug.layouts===${layouts}`)
  )
  check(
    'preview opens to the left and stays inside the viewport',
    await evaluate(
      `const p=document.querySelector('[data-prompt-preview]').getBoundingClientRect();const b=document.querySelector('[data-prompt-id="m1"]').getBoundingClientRect();p.left>=8 && p.top>=8 && p.right<=b.left && p.bottom<=innerHeight-8`
    )
  )
  check(
    'active hover dash extends and brightens',
    await evaluate(
      `const s=getComputedStyle(document.querySelector('[data-prompt-id="m1"] span'));Number(s.opacity)>0.9 && s.transform.includes('1, 0, 0, 1')`
    )
  )
  const next = await point(marker('m3'))
  await mouse('mouseMove', next.x, next.y)
  check(
    'neighboring prompt previews switch without repaying the delay',
    await evaluate(
      `document.querySelector('[data-prompt-preview]').textContent.includes('Now check the diff view') && document.querySelector('[data-prompt-preview]').hasAttribute('data-instant')`
    )
  )
  const tip = await point('[data-prompt-preview]')
  await mouse('mouseMove', tip.x, tip.y)
  await wait(200)
  check(
    'preview remains readable when the pointer enters it',
    await evaluate(`!!document.querySelector('[data-prompt-preview]')`)
  )
  await key('Escape')
  check(
    'Escape dismisses prompt previews',
    await evaluate(`!document.querySelector('[data-prompt-preview]')`)
  )
  await clickDom(marker('m1'))
  check(
    'prompt click jumps instantly without a new canvas layout',
    await probe(
      `return el.scrollTop===0 && probe.debug.layouts===${layouts} && probe.selection()===null`
    )
  )
  check(
    'jump updates current prompt',
    await evaluate(
      `document.querySelector('[data-prompt-id="m1"]').getAttribute('aria-current')==='location'`
    )
  )
  await clickDom('#stream')
  check('new tokens do not override a history jump', await probe('return el.scrollTop===0'))
  await clickDom('#stream')
  await evaluate(`document.querySelector('[data-prompt-id="m1"]').focus({preventScroll:true})`)
  await key('ArrowDown')
  check(
    'arrow keys move focus without changing the reading position',
    await probe(`return document.activeElement.dataset.promptId==='m3' && el.scrollTop===0`)
  )
  await key('Enter')
  check(
    'keyboard activation jumps to the prompt',
    await probe(
      `return Math.abs(el.scrollTop - Math.min(el.scrollHeight-el.clientHeight, scene.blocks.find(b=>b.id==='m3').y-16))<1`
    )
  )
  const beforeExpansion = await probe(`return scene.blocks.find(b=>b.id==='m3').y`)
  await activate(`r.action.type==='toggle' && r.action.id==='m2/4'`)
  await clickDom(marker('m3'))
  check(
    'prompt jump uses live positions after card expansion',
    await probe(
      `const block=scene.blocks.find(b=>b.id==='m3');return block.y>${beforeExpansion} && Math.abs(el.scrollTop-Math.min(el.scrollHeight-el.clientHeight,block.y-16))<1`
    )
  )

  await clickDom('#theme')
  await hover('m1')
  await fs.writeFile(
    path.resolve(__dirname, '../.out/prompt-history-dark.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  await clickDom('#theme')
  await hover('m3')
  check(
    'prompt preview follows the light palette',
    await evaluate(
      `getComputedStyle(document.querySelector('[data-prompt-preview]')).backgroundColor==='rgb(255, 255, 255)'`
    )
  )
  await fs.writeFile(
    path.resolve(__dirname, '../.out/prompt-history-light.png'),
    (await win.webContents.capturePage()).toPNG()
  )

  await clickDom('#long-history')
  await wait(200)
  check(
    'long history keeps its DOM marker count bounded',
    await evaluate(
      `const buttons=document.querySelectorAll('[data-prompt-id]');buttons.length>0&&buttons.length<=18`
    )
  )
  check('long prompt rails are centered within the chat viewport', await railCentered())
  check(
    'long history keeps the latest marker in view',
    await evaluate(`!!document.querySelector('[data-prompt-id="history-user-79"][aria-current]')`)
  )
  const rail = await point('.prompt-history-list')
  const historyTop = await probe('return el.scrollTop')
  const railTop = await evaluate(`document.querySelector('.prompt-history-list').scrollTop`)
  win.focus()
  win.webContents.sendInputEvent({
    type: 'mouseWheel',
    x: Math.round(rail.x),
    y: Math.round(rail.y),
    deltaX: 0,
    deltaY: 220,
    canScroll: true
  })
  await wait(150)
  check(
    'rail scrolling reveals earlier markers without moving chat',
    await probe(
      `return el.scrollTop===${historyTop} && document.querySelector('.prompt-history-list').scrollTop<${railTop}`
    )
  )
  await evaluate(
    `document.querySelector('[data-prompt-id][tabindex="0"]').focus({preventScroll:true})`
  )
  await key('Home')
  check(
    'Home can focus the earliest virtualized prompt',
    await evaluate(`document.activeElement.dataset.promptId==='history-user-0'`)
  )
  check(
    'keyboard preview survives rail windowing',
    await evaluate(
      `document.querySelector('[data-prompt-preview]').textContent.includes('Question 1:')`
    )
  )
  await key('Enter')
  check('first prompt remains reachable in a long history', await probe('return el.scrollTop===0'))
  await clickDom(marker('history-user-0'))
  await mouse('mouseMove', 10, 200)
  await probe('el.scrollTop=el.scrollHeight')
  await wait(120)
  check(
    'rail follows reading position after mouse navigation',
    await evaluate(`!!document.querySelector('[data-prompt-id="history-user-79"][aria-current]')`)
  )
  await evaluate(
    `document.querySelector('[data-prompt-id][tabindex="0"]').focus({preventScroll:true})`
  )
  await key('Home')
  await key('Enter')
  await key('End')
  check(
    'End can focus the last virtualized prompt without jumping',
    await probe(
      `return document.activeElement.dataset.promptId==='history-user-79' && el.scrollTop===0`
    )
  )
  await key('Enter')
  check(
    'last prompt remains reachable in a long history',
    await probe(
      `const b=scene.blocks.find(b=>b.id==='history-user-79');return Math.abs(el.scrollTop-Math.min(el.scrollHeight-el.clientHeight,b.y-16))<1`
    )
  )
  await key('Home')
  for (let i = 0; i < 10; i++) await key('ArrowDown')
  check(
    'image-only prompts get a meaningful preview',
    await evaluate(
      `document.querySelector('[data-prompt-preview]').textContent.includes('1 image attached')`
    )
  )
  await key('ArrowDown')
  check(
    'long prompts have a compact multiline preview',
    await evaluate(
      `const p=document.querySelector('[data-prompt-preview]');p.textContent.includes('Check this multiline request') && p.getBoundingClientRect().height<140 && p.querySelector('p').textContent.length<=400`
    )
  )
  await key('Enter')
  const current = await probe('return el.scrollTop')
  await clickDom('#add-prompt')
  check(
    'newly sent prompts appear without pulling the reader away',
    await probe(`return el.scrollTop===${current}`)
  )
  await evaluate(
    `document.querySelector('[data-prompt-id][tabindex="0"]').focus({preventScroll:true})`
  )
  await key('End')
  check(
    'appended prompt is reachable from the same rail',
    await evaluate(
      `document.activeElement.dataset.promptId==='added-prompt' && document.querySelector('[data-prompt-preview]').textContent.includes('One more improvement.')`
    )
  )
  check(
    'same-day prompt time uses localized Today label',
    await evaluate(
      `document.querySelector('[data-prompt-preview] time').textContent.startsWith('Today,')`
    )
  )

  win.setContentSize(420, 780)
  await wait(200)
  await key('Home')
  const narrow = await point('[data-prompt-id="history-user-0"]')
  await mouse('mouseMove', narrow.x, narrow.y)
  await wait(200)
  check(
    'narrow history rail keeps chat free of horizontal overflow',
    await probe('return el.scrollWidth===el.clientWidth')
  )
  check('prompt rail stays centered after a narrow resize', await railCentered())
  check(
    'narrow preview remains inside the window',
    await evaluate(
      `const r=document.querySelector('[data-prompt-preview]').getBoundingClientRect();r.left>=8&&r.right<=innerWidth-8&&r.bottom<=innerHeight-8`
    )
  )
  await fs.writeFile(
    path.resolve(__dirname, '../.out/prompt-history-narrow.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  await evaluate(`window.roxy.settings.setMotion('system')`)
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await wait(80)
  check(
    'rail respects reduced motion',
    await evaluate(
      `getComputedStyle(document.querySelector('[data-prompt-preview]')).transitionDuration==='0s'`
    )
  )
  win.webContents.debugger.detach()
  await evaluate(`window.roxy.settings.setMotion('on')`)
  await clickDom('#session')
  check(
    'session switch dismisses stale prompt previews',
    await evaluate(`!document.querySelector('[data-prompt-preview]')`)
  )
  await clickDom('#standalone')
  check(
    'standalone diff has no chat-only prompt index',
    await evaluate(`!document.querySelector('[data-prompt-history]')`)
  )
  check('prompt navigation produces no renderer errors', errors.length === 0)
}

async function terminalCards() {
  const originalSize = win.getContentSize()
  await clickDom('#terminal-cards')
  await activate(`r.action.type==='toggle' && r.action.id==='terminal-session/0'`)
  check(
    'one-line bash card has no empty terminal-sized panel',
    await probe(`
    const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/0');
    return r.h < 50 && r.h===r.contentHeight && r.contentWidth===r.w;
  `)
  )
  check('single-marker prompt rail is centered', await railCentered())
  await activate(`r.action.type==='toggle' && r.action.id==='terminal-session/1'`)
  check(
    'full bash command wraps inside its card',
    await probe(`
    const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/1');
    const lines=scene.blocks.flatMap(b=>b.selectable).filter(l=>l.clip?.y===r.y);
    return r.h < 150 && lines.length > 2 && lines.every(l=>l.runs.every(run=>l.x+run.x+run.width <= r.x+r.w-11)) &&
      lines.map(l=>l.text).join('').includes('full-session-switch-benchmark.json');
  `)
  )
  check(
    'Windows bash output remains visible rather than blank',
    await probe(`
    return scene.blocks.flatMap(b=>b.selectable).some(l=>l.text.includes('Copied the database and saved'));
  `)
  )
  const command = await probe(
    `return scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/1').copyActions.find(a=>a.label==='Copy command').text`
  )
  const commandPoint = await probe(
    `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/1'); const b=el.getBoundingClientRect(); return{x:b.x+r.x+30,y:b.y+r.y-el.scrollTop+15};`
  )
  await click(commandPoint.x, commandPoint.y, 'right')
  await menuAction('Copy command')
  check(
    'copy command includes the complete unwrapped source',
    await evaluate(`window.__canvasTest.copied.at(-1)===${JSON.stringify(command)}`)
  )
  await click(commandPoint.x, commandPoint.y, 'right')
  await menuAction('Copy output')
  check(
    'copy output preserves the Windows output without ANSI escapes',
    await evaluate(
      `window.__canvasTest.copied.at(-1)==='Copied the database and saved the benchmark.'`
    )
  )
  await fs.mkdir(path.resolve(__dirname, '../.out'), { recursive: true })
  await fs.writeFile(
    path.resolve(__dirname, '../.out/bash-compact.png'),
    (await win.webContents.capturePage()).toPNG()
  )

  await activate(`r.action.type==='toggle' && r.action.id==='terminal-session/2'`)
  check(
    'large bash logs use a bounded vertical viewport',
    await probe(`
    const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/2');
    return r.h===288 && r.contentHeight>2000 && r.contentWidth===r.w && el.scrollWidth===el.clientWidth;
  `)
  )
  const logPoint = await probe(
    `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/2'); const b=el.getBoundingClientRect();return{x:b.x+r.x+60,y:b.y+r.y-el.scrollTop+120};`
  )
  await click(logPoint.x, logPoint.y)
  const outerTop = await probe('return el.scrollTop')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: logPoint.x,
    y: logPoint.y,
    deltaX: 0,
    deltaY: 250
  })
  await wait(150)
  check(
    'bash wheel scroll stays inside the output card',
    await probe(`
    return scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/2').top > 0 && Math.abs(el.scrollTop-${outerTop})<1;
  `)
  )
  await key('End')
  check(
    'last bash output row and exit status are reachable',
    await probe(`
    const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/2');
    const lines=scene.blocks.flatMap(b=>b.selectable).filter(l=>l.clip?.y===r.y);
    const footer=lines.at(-1);
    return r.top===r.contentHeight-r.h && footer.text==='[exit 0]' && footer.y>=r.y && footer.y+footer.height<=r.y+r.h;
  `)
  )
  await click(logPoint.x, logPoint.y, 'right')
  await menuAction('Copy output')
  check(
    'copy long bash output includes both first and last rows',
    await evaluate(`
    const text=window.__canvasTest.copied.at(-1);text.includes('log row 0') && text.includes('log row 119') && text.endsWith('[exit 0]');
  `)
  )
  const thumb = await probe(
    `const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/2');const b=el.getBoundingClientRect();return{x:b.x+r.x+r.w-5,top:b.y+r.y-el.scrollTop+4,bottom:b.y+r.y-el.scrollTop+r.h-4};`
  )
  await mouse('mouseDown', thumb.x, thumb.bottom)
  await mouse('mouseMove', thumb.x, thumb.top)
  await mouse('mouseUp', thumb.x, thumb.top)
  check(
    'bash output scrollbar is draggable',
    await probe(
      `return scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/2').top===0`
    )
  )

  await activate(`r.action.type==='toggle' && r.action.id==='terminal-session/3'`)
  await activate(`r.action.type==='toggle' && r.action.id==='terminal-session/3/0'`)
  check(
    'subagent bash commands use the same wrapping and compact layout',
    await probe(`
    const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/3/0');
    return r.h<160 && r.contentWidth===r.w;
  `)
  )
  win.setContentSize(420, 780)
  await wait(150)
  await target(`r.action.type==='toggle' && r.action.id==='terminal-session/1'`)
  check(
    'long bash commands remain readable in a narrow window',
    await probe(`
    const r=scene.blocks.flatMap(b=>b.scrollRegions).find(r=>r.id==='terminal-session/1');
    return r.contentWidth===r.w && el.scrollWidth===el.clientWidth && scene.blocks.flatMap(b=>b.selectable).filter(l=>l.clip?.y===r.y).every(l=>l.runs.every(run=>l.x+run.x+run.width<=r.x+r.w-11));
  `)
  )
  check('centered prompt rail follows composer height', await railCentered())
  await fs.writeFile(
    path.resolve(__dirname, '../.out/bash-narrow.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  win.setContentSize(...originalSize)
  await clickDom('#terminal-cards')
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    console.error('Canvas smoke timed out')
    app.exit(2)
  }, 90000)
  let code = 0
  try {
    await run()
  } catch (error) {
    console.error(error)
    console.error(errors)
    console.error(
      await probe(
        'return {focus:document.hasFocus(), active:document.activeElement?.outerHTML, size:probe.size(), cursor:el.style.cursor, top:el.scrollTop, layouts:probe.debug.layouts, rail:document.querySelector("[data-prompt-history]")?.outerHTML, menu:document.querySelector("[data-canvas-menu]")?.textContent, regions:scene.blocks.flatMap(b=>b.scrollRegions).map(({copyActions,...r})=>r)}'
      ).catch(() => null)
    )
    code = 1
  }
  clearTimeout(watchdog)
  win?.destroy()
  await server?.close()
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  app.exit(code)
})
