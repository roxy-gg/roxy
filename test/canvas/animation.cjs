const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const temp = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'roxy-canvas-motion-'))
app.setPath('userData', temp)
let server, win
let checks = 0
const errors = []
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (name, value) => {
  assert.ok(value, name)
  checks++
  console.log(`  OK ${name}`)
}
const evaluate = (code) => win.webContents.executeJavaScript(`{ ${code} }`, true)
const inspect = (pixels = true) =>
  evaluate(`(() => {
  const probe=window.__canvasTranscript, scene=probe.scene(); const el=document.querySelector('[data-canvas-surface]');
  const text=scene.blocks.flatMap(b=>b.selectable).map(l=>l.text).join('');
  const tokens=[...text.matchAll(/token([0-9]+)/g)].map(m=>Number(m[1]));
  return { frames:probe.debug.frames, layouts:probe.debug.layouts, produced:window.__motionTest.produced, painted:window.__motionTest.painted,
    latest:tokens.length?Math.max(...tokens):0, hash:${pixels ? "document.querySelector('canvas').toDataURL()" : 'null'},
    visibility:document.visibilityState, reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
    effective:document.documentElement.dataset.motion,
    atBottom:Math.abs(el.scrollHeight-el.scrollTop-el.clientHeight)<2, now:performance.now() };
})()`)
const click = async (id) => {
  await evaluate(`document.querySelector('#${id}').click()`)
  await wait(100)
}
const media = async (value) => {
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }]
  })
  await wait(80)
}
const chooseMotion = async (value) => {
  await evaluate(`const el=document.querySelector('#motion');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});
    el.dispatchEvent(new Event('change',{bubbles:true}));`)
  await wait(100)
}

async function run() {
  const outfile = path.join(__dirname, '../.out/motion-settings.cjs')
  require('esbuild').buildSync({
    stdin: {
      contents: `export {getSettings,setMotion,resetAll} from './src/main/db/repo';
      export {getDb,closeDb} from './src/main/db/database';`,
      resolveDir: path.join(__dirname, '../..')
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile
  })
  const settings = require(outfile)
  try {
    check('fresh install enables motion by default', settings.getSettings().motion === 'on')
    settings.setMotion('reduced')
    settings.closeDb()
    check('reduced motion survives reopening SQLite', settings.getSettings().motion === 'reduced')
    settings.setMotion('system')
    settings.closeDb()
    check('Follow system survives reopening SQLite', settings.getSettings().motion === 'system')
    settings.setMotion('on')
    check(
      'On clears the override and reads as the default',
      settings.getSettings().motion === 'on' &&
        !settings.getDb().prepare("SELECT value FROM settings WHERE key='motion'").get()
    )
    settings.getDb().prepare("INSERT INTO settings(key,value) VALUES('motion','unknown')").run()
    check(
      'unknown persisted motion values fall back safely',
      settings.getSettings().motion === 'on'
    )
    settings.setMotion('reduced')
    settings.resetAll()
    check('factory reset restores normal motion', settings.getSettings().motion === 'on')
  } finally {
    settings.closeDb()
  }
  const { createServer } = await import('vite')
  server = await createServer({
    configFile: path.join(__dirname, 'vite.config.mjs'),
    server: { host: '127.0.0.1', port: 3114, strictPort: true }
  })
  await server.listen()
  // Use the app's default throttling policy rather than masking issues with backgroundThrottling:false.
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  win.setAlwaysOnTop(true)
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })
  await win.loadURL('http://127.0.0.1:3114/?animation')
  win.show()
  win.focus()
  await wait(1700)
  console.log(
    'Native canvas state',
    await evaluate(
      `({visible:document.visibilityState,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches})`
    )
  )
  win.webContents.debugger.attach('1.3')
  check(
    'Settings starts at On',
    await evaluate(
      `document.querySelector('#motion').value==='on' && document.documentElement.dataset.motion==='full'`
    )
  )
  await media('reduce')
  check(
    'On keeps normal motion despite the OS setting',
    await evaluate(
      `matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.motion==='full'`
    )
  )
  check(
    'CSS animations use the same default as canvas',
    await evaluate(
      `getComputedStyle(document.querySelector('[data-motion-css]')).animationName==='spin'`
    )
  )
  await chooseMotion('reduced')
  check(
    'Settings immediately reduces CSS and canvas motion',
    await evaluate(
      `document.documentElement.dataset.motion==='reduced' && getComputedStyle(document.querySelector('[data-motion-css]')).animationName==='pulse'`
    )
  )
  check(
    'setting saves through the store and bridge',
    await evaluate(
      `localStorage.getItem('roxy.test.motion')==='reduced' && localStorage.getItem('roxy.motion.v1')==='reduced'`
    )
  )
  await media('no-preference')
  check(
    'explicit Reduced does not depend on OS settings',
    await evaluate(
      `document.documentElement.dataset.motion==='reduced' && !matchMedia('(prefers-reduced-motion: reduce)').matches`
    )
  )
  await win.reload()
  await wait(1600)
  check(
    'saved motion is restored after window reload',
    await evaluate(
      `document.querySelector('#motion').value==='reduced' && document.documentElement.dataset.motion==='reduced'`
    )
  )
  await chooseMotion('system')
  check(
    'Follow system enables normal motion on an unreduced OS',
    await evaluate(`document.documentElement.dataset.motion==='full'`)
  )
  await media('reduce')
  check(
    'Follow system observes OS changes live',
    await evaluate(`document.documentElement.dataset.motion==='reduced'`)
  )
  await chooseMotion('on')
  check(
    'On restores full animation without modifying the OS',
    await evaluate(
      `document.documentElement.dataset.motion==='full' && matchMedia('(prefers-reduced-motion: reduce)').matches`
    )
  )
  await evaluate(`window.__canvasTest.motionSaveFails=true`)
  await chooseMotion('reduced')
  check(
    'a failed save restores the previous preference and reports an error',
    await evaluate(
      `document.querySelector('#motion').value==='on' && document.querySelector('[role="alert"]')?.textContent.includes("Couldn't save") && document.documentElement.dataset.motion==='full'`
    )
  )
  await evaluate(`window.__canvasTest.motionSaveFails=false`)
  await chooseMotion('system')
  await click('motion-tools')
  await click('motion-thinking')
  const nativeFirst = await inspect()
  await wait(380)
  const nativeNext = await inspect()
  check(
    'initial reduced-motion thinking feedback remains alive',
    nativeNext.frames > nativeFirst.frames && nativeNext.hash !== nativeFirst.hash
  )
  await media('no-preference')
  await click('motion-tools')
  await click('motion-thinking')
  await wait(1400)
  let a = await inspect()
  await wait(320)
  let b = await inspect()
  console.log('Thinking frames', b.frames - a.frames, 'layouts', b.layouts - a.layouts)
  check(
    'thinking advances without new text or pointer input',
    b.frames - a.frames >= 5 && a.hash !== b.hash
  )
  check('idle progress animation does not rebuild layout', a.layouts === b.layouts)
  await click('motion-tools')
  a = await inspect()
  await wait(320)
  b = await inspect()
  check('tool spinners continue across frames', b.frames - a.frames >= 5 && a.hash !== b.hash)
  await media('reduce')
  a = await inspect()
  await wait(400)
  b = await inspect()
  check('reduced-motion progress is gentle, not frozen', b.frames > a.frames && a.hash !== b.hash)
  await media('no-preference')
  a = await inspect()
  await wait(320)
  b = await inspect()
  check(
    'normal animation resumes when OS motion preference changes',
    b.frames - a.frames >= 5 && a.hash !== b.hash
  )
  await click('motion-large')
  a = await inspect()
  await wait(320)
  b = await inspect()
  check(
    'progress also animates beside windowed history',
    b.frames - a.frames >= 5 && a.hash !== b.hash
  )
  await evaluate(`document.querySelector('[data-canvas-surface]').scrollTop=0`)
  await wait(100)
  a = await inspect(false)
  await wait(320)
  b = await inspect(false)
  check('offscreen progress does not keep repainting old messages', a.frames === b.frames)
  await evaluate(
    `const el=document.querySelector('[data-canvas-surface]');el.scrollTop=el.scrollHeight`
  )
  await wait(100)
  a = await inspect()
  await wait(320)
  b = await inspect()
  check('returning to live tools resumes the clock', b.frames - a.frames >= 5 && a.hash !== b.hash)
  await click('motion-large')
  win.hide()
  await wait(150)
  a = await inspect(false)
  await wait(320)
  b = await inspect(false)
  check(
    'hidden canvas pauses continuous animation',
    a.visibility === 'hidden' && a.frames === b.frames
  )
  win.show()
  win.focus()
  await wait(120)
  a = await inspect()
  await wait(320)
  b = await inspect()
  check(
    'showing the window resumes animation without new tokens',
    b.frames - a.frames >= 5 && a.hash !== b.hash
  )
  for (const [large, reduced] of [
    [false, false],
    [true, false],
    [true, true]
  ]) {
    if (large && !reduced) await click('motion-large')
    await media(reduced ? 'reduce' : 'no-preference')
    await click('motion-text')
    const samples = []
    for (let i = 0; i < 24; i++) {
      await wait(60)
      const s = await inspect(false)
      samples.push(s)
    }
    const final = samples.at(-1)
    const changes = samples.filter((s, i) => i > 0 && s.painted !== samples[i - 1].painted).length
    const worstBehind = Math.max(...samples.map((s) => s.produced - s.painted))
    console.log('Streaming cadence', {
      large,
      reduced,
      changes,
      worstBehind,
      painted: final.painted,
      produced: final.produced
    })
    check(
      `${large ? 'windowed' : 'short'} transcript shows tokens as produced${reduced ? ' with reduced motion' : ''}`,
      final.painted === 80 && changes >= 8 && worstBehind <= 8
    )
    check('streaming remains pinned without a typewriter backlog', final.atBottom)
    await click('motion-thinking')
  }
  await click('motion-done')
  await wait(150)
  a = await inspect()
  await wait(320)
  b = await inspect()
  check('settled transcript stops the animation clock', a.frames === b.frames)
  check('no renderer errors during animation', errors.length === 0)
  console.log(`CANVAS MOTION OK - ${checks} checks passed`)
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    console.error('Motion test timed out')
    app.exit(2)
  }, 60000)
  let code = 0
  try {
    await run()
  } catch (error) {
    console.error(error)
    console.error(errors)
    code = 1
  }
  clearTimeout(watchdog)
  win?.destroy()
  await server?.close()
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  app.exit(code)
})
