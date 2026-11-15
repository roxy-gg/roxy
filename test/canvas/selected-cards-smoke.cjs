const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = process.cwd()
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'roxy-selected-cards-'))
app.setPath('userData', profile)
let win, server
const errors = []
const wait = () => new Promise((resolve) => setTimeout(resolve, 75))
const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`)
const until = async (code) => {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(`return ${code}`)) return
    await wait()
  }
  throw new Error(`Timed out: ${code}`)
}
const wallpaper = async () =>
  evaluate(`
  document.documentElement.dataset.platform = 'darwin';
  document.documentElement.dataset.glass = '';
  const image = document.createElement('img');
  image.src = '/@fs/${root}/test/fixtures/background.gif';
  await image.decode();
  image.id = 'regression-wallpaper';
  Object.assign(image.style, {position:'fixed',inset:'0',width:'100%',height:'100%',objectFit:'cover',zIndex:'-1'});
  document.body.prepend(image);
`)
const inspect = (selector) =>
  evaluate(`
  const cards = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const probe = document.createElement('div');
  probe.style.backgroundColor = 'color-mix(in oklab, var(--color-accent) 5%, transparent)';
  document.body.append(probe);
  const expected = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return {expected, cards: cards.map(card => {
    const style = getComputedStyle(card);
    return {fill: style.backgroundColor, opacity: style.opacity, ring: card.className.includes('--sq-ring:color-mix'), border: style.borderColor};
  })};
`)
const check = (result, count, label) => {
  assert.equal(result.cards.length, count, label)
  assert(result.expected.includes('0.05'), `${label}: accent tint stays translucent`)
  for (const card of result.cards) {
    assert.equal(card.fill, result.expected, `${label}: all cards use the translucent accent tint`)
    assert.equal(card.opacity, '1', `${label}: no opacity loss`)
  }
  assert.equal(
    result.cards.filter((card) => card.ring).length,
    1,
    `${label}: exactly one selected ring`
  )
}
app.whenReady().then(async () => {
  let failed = false
  try {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(root, 'test/canvas/vite.config.mjs'),
      server: {
        host: '127.0.0.1',
        port: 3107,
        strictPort: true,
        fs: { allow: [root, fs.realpathSync('node_modules')] }
      }
    })
    await server.listen()
    win = new BrowserWindow({
      width: 1100,
      height: 820,
      show: true,
      webPreferences: { contextIsolation: true, backgroundThrottling: false }
    })
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) errors.push(message)
    })
    await win.loadURL('http://127.0.0.1:3107/?voice')
    await until(`!!document.querySelector('#voice-ready') && !!document.querySelector('article')`)
    await wallpaper()
    await evaluate(`document.querySelector('#voice-ready').click()`)
    await until(`document.querySelector('article').className.includes('border-accent')`)
    const themes = await evaluate(`
      const {BUILT_IN_THEMES,resolveTheme} = await import('/@fs/${root}/src/shared/theme.ts');
      const {applyTheme} = await import('/@fs/${root}/src/renderer/src/lib/theme.ts');
      window.cardTestThemes = BUILT_IN_THEMES;
      window.cardTestApply = index => applyTheme(resolveTheme(BUILT_IN_THEMES[index]));
      return BUILT_IN_THEMES.map(theme => ({id:theme.id,name:theme.name}));
    `)
    for (let i = 0; i < themes.length; i++) {
      await evaluate(
        `window.cardTestApply(${i}); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)`
      )
      await new Promise((resolve) => setTimeout(resolve, 350))
      check(await inspect('article'), 2, `Voice ${themes[i].id}`)
    }
    console.log(
      `Voice selected/inactive card fills and rings: ${themes.length} built-in themes passed over decoded GIF wallpaper fixture.`
    )
    await win.loadURL('http://127.0.0.1:3107/?appearance')
    await until(`!!document.querySelector('#settings-search')`)
    await wallpaper()
    await evaluate(
      `const button=document.querySelector('#settings-colors'); if (!button) throw Error('Color Theme navigation missing'); button.click()`
    )
    const selector = '#appearance-page .group.flex.flex-col.gap-3'
    await until(
      `document.querySelectorAll(${JSON.stringify(selector)}).length === ${themes.length}`
    )
    for (let step = 0; step < themes.length; step++) {
      const i = (step + 1) % themes.length
      await evaluate(
        `const card=document.querySelectorAll(${JSON.stringify(selector)})[${i}]; const button=card.querySelector('button'); if (!button.disabled) button.click()`
      )
      await until(
        `document.documentElement.dataset.theme === ${JSON.stringify(themes[i].id)} && document.querySelectorAll(${JSON.stringify(selector)})[${i}].querySelector('button').textContent.includes('Applied')`
      )
      await evaluate(
        `await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)`
      )
      await new Promise((resolve) => setTimeout(resolve, 350))
      check(await inspect(selector), themes.length, `Themes ${themes[i].id}`)
    }
    console.log(
      `Themes production Apply buttons: ${themes.length} built-in themes passed with consistent selected/inactive card fills.`
    )
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error(error)
    console.error(errors)
    failed = true
  } finally {
    win?.destroy()
    await server?.close()
    fs.rmSync(profile, { recursive: true, force: true })
    app.exit(failed ? 1 : 0)
  }
})
