const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roxy-settings-search-'))
app.setPath('userData', temp)
let win,
  server,
  failed = false
const errors = []
const fsUrl = (file) => path.posix.join('/@fs/', path.resolve(file).replaceAll('\\', '/'))
const wait = () => new Promise((resolve) => setTimeout(resolve, 60))
const evaluate = async (code) => {
  try {
    return await win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
  } catch (error) {
    throw new Error(`Browser evaluation failed: ${code}`, { cause: error })
  }
}
async function until(code) {
  for (let n = 0; n < 100; n++) {
    if (await evaluate(`return ${code}`)) return
    await wait()
  }
  throw Error(`Timed out: ${code}`)
}
async function input(selector, value) {
  await evaluate(`const el = document.querySelector(${JSON.stringify(selector)});
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) throw new Error('Not an input: ' + el?.outerHTML);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', {bubbles: true}));`)
  await wait()
}
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait()
}
async function key(keyCode) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  await wait()
}
async function screenshot(name) {
  const directory = process.env.SETTINGS_SEARCH_SCREENSHOTS
  if (!directory) return
  fs.mkdirSync(directory, { recursive: true })
  await evaluate(`await document.fonts.ready`)
  fs.writeFileSync(
    path.join(directory, name + '.png'),
    (await win.webContents.capturePage()).toPNG()
  )
}
app.whenReady().then(async () => {
  try {
    let url = process.env.CANVAS_TEST_URL
    if (!url) {
      const { createServer } = await import('vite')
      server = await createServer({
        configFile: path.join(__dirname, 'vite.config.mjs'),
        server: {
          host: '127.0.0.1',
          port: Number(process.env.ROXY_TEST_PORT || 3105),
          strictPort: true,
          fs: { allow: [path.resolve('.'), fs.realpathSync('node_modules')] }
        }
      })
      await server.listen()
      url = server.resolvedUrls.local[0]
    }
    win = new BrowserWindow({
      width: 1200,
      height: 900,
      show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3 && !message.includes('Failed to load resource')) errors.push(message)
    })
    await win.loadURL(`${url}?appearance`)
    await until(`!!document.querySelector('#settings-search')`)
    await evaluate(`document.querySelector('#settings-search').blur()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'f', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'f', modifiers: ['control'] })
    await until(`document.activeElement.id === 'settings-search'`)
    assert(
      await evaluate(
        `return document.querySelector('#settings-activity-panel').getBoundingClientRect().height > 0`
      )
    )
    await input('#settings-search', 'BRANCH prefix')
    await until(`document.querySelectorAll('#settings-search-results button').length === 1`)
    assert.match(
      await evaluate(`return document.querySelector('#settings-search-results').textContent`),
      /Worktree configuration/
    )
    assert(
      (await evaluate(`return document.querySelectorAll('mark.settings-search-match').length`)) > 0
    )
    assert.equal(
      await evaluate(`return getComputedStyle(document.querySelector('mark')).backgroundColor`),
      'rgba(0, 0, 0, 0)'
    )
    await evaluate(`document.querySelector('#settings-search').focus()`)
    await key('Down')
    assert.equal(await evaluate(`return document.activeElement.id`), 'settings-search')
    assert.equal(
      await evaluate(
        `return document.querySelector('#settings-search').getAttribute('aria-activedescendant')`
      ),
      'settings-search-result-0'
    )
    await key('Return')
    await until(`!!document.querySelector('#settings-branch-prefix.settings-search-target')`)
    assert.equal(await evaluate(`return document.activeElement.id`), 'settings-branch-prefix')
    await screenshot('desktop-dark')
    const setupInput = '#worktree-setup-command'
    const setupSave = '#worktree-setup-command + button'
    assert.equal(await evaluate(`return document.querySelector('${setupInput}').value`), '')
    assert(await evaluate(`return document.querySelector('${setupSave}').disabled`))
    await input(setupInput, 'npm ci\necho ready')
    assert(!(await evaluate(`return document.querySelector('${setupSave}').disabled`)))
    await click(setupSave)
    await until(`document.querySelector('${setupSave}').disabled`)
    await evaluate(`const {useRoxyStore} = await import(${JSON.stringify(fsUrl('src/renderer/src/lib/store.ts'))});
      if (useRoxyStore.getState().settings.worktreeSetupCommand !== 'npm ci\\necho ready') throw new Error('setup did not persist');`)
    await input(setupInput, '')
    await click(setupSave)
    await until(`document.querySelector('${setupSave}').disabled`)
    await input(setupInput, 'unsaved-setup')
    const freshSwitch =
      '#settings-worktrees-panel [role="switch"][aria-label="Auto-reset new workstreams to remote main"]'
    assert.equal(
      await evaluate(
        `return document.querySelector(${JSON.stringify(freshSwitch)}).getAttribute('aria-checked')`
      ),
      'false'
    )
    await click(freshSwitch)
    await until(
      `document.querySelector(${JSON.stringify(freshSwitch)}).getAttribute('aria-checked') === 'true'`
    )
    await click(freshSwitch)
    await until(
      `document.querySelector(${JSON.stringify(freshSwitch)}).getAttribute('aria-checked') === 'false'`
    )
    for (const width of [360, 1440]) {
      win.setContentSize(width, 900)
      await wait()
      assert(
        await evaluate(`return document.documentElement.scrollWidth <= innerWidth`),
        `workstream settings do not overflow at ${width}px`
      )
      assert(
        await evaluate(
          `const r = document.querySelector(${JSON.stringify(freshSwitch)}).getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth`
        ),
        `fresh toggle is accessible at ${width}px`
      )
      assert(
        await evaluate(
          `const r = document.querySelector('${setupInput}').getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth`
        ),
        `setup command is accessible at ${width}px`
      )
      await screenshot('fresh-workstreams-' + width)
    }
    win.setContentSize(1200, 900)
    assert(
      await evaluate(
        `return document.querySelector('#settings-search-results').closest('[data-sidebar-frame]') !== null`
      )
    )
    assert.equal(
      await evaluate(`return document.querySelector('#settings-search').value`),
      'BRANCH prefix'
    )
    await input('#settings-worktrees-panel input:not([type])', 'unsaved-prefix')
    await input('#settings-search', 'notifications')
    await until(`document.querySelectorAll('#settings-search-results button').length >= 2`)
    await evaluate(`document.querySelector('#settings-search').focus()`)
    await key('Down')
    assert.equal(
      await evaluate(
        `return document.querySelector('#settings-search').getAttribute('aria-activedescendant')`
      ),
      'settings-search-result-1'
    )
    await key('Up')
    assert.equal(
      await evaluate(
        `return document.querySelector('#settings-search').getAttribute('aria-activedescendant')`
      ),
      'settings-search-result-0'
    )
    await click('#settings-search-results button')
    await until(`!!document.querySelector('.settings-search-target')`)
    assert.equal(
      await evaluate(
        `return document.querySelector('#settings-worktrees-panel input:not([type])').value`
      ),
      'unsaved-prefix'
    )
    assert.equal(
      await evaluate(`return document.querySelector('${setupInput}').value`),
      'unsaved-setup'
    )
    await input('#settings-search', 'new worktree command')
    await until(`document.querySelectorAll('#settings-search-results button').length === 1`)
    await click('#settings-search-results button')
    await until(`!!document.querySelector('#settings-worktree-setup.settings-search-target')`)
    await input('#settings-search', 'cheat')
    await until(`document.querySelectorAll('#settings-search-results button').length >= 1`)
    await click('#settings-search-results button')
    await until(`!!document.querySelector('#settings-cheat-title.settings-search-target')`)
    await until(`!!document.querySelector('[data-cheat-control]')`)
    assert.equal(
      await evaluate(`return document.querySelectorAll('#settings-cheat-title').length`),
      1,
      'the search destination ID stays unique after Cheat Tools loads'
    )
    await input('#settings-search', 'replay onboarding')
    await until(`document.querySelectorAll('#settings-search-results button').length === 1`)
    await click('#settings-search-results button')
    await until(`!!document.querySelector('#settings-onboarding-title.settings-search-target')`)
    assert.equal(await evaluate(`return document.activeElement.id`), 'settings-onboarding-title')
    await input('#settings-search', 'proxy password')
    await until(`document.querySelectorAll('#settings-search-results button').length === 1`)
    await click('#settings-search-results button')
    await until(`!!document.querySelector('#settings-proxy-title.settings-search-target')`)
    await screenshot('destination-highlight')
    await input('#settings-search', 'does-not-exist-4937')
    await until(`document.querySelector('[role="status"]')?.textContent.includes('0 settings')`)
    assert.match(
      await evaluate(
        `return document.querySelector('#settings-search-heading').closest('section').textContent`
      ),
      /No settings found/
    )
    await evaluate(`document.querySelector('#settings-search').focus()`)
    await key('Escape')
    await until(`document.querySelector('#settings-search').value === ''`)
    assert(await evaluate(`return !!document.querySelector('#appearance-page')`))
    await until(`document.querySelector('#settings-browser').getBoundingClientRect().height > 0`)
    await input('#settings-search', 'opacity')
    await until(`document.querySelectorAll('#settings-search-results button').length === 1`)
    const dark = await evaluate(
      `return getComputedStyle(document.querySelector('mark')).textDecorationColor`
    )
    await evaluate(`document.documentElement.style.setProperty('--color-accent', '#00cc99')`)
    const custom = await evaluate(
      `return getComputedStyle(document.querySelector('mark')).textDecorationColor`
    )
    assert.notEqual(dark, custom, 'underline follows the theme accent')
    const base = fsUrl('src/renderer/src')
    const shared = fsUrl('src/shared/theme.ts')
    await evaluate(`const { applyTheme } = await import(${JSON.stringify(base + '/lib/theme.ts')});
      const { BUILT_IN_THEMES, resolveTheme } = await import(${JSON.stringify(shared)});
      applyTheme(resolveTheme(BUILT_IN_THEMES.find(theme => theme.id === 'roxy-light')));`)
    for (const width of [360, 640, 1440]) {
      win.setContentSize(width, 900)
      await wait()
      assert(
        await evaluate(`return document.documentElement.scrollWidth <= innerWidth`),
        `no page overflow at ${width}px`
      )
      assert(
        await evaluate(
          `const el = document.querySelector('#settings-search'); const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth`
        ),
        `search accessible at ${width}px`
      )
      if (width === 360) await screenshot('mobile-light')
    }
    await evaluate(`await (await import(${JSON.stringify(base + '/i18n.ts')})).applyLanguage('es')`)
    await input('#settings-search', 'idioma')
    await until(`document.querySelectorAll('#settings-search-results button').length >= 1`)
    await click('#settings-search-results button')
    await until(`!!document.querySelector('#settings-language-label.settings-search-target')`)
    await input('#settings-search', 'language')
    await until(`document.querySelectorAll('#settings-search-results button').length >= 1`)
    assert.match(
      await evaluate(`return document.querySelector('#settings-search-results').textContent`),
      /Language/
    )
    await evaluate(`document.documentElement.dataset.motion = 'reduced'`)
    await click('#settings-search-results button')
    assert.equal(
      await evaluate(
        `return getComputedStyle(document.querySelector('.settings-search-target')).animationName`
      ),
      'none'
    )
    await until(`!document.querySelector('.settings-search-target')`)
    await input('#settings-search', 'e')
    assert(
      (await evaluate(
        `return document.querySelectorAll('#settings-search-results button').length`
      )) <= 20
    )
    const registry = fsUrl('src/shared/i18n.ts')
    const languages = await evaluate(`return (await import(${JSON.stringify(registry)})).LANGUAGES`)
    await evaluate(`await (await import(${JSON.stringify(base + '/i18n.ts')})).applyLanguage('en')`)
    for (const { code } of languages) {
      const query = await evaluate(
        `return (await import(${JSON.stringify(base + '/i18n.ts')})).default.getFixedT(${JSON.stringify(code)})('settings.language.heading')`
      )
      await input('#settings-search', query)
      await until(
        `document.querySelector('#settings-search-results button')?.textContent.includes(${JSON.stringify(query)})`
      )
      assert(
        await evaluate(
          `return document.querySelector('#settings-search-results button mark')?.textContent.length > 0`
        ),
        `${code}: translated match is visible and highlighted in English UI`
      )
      await click('#settings-search-results button')
      await until(`!!document.querySelector('#settings-language-label.settings-search-target')`)
      assert.equal(await evaluate(`return document.documentElement.lang`), 'en')
    }
    for (const [index, language] of languages.entries()) {
      await evaluate(
        `await (await import(${JSON.stringify(base + '/i18n.ts')})).applyLanguage(${JSON.stringify(language.code)})`
      )
      const queryLanguage = languages[(index + 1) % languages.length].code
      const query = await evaluate(
        `return (await import(${JSON.stringify(base + '/i18n.ts')})).default.getFixedT(${JSON.stringify(queryLanguage)})('settings.language.heading')`
      )
      await input('#settings-search', query)
      await until(
        `document.querySelector('#settings-search-results button')?.textContent.includes(${JSON.stringify(query)})`
      )
      await click('#settings-search-results button')
      await until(`!!document.querySelector('#settings-language-label.settings-search-target')`)
      assert.equal(await evaluate(`return document.documentElement.lang`), language.code)
      assert.equal(
        await evaluate(`return document.documentElement.dir`),
        language.rtl ? 'rtl' : 'ltr'
      )
      assert.equal(await evaluate(`return document.querySelector('#settings-search').value`), query)
      for (const width of [360, 1440]) {
        win.setContentSize(width, 900)
        await wait()
        assert(
          await evaluate(`return document.documentElement.scrollWidth <= innerWidth`),
          `${language.code}: no page overflow at ${width}px`
        )
      }
    }
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log(
      'Settings search UI: sidebar, keyboard/Enter, drafts, empty/Escape, themes, mobile, all Settings languages/RTL and temporary/reduced-motion highlight passed'
    )
  } catch (error) {
    console.error(error)
    console.error(errors.join('\n'))
    if (win && !win.isDestroyed()) console.error(await evaluate(`return document.body.innerText`))
    failed = true
  } finally {
    win?.destroy()
    await server?.close()
    fs.rmSync(temp, { recursive: true, force: true })
    app.exit(failed ? 1 : 0)
  }
})
