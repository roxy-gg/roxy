const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const path = require('node:path')
const temp = mkdtempSync(path.join(require('node:os').tmpdir(), 'roxy-mentions-ui-'))
app.setPath('userData', temp)
let server
let win
const wait = () => new Promise((resolve) => setTimeout(resolve, 150))
const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
const waitFor = async (selector, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(`return !!document.querySelector(${JSON.stringify(selector)})`)) return
    await wait()
  }
  throw new Error(`Timed out waiting for selector: ${selector}`)
}
const click = async (selector) => {
  await evaluate(`
    const target = document.querySelector(${JSON.stringify(selector)})
    if (!target) throw new Error('Missing selector: ' + ${JSON.stringify(selector)})
    target.click()
  `)
  await wait()
}
const type = async (text) => {
  await evaluate(`const el = document.querySelector('textarea'); el.focus(); el.select()`)
  await win.webContents.debugger.sendCommand('Input.insertText', { text })
  await wait()
}
const highlights = () =>
  evaluate(
    `return [...document.querySelectorAll('[aria-hidden] span.text-accent')].map(el => el.textContent)`
  )
const send = () => click('button[title="Send"], button[title="Add to queue"]')
async function run() {
  let url = process.env.BOTS_TEST_URL
  if (!url) {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { port: 3114, strictPort: true }
    })
    await server.listen()
    url = 'http://localhost:3114/?bots'
  }
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.debugger.attach('1.3')
  await win.loadURL(url)
  await waitFor('button[title="New bot"]')
  await click('button[title="New bot"]')
  await evaluate(`await window.__renameBot('bot', 'reviewer')`)
  await wait()
  const bot = await evaluate(`return (await window.roxy.bots.list())[0]`)
  win.setSize(390, 840)
  await wait()
  assert.deepEqual(
    await evaluate(`
      const textarea = document.querySelector('textarea')
      const mirror = textarea.previousElementSibling
      return {
        oneLine: textarea.getBoundingClientRect().height < 40,
        nativePlaceholder: textarea.placeholder,
        visiblePlaceholder: mirror.textContent.trim().length > 40
      }
    `),
    { oneLine: true, nativePlaceholder: '', visiblePlaceholder: true },
    'localized placeholder stays visible without changing the empty composer height'
  )
  win.setSize(1280, 840)
  await wait()
  for (let i = 0; i < 24; i++) await click('#answer')
  await evaluate(`
    const textarea = document.querySelector('textarea')
    const canvas = document.querySelector('[data-canvas-surface]')
    if (canvas.scrollHeight <= canvas.clientHeight) throw new Error('Transcript fixture must scroll')
    canvas.scrollTop = canvas.scrollHeight
    window.__composerSizing = {
      initialHeight: textarea.getBoundingClientRect().height,
      initialScrollTop: canvas.scrollTop,
      styleMutations: 0,
      canvasResizes: 0
    }
    new MutationObserver(records => {
      window.__composerSizing.styleMutations += records.length
    }).observe(textarea, { attributes: true, attributeFilter: ['style'] })
    new ResizeObserver(() => {
      window.__composerSizing.canvasResizes++
    }).observe(canvas)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    window.__composerSizing.canvasResizes = 0
  `)
  await type('Typing on one line must not resize the transcript.')
  assert.deepEqual(
    await evaluate(`
      const textarea = document.querySelector('textarea')
      const canvas = document.querySelector('[data-canvas-surface]')
      return {
        fieldSizing: getComputedStyle(textarea).fieldSizing,
        sameHeight: textarea.getBoundingClientRect().height === window.__composerSizing.initialHeight,
        styleMutations: window.__composerSizing.styleMutations,
        canvasResizes: window.__composerSizing.canvasResizes,
        sameScrollTop: canvas.scrollTop === window.__composerSizing.initialScrollTop,
        atBottom: Math.abs(canvas.scrollHeight - canvas.clientHeight - canvas.scrollTop) < 2
      }
    `),
    {
      fieldSizing: 'content',
      sameHeight: true,
      styleMutations: 0,
      canvasResizes: 0,
      sameScrollTop: true,
      atBottom: true
    },
    'ordinary typing does not collapse or resize the canvas viewport'
  )
  await type(Array.from({ length: 300 }, (_, index) => `word${index}`).join(' '))
  await evaluate(
    `await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
  )
  assert.deepEqual(
    await evaluate(`
      const textarea = document.querySelector('textarea')
      const canvas = document.querySelector('[data-canvas-surface]')
      return {
        capped: textarea.getBoundingClientRect().height === 168,
        scrollable: textarea.scrollHeight > textarea.clientHeight,
        followedCaret:
          Math.abs(textarea.scrollHeight - textarea.clientHeight - textarea.scrollTop) < 2 &&
          Math.abs(
            textarea.previousElementSibling.scrollHeight -
              textarea.previousElementSibling.clientHeight -
              textarea.previousElementSibling.scrollTop
          ) < 2,
        atBottom: Math.abs(canvas.scrollHeight - canvas.clientHeight - canvas.scrollTop) < 2
      }
    `),
    { capped: true, scrollable: true, followedCaret: true, atBottom: true },
    'multiline drafts cap, follow the caret, and keep the transcript pinned'
  )
  await type('Hola @roxy!')
  await send()
  const privateItem = await evaluate(
    `return (await window.roxy.queue.list(${JSON.stringify(bot.chatId)})).at(-1)`
  )
  assert.equal(privateItem.content, 'Hola @roxy!')
  assert.equal(privateItem.asBotId, undefined)
  await click('button[title="Project session"]')
  await click('#busy')
  await type('@')
  assert.deepEqual(
    await evaluate(`
      return [...document.querySelectorAll('[role=option]')].map(option => ({
        username: option.textContent.trim(),
        canonicalAppIcon: option.querySelector('img')
          ? decodeURIComponent(new URL(option.querySelector('img').src).pathname).endsWith(
              '/src/renderer/src/assets/roxy.png'
            )
          : false,
        facehash: !!option.querySelector('[data-facehash]')
      }))
    `),
    [
      {
        username: '@roxy',
        canonicalAppIcon: true,
        facehash: false
      },
      { username: '@reviewer', canonicalAppIcon: false, facehash: true }
    ],
    'Roxy uses the canonical app icon while collaborators keep BotAvatar'
  )
  for (const draft of [
    'Hola @reviewer',
    '@reviewer hola',
    'Hola @reviewer y @roxy',
    'Implementa @modelcontextprotocol/sdk y luego llama a @reviewer',
    'Quiero hablar sobre @reviewer',
    'Hola @does-not-exist'
  ]) {
    await type(draft)
    assert.deepEqual(
      await highlights(),
      draft.includes('@reviewer')
        ? draft.includes('@roxy')
          ? ['@reviewer', '@roxy']
          : ['@reviewer']
        : []
    )
    await send()
    const item = await evaluate(`return (await window.roxy.queue.list('project-chat')).at(-1)`)
    assert.equal(item.content, draft)
    assert.equal(item.asBotId, undefined, 'no guest selected by the UI')
    assert.equal(item.recipientId, undefined, 'no obsolete recipient option')
    assert.ok(await evaluate(`return !document.querySelector('[role=alert]')`))
  }
  await type('@reviewer/sdk user@reviewer.com @reviewer-other @unknown')
  assert.deepEqual(await highlights(), [])
  await type('Hola @reviewer!')
  await evaluate(`await window.__renameBot('reviewer', 'renamed')`)
  await wait()
  assert.deepEqual(await highlights(), [], 'removed handles stop highlighting')
  await type('Hola @RENAMED!')
  assert.deepEqual(await highlights(), ['@RENAMED'])
  assert.ok(
    await evaluate(`
      const textarea = document.querySelector('textarea')
      const highlight = document.querySelector('[aria-hidden] span.text-accent')
      return getComputedStyle(textarea).fontWeight === getComputedStyle(highlight).fontWeight
    `),
    'mention color does not change glyph metrics relative to the native textarea caret'
  )
  await type('prefix @RENAMED suffix')
  assert.ok(
    await evaluate(`
      const textarea = document.querySelector('textarea')
      const mirror = textarea.previousElementSibling
      return textarea.scrollHeight === mirror.scrollHeight
    `),
    'the visible mirror wraps the same measured text as the native textarea'
  )
  await click('button[title="@renamed"]')
  await type('prefix @RENAMED suffix')
  await evaluate(`
    const textarea = document.querySelector('textarea')
    textarea.focus()
    textarea.setSelectionRange(7, 15, 'backward')
    window.__selectionTarget = textarea
  `)
  await evaluate(`window.__rerenderBotComposer()`)
  await wait()
  assert.deepEqual(
    await evaluate(`
      const textarea = document.querySelector('textarea')
      return {
        sameNode: textarea === window.__selectionTarget,
        active: document.activeElement === textarea,
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        direction: textarea.selectionDirection,
        value: textarea.value
      }
    `),
    {
      sameNode: true,
      active: true,
      start: 7,
      end: 15,
      direction: 'backward',
      value: 'prefix @RENAMED suffix'
    },
    'bot activity rerenders preserve the editable node and middle selection'
  )
  await win.webContents.debugger.sendCommand('Input.insertText', { text: 'bot' })
  await wait()
  assert.deepEqual(
    await evaluate(`
      const textarea = document.querySelector('textarea')
      return { start: textarea.selectionStart, end: textarea.selectionEnd, value: textarea.value }
    `),
    { start: 10, end: 10, value: 'prefix bot suffix' },
    'typing after a bot rerender replaces the selected middle text at the native caret'
  )
  await type('compose here')
  await evaluate(`
    const textarea = document.querySelector('textarea')
    textarea.focus()
    textarea.setSelectionRange(8, 8)
    window.__selectionTarget = textarea
  `)
  await win.webContents.debugger.sendCommand('Input.imeSetComposition', {
    text: '\u3042',
    selectionStart: 1,
    selectionEnd: 1
  })
  await evaluate(`window.__rerenderBotComposer()`)
  await wait()
  assert.deepEqual(
    await evaluate(`
      const textarea = document.querySelector('textarea')
      return {
        sameNode: textarea === window.__selectionTarget,
        active: document.activeElement === textarea,
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        value: textarea.value
      }
    `),
    {
      sameNode: true,
      active: true,
      start: 9,
      end: 9,
      value: 'compose \u3042here'
    },
    'bot activity rerenders preserve an in-progress IME composition and its caret'
  )
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '\u3042' })
  await wait()
  assert.equal(
    await evaluate(`return document.querySelector('textarea').value`),
    'compose \u3042here',
    'the IME composition commits after the rerender'
  )
  await click('button[title="Project session"]')
  await type('Hola @ro')
  await click('[role=option]')
  assert.equal(await evaluate(`return document.querySelector('textarea').value`), 'Hola @roxy ')
  win.setSize(390, 840)
  await wait()
  if (await evaluate(`return !!document.querySelector('button[title="Collapse sidebar"]')`))
    await click('button[title="Collapse sidebar"]')
  assert.ok(
    await evaluate(
      `const r = document.querySelector('textarea').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight`
    )
  )
  assert.equal(await evaluate(`return document.querySelectorAll('select').length`), 0)
  console.log(
    'MENTIONS UI OK: known highlights only, no automatic routing, unrestricted sends, renames, autocomplete and mobile'
  )
}
const watchdog = setTimeout(() => {
  console.error('MENTIONS UI TIMEOUT')
  app.exit(1)
}, 120000)

app
  .whenReady()
  .then(run)
  .then(async () => {
    clearTimeout(watchdog)
    win.destroy()
    await server?.close()
    app.quit()
  })
  .catch(async (error) => {
    clearTimeout(watchdog)
    console.error(error)
    await server?.close()
    app.exit(1)
  })
app.on('will-quit', () => {
  try {
    rmSync(temp, { recursive: true, force: true })
  } catch {}
})
