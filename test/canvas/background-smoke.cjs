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
const cleanup = () => {
  try {
    fs.rmSync(temp, { recursive: true, force: true })
  } catch (error) {
    if (!['EPERM', 'EBUSY'].includes(error.code)) throw error
    // Chromium can retain profile locks until Electron exits on Windows.
    console.warn(`Temporary profile retained until process exit: ${error.code}`)
  }
}
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
const sampleWallpaper = async (selector) => {
  const rect =
    await evaluate(`const img=document.querySelector(${JSON.stringify(selector)}); await img.decode(); const image=img.getBoundingClientRect();
    const chat=document.querySelector('#main-sidebar-harness .chat-background-host').getBoundingClientRect();
    const left=Math.ceil(Math.max(image.left,chat.left,0)), right=Math.floor(Math.min(image.right,chat.right,innerWidth));
    const top=Math.ceil(Math.max(image.top,chat.top,0)), bottom=Math.floor(Math.min(image.bottom,chat.bottom,innerHeight));
    return {x:left,y:Math.ceil(top+(bottom-top)/4),width:right-left,height:Math.floor((bottom-top)/2)};`)
  assert.ok(rect.width > 0 && rect.height > 0, 'wallpaper sample is visible')
  // A tiny center crop can hit transparent pixels in every ASCII frame.
  const screenshot = await win.webContents.capturePage(rect)
  return (await require('sharp')(screenshot.toPNG()).resize(64, 64).raw().toBuffer()).toString(
    'base64'
  )
}
async function run() {
  let url = process.env.CANVAS_TEST_URL
  if (!url) {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { host: '127.0.0.1', port: 3101, strictPort: true }
    })
    await server.listen()
    url = 'http://127.0.0.1:3101/'
  }
  win = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: 'background-smoke'
    }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  await win.loadURL(`${url}?background`)
  await win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }]
  })
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
      `return getComputedStyle(document.querySelector('[data-wallpaper] .chat-wallpaper')).display`
    ),
    'block',
    'a chosen wallpaper remains visible on Windows'
  )
  const sidebar = '#main-sidebar-harness [data-sidebar-frame]'
  await click('[aria-label="Sidebar background"] button:nth-child(2)')
  await until(`document.querySelector('#main-sidebar-harness [data-sidebar-style="glass"]')`)
  assert.equal(
    await evaluate(
      `return document.querySelectorAll('#main-sidebar-harness .chat-wallpaper-shared').length`
    ),
    1
  )
  assert.equal(
    await evaluate(
      `return document.querySelectorAll('#main-sidebar-harness [data-wallpaper] .chat-wallpaper').length`
    ),
    0
  )
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('#main-sidebar-harness [data-wallpaper]'), '::before').opacity`
    ),
    '0.7'
  )
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('#wallpaper-settings .background-sidebar-glass')).backdropFilter`
    ),
    'blur(18px) saturate(1.2)'
  )
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector(${JSON.stringify(sidebar)}), '::before').backdropFilter`
    ),
    'blur(18px) saturate(1.2)'
  )
  await click('[aria-label="Sidebar background"] button:nth-child(3)')
  await setInput('#background-sidebarOpacity', '25')
  await evaluate(
    `document.querySelector('#background-sidebarOpacity').dispatchEvent(new PointerEvent('pointerup', {bubbles:true}))`
  )
  await until(`window.roxy.background.get().then(s => s.settings.sidebarOpacity === 25)`)
  const sidebarAlpha = () =>
    evaluate(
      `return Number(getComputedStyle(document.querySelector(${JSON.stringify(sidebar)})).backgroundColor.match(/(?:,|\\/)\\s*([\\d.]+)\\s*\\)$/)?.[1])`
    )
  assert.equal(await sidebarAlpha(), 0.25, 'sidebar opacity is independently adjustable')
  await evaluate(`window.__surface = document.documentElement.style.getPropertyValue('--color-surface');
    document.documentElement.style.setProperty('--color-surface', 'rgba(80, 60, 100, 0.2)')`)
  assert.equal(await sidebarAlpha(), 0.25, 'theme alpha does not multiply explicit sidebar opacity')
  await setInput('#background-sidebarOpacity', '100')
  await evaluate(
    `document.querySelector('#background-sidebarOpacity').dispatchEvent(new PointerEvent('pointerup', {bubbles:true}))`
  )
  await until(`window.roxy.background.get().then(s => s.settings.sidebarOpacity === 100)`)
  assert.equal(
    await evaluate(
      `const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');
       ctx.fillStyle=getComputedStyle(document.querySelector(${JSON.stringify(sidebar)})).backgroundColor;
       ctx.fillRect(0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]`
    ),
    255,
    '100% is solid even with a translucent theme color'
  )
  await evaluate(`document.documentElement.style.setProperty('--color-surface', window.__surface)`)
  await setInput('#background-sidebarOpacity', '25')
  await evaluate(
    `document.querySelector('#background-sidebarOpacity').dispatchEvent(new PointerEvent('pointerup', {bubbles:true}))`
  )
  await until(`window.roxy.background.get().then(s => s.settings.sidebarOpacity === 25)`)
  await click('#background-theme')
  await click('#background-theme')
  assert.equal(await sidebarAlpha(), 0.25, 'changing theme color does not reset sidebar opacity')
  await click('#background-theme')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
  })
  assert.equal(
    await sidebarAlpha(),
    0.25,
    'Windows reduced transparency honors explicitly chosen opacity'
  )
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-contrast', value: 'more' }]
  })
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('#main-sidebar-harness .chat-wallpaper-shared')).display`
    ),
    'none'
  )
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector(${JSON.stringify(sidebar)})).backgroundColor.includes('0.25')`
    ),
    false,
    'high contrast stays solid'
  )
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }]
  })
  await until(`document.querySelector('#main-sidebar-harness [data-sidebar-style="dimmed"]')`)
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector(${JSON.stringify(sidebar)})).backdropFilter`
    ),
    'none'
  )
  await click('[aria-label="Sidebar background"] button:nth-child(1)')
  await until(`!document.querySelector('#main-sidebar-harness [data-sidebar-style]')`)
  assert.equal(
    await evaluate(
      `return document.querySelectorAll('#main-sidebar-harness .chat-wallpaper-shared').length`
    ),
    0
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
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-transparency', value: 'no-preference' },
      { name: 'prefers-reduced-motion', value: 'no-preference' }
    ]
  })
  await evaluate(`await window.roxy.settings.setMotion('system')`)
  for (const format of ['mp4', 'mov']) {
    await evaluate(`location.hash = '#${format}'`)
    await click('#wallpaper-settings button:has(.lucide-image-plus)')
    await until(
      `document.querySelector('#main-sidebar-harness video')?.readyState >= 2 && !document.querySelector('#main-sidebar-harness video').paused`
    )
    assert.ok(
      await evaluate(`const video=document.querySelector('#main-sidebar-harness video');
      return video.muted && video.loop && video.playsInline && !video.controls && video.videoWidth === 96 && video.videoHeight === 64`),
      `${format} is decoded, muted, and looping`
    )
    await evaluate(`window.__loopCount = 0; window.__lastTime = 0;
      document.querySelector('#main-sidebar-harness video').addEventListener('timeupdate', e => {
        if (e.target.currentTime < window.__lastTime) window.__loopCount++;
        window.__lastTime=e.target.currentTime;
      })`)
    await until(`window.__loopCount > 0`)
    await click('[aria-label="Sidebar background"] button:nth-child(2)')
    await until(
      `document.querySelector('#main-sidebar-harness .chat-wallpaper-shared video')?.paused === false`
    )
    assert.equal(
      await evaluate(`return document.querySelectorAll('#main-sidebar-harness video').length`),
      1,
      'one video spans chat and sidebar'
    )
    await evaluate(`document.querySelector('#main-sidebar-harness').setAttribute('inert','')`)
    await until(`document.querySelector('#main-sidebar-harness video').paused`)
    await evaluate(`document.querySelector('#main-sidebar-harness').removeAttribute('inert')`)
    await until(`!document.querySelector('#main-sidebar-harness video').paused`)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-transparency', value: 'no-preference' },
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ]
    })
    await until(
      `!document.querySelector('#main-sidebar-harness video') && document.querySelector('#main-sidebar-harness .chat-wallpaper-shared img')`
    )
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-transparency', value: 'no-preference' },
        { name: 'prefers-reduced-motion', value: 'no-preference' }
      ]
    })
    await until(`document.querySelector('#main-sidebar-harness video')?.paused === false`)
    await click('[aria-labelledby="background-effect-label"] button:nth-child(2)')
    await until(
      `document.querySelector('#main-sidebar-harness .chat-wallpaper-shared img')?.src.startsWith('blob:')`
    )
    assert.equal(
      await evaluate(`return document.querySelectorAll('#main-sidebar-harness video').length`),
      0,
      'processed effects use still frame'
    )
    await click('[aria-labelledby="background-effect-label"] button:nth-child(6)')
    await until(`document.querySelector('#main-sidebar-harness video')?.paused === false`)
    await win.loadURL(`${url}?background`)
    await until(`document.querySelector('#main-sidebar-harness video')?.paused === false`)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-transparency', value: 'no-preference' },
        { name: 'prefers-reduced-motion', value: 'no-preference' }
      ]
    })
    await evaluate(`await window.roxy.settings.setMotion('system')`)
    assert.equal(
      await evaluate(
        `return (await window.roxy.background.get()).image.startsWith('data:video/mp4;')`
      ),
      true,
      'video restored after reload'
    )
    await click('[aria-labelledby="background-effect-label"] button:nth-child(1)')
    await click('[aria-label="Sidebar background"] button:nth-child(1)')
  }
  await win.loadURL(`${url}?background&motion-race`)
  await until(
    `document.documentElement.dataset.motion === 'reduced' && document.querySelector('#main-sidebar-harness .chat-wallpaper img')`
  )
  assert.ok(
    await evaluate(`return (await window.roxy.background.get()).image.startsWith('data:video/')`),
    'motion bootstrap does not discard initial media load'
  )
  await evaluate(`await window.roxy.settings.setMotion('on'); location.hash='#gif'`)
  await click('#wallpaper-settings button:has(.lucide-image-plus)')
  await evaluate(`await window.roxy.settings.setMotion('system')`)
  await until(
    `document.querySelector('#main-sidebar-harness .chat-wallpaper img')?.src.startsWith('data:image/gif;')`
  )
  for (const index of [1, 2, 3, 4, 5, 6]) {
    await click(`[aria-labelledby="background-effect-label"] button:nth-child(${index})`)
    await until(`!document.querySelector('[aria-live="polite"]').textContent`)
    const selector = '#main-sidebar-harness .chat-wallpaper img'
    if (index >= 2 && index <= 5) {
      await until(`document.querySelector(${JSON.stringify(selector)})?.src.startsWith('blob:')`)
      assert.deepEqual(
        await evaluate(`const bytes = new Uint8Array(await (await fetch(document.querySelector(${JSON.stringify(selector)}).src)).arrayBuffer());
        const view = new DataView(bytes.buffer); const delays=[]; let frames=0, plays=-1;
        for(let offset=8;offset<bytes.length;){
          const size=view.getUint32(offset), type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
          if(type==='acTL'){frames=view.getUint32(offset+8);plays=view.getUint32(offset+12)}
          if(type==='fcTL')delays.push(view.getUint16(offset+28)/view.getUint16(offset+30));
          offset+=size+12;
        }
        return {frames,plays,delays};`),
        { frames: 2, plays: 0, delays: [0.1, 0.1] },
        'GIF effect retains all frames, timing, and infinite looping'
      )
    }
    const samples = new Set()
    for (let sample = 0; sample < 12; sample++) {
      await wait(70)
      samples.add(await sampleWallpaper(selector))
    }
    assert.ok(
      samples.size > 1,
      `GIF effect ${index} actually changes visible frames across multiple loops`
    )
  }
  await click('[aria-labelledby="background-effect-label"] button:nth-child(2)')
  await click('[aria-label="Sidebar background"] button:nth-child(3)')
  await until(
    `document.querySelector('#main-sidebar-harness .chat-wallpaper-shared img')?.src.startsWith('blob:')`
  )
  const sharedSource = await evaluate(
    `return document.querySelector('#main-sidebar-harness .chat-wallpaper-shared img').src`
  )
  await setInput('#background-sidebarOpacity', '25')
  await evaluate(
    `document.querySelector('#background-sidebarOpacity').dispatchEvent(new PointerEvent('pointerup', {bubbles:true}))`
  )
  assert.equal(
    await evaluate(
      `return document.querySelector('#main-sidebar-harness .chat-wallpaper-shared img').src`
    ),
    sharedSource,
    'opacity adjustments do not restart GIF processing'
  )
  const sharedSamples = new Set()
  for (let i = 0; i < 12; i++) {
    await wait(70)
    sharedSamples.add(await sampleWallpaper('#main-sidebar-harness .chat-wallpaper-shared img'))
  }
  assert.ok(sharedSamples.size > 1, 'full-window dithered GIF changes frames too')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-transparency', value: 'no-preference' },
      { name: 'prefers-reduced-motion', value: 'reduce' }
    ]
  })
  await until(`document.documentElement.dataset.motion === 'reduced' && !document.querySelector('[aria-live="polite"]').textContent
    && document.querySelector('#main-sidebar-harness .chat-wallpaper-shared img')?.src !== ${JSON.stringify(sharedSource)}`)
  assert.equal(
    await evaluate(`const bytes=new Uint8Array(await (await fetch(document.querySelector('#main-sidebar-harness .chat-wallpaper-shared img').src)).arrayBuffer());
    return new TextDecoder().decode(bytes).includes('acTL');`),
    false,
    'reduced-motion dither output is a still frame'
  )
  const stillSample = await sampleWallpaper('#main-sidebar-harness .chat-wallpaper-shared img')
  await wait(250)
  assert.equal(
    await sampleWallpaper('#main-sidebar-harness .chat-wallpaper-shared img'),
    stillSample,
    'wallpaper sampling does not mistake unrelated UI changes for animation'
  )
  await click('[aria-label="Sidebar background"] button:nth-child(1)')
  await click('[aria-labelledby="background-effect-label"] button:nth-child(1)')
  await until(
    `document.querySelector('#main-sidebar-harness .chat-wallpaper img')?.src.startsWith('data:image/png;')`
  )
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-transparency', value: 'no-preference' },
      { name: 'prefers-reduced-motion', value: 'no-preference' }
    ]
  })
  await until(
    `document.querySelector('#main-sidebar-harness .chat-wallpaper img')?.src.startsWith('data:image/gif;')`
  )
  await evaluate(`location.hash=''`)
  await evaluate(`await window.roxy.settings.setMotion('on')`)
  await evaluate(`await window.roxy.background.update({ sidebarOpacity:25 })`)
  await click('#wallpaper-settings button:has(.lucide-image-plus)')
  await until(
    `document.querySelector('#main-sidebar-harness .chat-wallpaper img')?.src === ${JSON.stringify(original)}`
  )
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }]
  })
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
  for (const name of ['prefers-reduced-transparency', 'prefers-contrast']) {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name, value: name === 'prefers-contrast' ? 'more' : 'reduce' }]
    })
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('[data-wallpaper] .chat-wallpaper')).display`
      ),
      name === 'prefers-contrast' ? 'none' : 'block'
    )
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('.composer-panel'), '::before').backdropFilter`
      ),
      'none'
    )
  }
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }]
  })
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
  assert.equal(
    await evaluate(`return (await window.roxy.background.get()).settings.sidebarOpacity`),
    25,
    'reload retains sidebar opacity'
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
  await until(`!!document.querySelector('#settings-activity-panel tbody')`)
  assert.equal(
    await evaluate(
      `return document.querySelector('#settings-activity').getAttribute('aria-current')`
    ),
    'page',
    'Settings opens on Activity by default'
  )
  assert.deepEqual(
    await evaluate(
      `return [...document.querySelectorAll('#settings-activity-panel dl dd:first-of-type')].map(el => el.textContent)`
    ),
    ['24', '3', '2', '2'],
    'activity summary uses real turn totals and streaks'
  )
  assert.deepEqual(
    await evaluate(
      `return [...document.querySelectorAll('#settings-activity-panel tbody td')].map(el => el.textContent)`
    ),
    ['12', '8', '0', '4', '0', '0', '0'],
    'recent activity includes exact daily counts and idle days'
  )
  await click('#settings-background')
  assert.deepEqual(
    await evaluate(`return [...document.querySelectorAll('nav button')].map(b => b.textContent)`),
    [
      'Background',
      'Colors',
      'Motion',
      'Skills',
      'MCP',
      'Backup & restore',
      'Accounts',
      'Browser',
      'Language',
      'Voice Translation',
      'Worktree configuration',
      'Notifications',
      'Remote',
      'Activity',
      'Privacy',
      'About'
    ]
  )
  assert.equal(
    await evaluate(
      `return document.querySelector('#settings-background').getAttribute('aria-current')`
    ),
    'page'
  )
  assert.equal(
    await evaluate(`return document.querySelector('#settings-colors-panel').checkVisibility()`),
    false
  )
  assert.ok(
    await evaluate(
      `return document.querySelector('#appearance-page aside').getBoundingClientRect().right <= document.querySelector('#settings-background-panel').getBoundingClientRect().left`
    ),
    'menu sits on the left'
  )
  // Remote is reachable from Settings without losing the page on dialog close.
  await click('#settings-remote')
  await click('#settings-remote-panel button')
  assert.ok(
    await evaluate(`const dialog=document.querySelector('[role="dialog"][aria-modal="true"]');
    const box=dialog.getBoundingClientRect();
    return dialog.parentElement === document.body && box.x === 0 && box.y === 0 && box.width === innerWidth && box.height === innerHeight;
  `),
    'remote dialog remains viewport-wide within Settings'
  )
  await click('[role="dialog"][aria-modal="true"] button:has(.lucide-x)')
  assert.equal(await evaluate(`return !!document.querySelector('#appearance-page')`), true)
  await click('#settings-background')
  await click('#settings-background-panel button:has(.lucide-image-plus)')
  await until(`!!document.querySelector('#settings-background-panel .chat-wallpaper')`)
  const wallpaper = await evaluate(`return (await window.roxy.background.get()).image`)
  const settingsHost = '#appearance-page .chat-background-host'
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('${settingsHost} > .chat-wallpaper')).opacity`
    ),
    '0.58',
    'Settings uses the saved empty-page opacity outside the preview'
  )
  for (const style of ['glass', 'dimmed']) {
    await evaluate(
      `await window.roxy.background.update({sidebarStyle:'${style}',sidebarOpacity:25,emptyOpacity:42,showOn:'empty',effect:'haze'})`
    )
    await until(`document.querySelector('#appearance-page [data-sidebar-style="${style}"]')`)
    assert.deepEqual(
      (await sidebarStyles())[0],
      (await sidebarStyles())[1],
      `${style} applies the same sidebar preferences in Settings and chat`
    )
    assert.equal(
      await evaluate(
        `return document.querySelectorAll('#appearance-page .chat-wallpaper-shared').length`
      ),
      1,
      'one wallpaper spans the Settings sidebar and content'
    )
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('${settingsHost}'), '::before').opacity`
      ),
      '0.58',
      'Settings dims content independently of sidebar opacity, including empty-only scope'
    )
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('#appearance-page aside'), '::before').backdropFilter`
      ),
      style === 'glass' ? 'blur(18px) saturate(1.2)' : 'none'
    )
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('#settings-background-panel .background-preview-host'), '::before').content`
      ),
      'none',
      'shared page styling does not add an opaque overlay to the preview'
    )
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('#appearance-page .chat-wallpaper-shared img')).filter`
      ),
      'blur(12px) saturate(0.85)'
    )
    await click('#settings-activity')
    assert.ok(
      await evaluate(
        `return document.querySelector('${settingsHost}').hasAttribute('data-wallpaper')`
      )
    )
    await click('#settings-background')
  }
  await evaluate(`await window.roxy.background.update({sidebarStyle:'glass'})`)
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
  })
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('#appearance-page aside'), '::before').backdropFilter`
    ),
    'none'
  )
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-contrast', value: 'more' }]
  })
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('#appearance-page .chat-wallpaper-shared')).display`
    ),
    'none'
  )
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('${settingsHost}'), '::before').opacity`
    ),
    '1'
  )
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }]
  })
  await evaluate(`await window.roxy.background.remove()`)
  await until(`!document.querySelector('#appearance-page [data-sidebar-style]')`)
  assert.equal(
    await evaluate(
      `return document.querySelectorAll('#appearance-page .chat-wallpaper, #appearance-page .chat-wallpaper-shared').length`
    ),
    0,
    'removing the background restores solid Settings chrome'
  )
  await evaluate(
    `await window.roxy.background.choose(); await window.roxy.background.update({sidebarStyle:'default',effect:'none',showOn:'all'})`
  )
  await click('#settings-colors')
  assert.equal(
    await evaluate(`return document.querySelector('#settings-background-panel').checkVisibility()`),
    false
  )
  await evaluate(
    `const panel=document.querySelector('#settings-colors-panel'); [...panel.querySelectorAll('button')].find(b => b.textContent.trim()==='Apply').click()`
  )
  await until(`document.documentElement.dataset.appearance === 'light'`)
  assert.deepEqual(
    (await sidebarStyles())[0],
    (await sidebarStyles())[1],
    'both sidebars respond identically to a light theme'
  )
  assert.equal(await evaluate(`return (await window.roxy.background.get()).image`), wallpaper)
  await evaluate(
    `const panel=document.querySelector('#settings-colors-panel'); [...panel.querySelectorAll('button')].find(b => b.textContent.trim()==='New theme').click()`
  )
  await until(`!!document.querySelector('#settings-colors-panel textarea')`)
  const draft = '{"id":"custom-0","name":"Unsaved draft","colors":{"bg":"#131026"}}'
  await setInput('#settings-colors-panel textarea', draft, 'HTMLTextAreaElement')
  await evaluate(
    `window.__appearanceEditor = document.querySelector('#settings-colors-panel textarea'); window.__appearanceEditor.scrollIntoView()`
  )
  await click('#settings-background')
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
      `const a=getComputedStyle(document.querySelector('#settings-background')); const b=getComputedStyle(document.querySelector('#main-sidebar-harness button:has(.lucide-settings)'));return [a.padding,a.gap,a.fontSize].join('|') === [b.padding,b.gap,b.fontSize].join('|')`
    ),
    true,
    'navigation shares spacing and typography'
  )
  const styles = await evaluate(
    `const e=document.createElement('div');e.style.background='var(--color-elevated)';document.body.append(e);const value=getComputedStyle(e).backgroundColor;e.remove();return value`
  )
  // The shared row has a 140ms color transition; wait for the selected state to settle.
  await until(
    `getComputedStyle(document.querySelector('#settings-background')).backgroundColor === ${JSON.stringify(styles)}`
  )
  assert.equal(
    await evaluate(
      `return getComputedStyle(document.querySelector('#settings-background')).backgroundColor`
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
  await click('#settings-colors')
  assert.equal(
    await evaluate(
      `return document.querySelector('#settings-colors-panel textarea') === window.__appearanceEditor`
    ),
    true
  )
  assert.equal(
    await evaluate(`return document.querySelector('#settings-colors-panel textarea').value`),
    draft,
    'panel switch preserves unsaved JSON'
  )
  for (const width of [1440, 1000, 760, 390]) {
    win.setSize(width, 844)
    await wait()
    for (const panel of [
      'background',
      'colors',
      'motion',
      'skills',
      'mcp',
      'backup',
      'accounts',
      'browser',
      'language',
      'worktrees',
      'notifications',
      'remote',
      'activity',
      'privacy',
      'about'
    ]) {
      if (width < 640) await setInput('#settings-section', panel, 'HTMLSelectElement')
      else await click(`#settings-${panel}`)
      if (panel === 'background') {
        assert.ok(
          await evaluate(`const tracks = [...document.querySelectorAll('#settings-background-panel input[type="range"]')].map(el => el.getBoundingClientRect());
            const labels = [...document.querySelectorAll('#settings-background-panel output')].map(el => el.getBoundingClientRect());
            return tracks.length === 3 && tracks.every(box => Math.abs(box.width - tracks[0].width) < 1 && Math.abs(box.x - tracks[0].x) < 1)
              && labels.every(box => Math.abs(box.x - labels[0].x) < 1 && Math.abs(box.width - labels[0].width) < 1);`),
          `slider tracks and percentage labels align at ${width}px`
        )
      }
      assert.ok(
        await evaluate(
          `const p=document.querySelector('#settings-${panel}-panel');return p.scrollWidth <= p.clientWidth`
        ),
        `${panel} fits at ${width}px`
      )
    }
  }
  assert.ok(
    await evaluate(
      `return document.querySelector('#appearance-page aside').getBoundingClientRect().bottom <= document.querySelector('#settings-about-panel').getBoundingClientRect().top`
    ),
    'narrow menu moves above panel'
  )
  win.setSize(1440, 1000)
  win.focus()
  await wait()
  await evaluate(`document.querySelector('#settings-background').focus()`)
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
      `return document.querySelector('#settings-background').getAttribute('aria-current')`
    ),
    'page',
    'menu works with keyboard'
  )
  win.setSize(1440, 1000)
  await click('#settings-skills')
  await evaluate(
    `[...document.querySelectorAll('#settings-skills-panel button')].find(b => b.textContent.trim() === 'New skill').click()`
  )
  await setInput('#settings-skills-panel input', 'draft-skill')
  await click('#settings-mcp')
  await evaluate(
    `[...document.querySelectorAll('#settings-mcp-panel button')].find(b => b.textContent.trim() === 'Add MCP server').click()`
  )
  await setInput('#settings-mcp-panel input', 'draft-server')
  await click('#settings-browser')
  await click('#settings-skills')
  assert.equal(
    await evaluate(`return document.querySelector('#settings-skills-panel input').value`),
    'draft-skill',
    'skill draft survives section changes'
  )
  await click('#settings-mcp')
  assert.equal(
    await evaluate(`return document.querySelector('#settings-mcp-panel input').value`),
    'draft-server',
    'MCP draft survives section changes'
  )
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
  assert.equal(
    await evaluate(
      `return document.querySelectorAll('#main-sidebar-harness button:has(.lucide-settings)').length`
    ),
    1,
    'one Settings entry in expanded sidebar'
  )
  await click('#main-sidebar-harness button:has(.lucide-panel-left-close)')
  assert.equal(
    await evaluate(
      `return document.querySelectorAll('#main-sidebar-harness button:has(.lucide-settings)').length`
    ),
    1,
    'one Settings entry in collapsed rail'
  )
  assert.equal(
    await evaluate(
      `return document.querySelectorAll('#main-sidebar-harness button:has(.lucide-lightbulb), #main-sidebar-harness button:has(.lucide-plug), #main-sidebar-harness button:has(.lucide-palette), #main-sidebar-harness button:has(.lucide-monitor-smartphone)').length`
    ),
    0,
    'no separate utility entries remain'
  )
  assert.deepEqual(errors, [])
  console.log(
    'BACKGROUND UI OK: six effects, glass, canvas alpha/repaint, persistence, accessibility, grouped settings, theme/skill/MCP draft retention and all narrow panels'
  )
}
app
  .whenReady()
  .then(run)
  .then(async () => {
    win?.destroy()
    await server?.close()
    cleanup()
    app.exit(0)
  })
  .catch(async (error) => {
    console.error(error)
    console.error(errors)
    win?.destroy()
    await server?.close()
    cleanup()
    app.exit(1)
  })
