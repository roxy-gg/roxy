const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'roxy-background-ui-'))
app.setPath('userData', temp)
let win, server
const errors = []
const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
const sidebarStyles = () =>
  evaluate(`return ['#main-sidebar-harness aside', '#appearance-page aside'].map(selector => {
    const s=getComputedStyle(document.querySelector(selector));
    return [s.width,s.backgroundColor,s.borderRightColor,s.borderRightWidth];
  })`)
const click = async (selector) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait()
}
const until = async (code) => {
  for (let n = 0; n < 100; n++) {
    if (await evaluate(`return ${code}`)) return
    await wait(50)
  }
  throw Error(`Timed out: ${code}`)
}
const setInput = async (selector, value, type = 'HTMLInputElement') => {
  await evaluate(`const el = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(${type}.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));`)
  await wait()
}
async function run() {
  let url = process.env.CANVAS_TEST_URL
  if (!url) {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { host: '127.0.0.1', port: 3100, strictPort: true }
    })
    await server.listen()
    url = 'http://127.0.0.1:3100/'
  }
  win = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  await win.loadURL(`${url}?background`)
  await until(
    `!!document.querySelector('.composer-panel') && !document.querySelector('#wallpaper-settings button:has(.lucide-image-plus)').disabled`
  )
  assert.equal(await evaluate(`return document.querySelectorAll('.chat-wallpaper').length`), 0)
  await click('#wallpaper-settings button:has(.lucide-image-plus)')
  await until(`document.querySelectorAll('.chat-wallpaper').length === 2`)
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('[data-wallpaper] .chat-wallpaper')).opacity`
    ),
    '0.3'
  )
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('.composer-panel'), '::before').backdropFilter`
    ),
    'blur(18px) saturate(1.2)'
  )
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('.composer-gutter')).backgroundColor`
    ),
    'rgba(0, 0, 0, 0)'
  )
  const original = await evaluate(`return document.querySelector('[data-wallpaper] img').src`)
  await click('.composer-panel button[aria-haspopup="dialog"]')
  assert.ok(
    await evaluate(`const dialog = document.querySelector('[role="dialog"]');
    const panel = document.querySelector('.composer-panel');
    return !!dialog && getComputedStyle(panel).overflow === 'visible'
      && getComputedStyle(panel).maskImage === 'none';`),
    'glass does not clip composer popovers'
  )
  await click('.composer-panel button[aria-haspopup="dialog"]')
  await setInput('.composer-panel textarea', 'My draft stays here', 'HTMLTextAreaElement')
  await click('#background-theme')
  assert.equal(
    await evaluate(`return document.querySelector('.composer-panel textarea').value`),
    'My draft stays here',
    'theme switch preserves the native input'
  )
  await click('#background-theme')
  await click('#background-theme')
  const outputs = new Set()
  for (let i = 2; i <= 5; i++) {
    await click(`[aria-labelledby="background-effect-label"] button:nth-child(${i})`)
    await until(
      `!document.querySelector('[aria-live="polite"]').textContent && document.querySelector('[data-wallpaper] .chat-wallpaper img').src.startsWith('blob:')`
    )
    outputs.add(
      await evaluate(
        `const img = document.querySelector('[data-wallpaper] .chat-wallpaper img'); await img.decode(); const c = document.createElement('canvas'); c.width=100; c.height=100; c.getContext('2d').drawImage(img,0,0,100,100); return c.toDataURL()`
      )
    )
  }
  assert.equal(outputs.size, 4, 'all processed effects produce distinct artwork')
  await click('[aria-labelledby="background-effect-label"] button:nth-child(6)')
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('[data-wallpaper] img')).filter`
    ),
    'blur(12px) saturate(0.85)'
  )
  await click('[aria-labelledby="background-effect-label"] button:nth-child(1)')
  assert.equal(
    await evaluate(`return document.querySelector('[data-wallpaper] img').src`),
    original
  )
  await click('#background-theme')
  const lightTint = await evaluate(
    `return getComputedStyle(document.querySelector('.composer-panel'), '::before').backgroundColor`
  )
  assert.ok(lightTint.includes('0.937') || lightTint.includes('239'), lightTint)
  await click('#background-theme')
  assert.notEqual(
    await evaluate(
      `return getComputedStyle(document.querySelector('.composer-panel'), '::before').backgroundColor`
    ),
    lightTint
  )
  await click('#background-messages')
  await until(`!!document.querySelector('[data-canvas-surface] canvas')`)
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('[data-wallpaper] .chat-wallpaper')).opacity`
    ),
    '0.15'
  )
  assert.equal(
    await evaluate(
      `const c=document.querySelector('[data-canvas-surface] canvas');return c.getContext('2d').getImageData(1,1,1,1).data[3]`
    ),
    0,
    'canvas allows artwork through'
  )
  await evaluate(
    `window.__savedCanvas = document.querySelector('[data-canvas-surface] canvas'); const ctx=window.__savedCanvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,20,20);`
  )
  await click('#background-theme')
  assert.equal(
    await evaluate(`return window.__savedCanvas.getContext('2d').getImageData(1,1,1,1).data[3]`),
    0,
    'repaint clears old pixels'
  )
  await setInput('#background-scope', 'empty', 'HTMLSelectElement')
  assert.equal(await evaluate(`return document.querySelectorAll('[data-wallpaper]').length`), 0)
  assert.equal(
    await evaluate(
      `return window.__savedCanvas === document.querySelector('[data-canvas-surface] canvas')`
    ),
    true,
    'scope does not remount transcript'
  )
  assert.equal(
    await evaluate(`return window.__savedCanvas.getContext('2d').getImageData(1,1,1,1).data[3]`),
    255,
    'opaque painting restored'
  )
  await click('#background-empty')
  assert.equal(await evaluate(`return document.querySelectorAll('[data-wallpaper]').length`), 1)
  await click('#background-loading')
  assert.equal(await evaluate(`return document.querySelectorAll('[data-wallpaper]').length`), 0)
  await click('#background-error')
  assert.equal(await evaluate(`return document.querySelectorAll('[data-wallpaper]').length`), 0)
  await click('#background-empty')
  await setInput('#background-emptyOpacity', '42')
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('#wallpaper-settings .chat-wallpaper')).opacity`
    ),
    '0.42',
    'slider previews during drag'
  )
  await evaluate(
    `document.querySelector('#background-emptyOpacity').dispatchEvent(new PointerEvent('pointerup', {bubbles:true}))`
  )
  await wait()
  assert.equal(
    await evaluate(`return (await window.roxy.background.get()).settings.emptyOpacity`),
    42
  )
  await click('#background-glass')
  assert.equal(
    await evaluate(`return document.querySelector('[data-wallpaper]').hasAttribute('data-glass')`),
    false
  )
  await click('#background-glass')
  await win.webContents.debugger.attach('1.3')
  for (const name of ['prefers-reduced-transparency', 'prefers-contrast']) {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name, value: name === 'prefers-contrast' ? 'more' : 'reduce' }]
    })
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('[data-wallpaper] .chat-wallpaper')).display`
      ),
      'none'
    )
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('.composer-panel'), '::before').backdropFilter`
      ),
      'none'
    )
  }
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
  await evaluate(`location.hash = 'cancel'`)
  await click('#wallpaper-settings button:has(.lucide-image-plus)')
  assert.equal(
    await evaluate(`return (await window.roxy.background.get()).image`),
    original,
    'cancel preserves image'
  )
  await evaluate(`location.hash = 'fail'`)
  await click('[aria-labelledby="background-effect-label"] button:nth-child(2)')
  assert.equal(
    await evaluate(`return (await window.roxy.background.get()).settings.effect`),
    'none',
    'failed saves preserve settings'
  )
  assert.ok(
    await evaluate(
      `return document.querySelector('#wallpaper-settings [role="alert"]').textContent.includes('Could not save')`
    )
  )
  await evaluate(`location.hash = ''`)
  await win.loadURL(`${url}?background`)
  await until(`!!document.querySelector('[data-wallpaper]')`)
  assert.equal(
    await evaluate(`return (await window.roxy.background.get()).settings.emptyOpacity`),
    42,
    'reload retains settings'
  )
  await until(`document.documentElement.hasAttribute('data-squircle')`)
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('.composer-panel'), '::before').getPropertyValue('--sq-r')`
    ),
    await evaluate(
      `return getComputedStyle(document.querySelector('.composer-panel')).getPropertyValue('--sq-r')`
    ),
    'glass mask matches squircle'
  )
  await evaluate(`document.documentElement.removeAttribute('data-squircle')`)
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('.composer-panel'), '::before').backdropFilter`
    ),
    'blur(18px) saturate(1.2)',
    'fallback retains glass'
  )
  await evaluate(`location.hash='slow'`)
  await click('[aria-labelledby="background-effect-label"] button:nth-child(2)')
  await click('#background-glass')
  await until(
    `window.roxy.background.get().then(s => s.settings.effect === 'dither' && !s.settings.glass)`
  )
  assert.equal(
    await evaluate(
      `return document.querySelector('[aria-labelledby="background-effect-label"] button:nth-child(2)').getAttribute('aria-pressed')`
    ),
    'true',
    'rapid independent edits retain the selected effect'
  )
  await setInput('#background-emptyOpacity', '47')
  await evaluate(
    `document.querySelector('#background-emptyOpacity').dispatchEvent(new PointerEvent('pointerup', {bubbles:true}))`
  )
  await setInput('#background-emptyOpacity', '58')
  await wait(400)
  assert.equal(
    await evaluate(`return document.querySelector('#background-emptyOpacity').value`),
    '58',
    'older acknowledgement does not reset a newer drag'
  )
  await evaluate(
    `document.querySelector('#background-emptyOpacity').dispatchEvent(new PointerEvent('pointerup', {bubbles:true}))`
  )
  await until(`window.roxy.background.get().then(s => s.settings.emptyOpacity === 58)`)
  await evaluate(`location.hash=''`)
  await click('[aria-labelledby="background-effect-label"] button:nth-child(1)')
  await click('#background-glass')
  win.setSize(390, 844)
  await wait()
  assert.ok(
    await evaluate(
      `const el = document.querySelector('#wallpaper-settings'); return el.scrollWidth <= el.clientWidth`
    ),
    'settings fit narrow windows'
  )
  win.setSize(1440, 1000)
  await wait()
  await evaluate(
    `const button=[...document.querySelectorAll('#wallpaper-settings button')].find(b=>b.textContent==='Remove');button.click()`
  )
  await until(`document.querySelectorAll('.chat-wallpaper').length === 0`)
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('.composer-gutter')).backgroundColor`
    ),
    'rgb(10, 10, 10)',
    'remove restores solid UI'
  )
  // Resize the actual chat sidebar, then load Appearance from its saved preference.
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
    enabled: true
  })
  const edge = await evaluate(
    `const r=document.querySelector('[data-sidebar-frame] [role="separator"]').getBoundingClientRect();return {x:r.x+r.width/2, y:r.y+100}`
  )
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    ...edge
  })
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...edge,
    button: 'left',
    clickCount: 1
  })
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: edge.x + 64,
    y: edge.y,
    button: 'left',
    buttons: 1
  })
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: edge.x + 64,
    y: edge.y,
    button: 'left',
    clickCount: 1
  })
  await until(`localStorage.getItem('roxy.sidebar.width') === '352'`)
  assert.equal(await evaluate(`return document.body.style.cursor`), '', 'resize releases cursor')
  await win.loadURL(`${url}?appearance`)
  await until(`!!document.querySelector('#appearance-background')`)
  assert.deepEqual(
    await evaluate(`return [...document.querySelectorAll('nav button')].map(b => b.textContent)`),
    ['Background', 'Color Theme']
  )
  assert.equal(
    await evaluate(
      `return document.querySelector('#appearance-background').getAttribute('aria-current')`
    ),
    'page'
  )
  assert.equal(
    await evaluate(`return document.querySelector('#appearance-themes-panel').checkVisibility()`),
    false
  )
  assert.ok(
    await evaluate(
      `return document.querySelector('#appearance-page aside').getBoundingClientRect().right <= document.querySelector('#appearance-background-panel').getBoundingClientRect().left`
    ),
    'menu sits on the left'
  )
  await click('#appearance-background-panel button:has(.lucide-image-plus)')
  await until(`!!document.querySelector('#appearance-background-panel .chat-wallpaper')`)
  const wallpaper = await evaluate(`return (await window.roxy.background.get()).image`)
  await click('#appearance-themes')
  assert.equal(
    await evaluate(
      `return document.querySelector('#appearance-background-panel').checkVisibility()`
    ),
    false
  )
  await evaluate(
    `const panel=document.querySelector('#appearance-themes-panel'); [...panel.querySelectorAll('button')].find(b => b.textContent.trim()==='Apply').click()`
  )
  await until(`document.documentElement.dataset.appearance === 'light'`)
  assert.deepEqual(
    (await sidebarStyles())[0],
    (await sidebarStyles())[1],
    'both sidebars respond identically to a light theme'
  )
  assert.equal(await evaluate(`return (await window.roxy.background.get()).image`), wallpaper)
  await evaluate(
    `const panel=document.querySelector('#appearance-themes-panel'); [...panel.querySelectorAll('button')].find(b => b.textContent.trim()==='New theme').click()`
  )
  await until(`!!document.querySelector('#appearance-themes-panel textarea')`)
  const draft = '{"id":"custom-0","name":"Unsaved draft","colors":{"bg":"#131026"}}'
  await setInput('#appearance-themes-panel textarea', draft, 'HTMLTextAreaElement')
  await evaluate(
    `window.__appearanceEditor = document.querySelector('#appearance-themes-panel textarea'); window.__appearanceEditor.scrollIntoView()`
  )
  await click('#appearance-background')
  assert.ok(
    await evaluate(
      `return document.querySelector('#background-heading').getBoundingClientRect().top < 130`
    ),
    'switching shows the top of the selected panel'
  )
  assert.deepEqual(
    (await sidebarStyles())[0],
    (await sidebarStyles())[1],
    'Appearance uses the actual main sidebar width, surface and divider'
  )
  assert.equal((await sidebarStyles())[1][0], '352px', 'saved custom width is restored')
  assert.equal(
    await evaluate(
      `return document.querySelector('#appearance-page aside').getBoundingClientRect().top`
    ),
    0,
    'sidebar surface extends through the titlebar'
  )
  assert.ok(
    await evaluate(`const roots=['#appearance-page aside','#appearance-page aside > .titlebar','#appearance-page header'];return roots.every(selector=>{
    const s=getComputedStyle(document.querySelector(selector));return s.borderTopWidth === '0px' && s.borderBottomWidth === '0px';
  })`),
    'no horizontal dividers around Back or the page header'
  )
  assert.equal(
    await evaluate(
      `const a=getComputedStyle(document.querySelector('#appearance-background')); const b=getComputedStyle(document.querySelector('#main-sidebar-harness button:has(.lucide-palette)'));return [a.padding,a.gap,a.fontSize].join('|') === [b.padding,b.gap,b.fontSize].join('|')`
    ),
    true,
    'navigation shares spacing and typography'
  )
  const styles = await evaluate(
    `const e=document.createElement('div');e.style.background='var(--color-elevated)';document.body.append(e);const value=getComputedStyle(e).backgroundColor;e.remove();return value`
  )
  // The shared row has a 140ms color transition; wait for the selected state to settle.
  await until(
    `getComputedStyle(document.querySelector('#appearance-background')).backgroundColor === ${JSON.stringify(styles)}`
  )
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('#appearance-background')).backgroundColor`
    ),
    styles,
    'selected navigation uses the main sidebar selected surface'
  )
  await evaluate(`document.querySelector('#appearance-page [role="separator"]').focus()`)
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39
  })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39
  })
  await until(`localStorage.getItem('roxy.sidebar.width') === '362'`)
  assert.deepEqual(
    (await sidebarStyles())[0],
    (await sidebarStyles())[1],
    'resizing Appearance updates the still-mounted chat sidebar'
  )
  await evaluate(
    `document.querySelector('#appearance-page [role="separator"]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`
  )
  await until(`localStorage.getItem('roxy.sidebar.width') === '288'`)
  for (const platform of ['darwin', 'win32', 'linux']) {
    await evaluate(`document.documentElement.dataset.platform=${JSON.stringify(platform)}`)
    assert.ok(
      await evaluate(
        `const b=document.querySelector('#appearance-page aside button').getBoundingClientRect();return b.x>=${platform === 'darwin' ? 80 : 0} && b.right<=document.querySelector('#appearance-page aside').getBoundingClientRect().right`
      ),
      `${platform} back control clears native window buttons`
    )
  }
  await evaluate(`document.documentElement.dataset.platform='win32'`)
  await click('#appearance-themes')
  assert.equal(
    await evaluate(
      `return document.querySelector('#appearance-themes-panel textarea') === window.__appearanceEditor`
    ),
    true
  )
  assert.equal(
    await evaluate(`return document.querySelector('#appearance-themes-panel textarea').value`),
    draft,
    'panel switch preserves unsaved JSON'
  )
  for (const width of [760, 390]) {
    win.setSize(width, 844)
    await wait()
    for (const panel of ['background', 'themes']) {
      await click(`#appearance-${panel}`)
      assert.ok(
        await evaluate(
          `const p=document.querySelector('#appearance-${panel}-panel');return p.scrollWidth <= p.clientWidth`
        ),
        `${panel} fits at ${width}px`
      )
    }
  }
  assert.ok(
    await evaluate(
      `return document.querySelector('#appearance-page aside').getBoundingClientRect().bottom <= document.querySelector('#appearance-themes-panel').getBoundingClientRect().top`
    ),
    'narrow menu moves above panel'
  )
  win.focus()
  await wait()
  await evaluate(`document.querySelector('#appearance-background').focus()`)
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    ...enter
  })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type: 'char',
    ...enter,
    text: '\r'
  })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
  await wait()
  assert.equal(
    await evaluate(
      `return document.querySelector('#appearance-background').getAttribute('aria-current')`
    ),
    'page',
    'menu works with keyboard'
  )
  win.setSize(1440, 1000)
  await click('#appearance-page aside .titlebar button')
  assert.equal(
    await evaluate(`return !!document.querySelector('#appearance-page')`),
    false,
    'Back returns to chat'
  )
  assert.equal(
    await evaluate(
      `return document.querySelector('#main-sidebar-harness aside').getBoundingClientRect().width`
    ),
    288,
    'chat retains the shared width on return'
  )
  assert.deepEqual(errors, [])
  console.log(
    'BACKGROUND UI OK: six effects, glass, canvas alpha/repaint, persistence, accessibility, appearance navigation, draft retention and narrow layouts'
  )
}
app
  .whenReady()
  .then(run)
  .then(async () => {
    win?.destroy()
    await server?.close()
    fs.rmSync(temp, { recursive: true, force: true })
    app.exit(0)
  })
  .catch(async (error) => {
    console.error(error)
    console.error(errors)
    win?.destroy()
    await server?.close()
    fs.rmSync(temp, { recursive: true, force: true })
    app.exit(1)
  })
