const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const userData = mkdtempSync(join(tmpdir(), 'roxy-accounts-ui-'))
app.setPath('userData', userData)

void app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({ show: false, width: 1100, height: 850 })
    const js = (code) => win.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await js(code)) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error(`Timed out: ${code}`)
    }
    const click = async (text) => {
      const selector = `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`
      await waitFor(`!!(${selector})`)
      await js(`(${selector}).click()`)
    }
    try {
      await win.loadURL('http://localhost:3101/providers.html')
      await waitFor(`document.body.textContent.includes('GitHub Copilot 2')`)
      await click('Rename')
      await waitFor(`!!document.querySelector('input[aria-label="Account name"]')`)
      await js(`(() => {
      const input = document.querySelector('input[aria-label="Account name"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Work Copilot')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
      await click('Save')
      await waitFor(
        `document.body.textContent.includes('Work Copilot') && !document.querySelector('input[aria-label="Account name"]')`
      )
      assert.equal(await js(`document.body.textContent.includes('GitHub Copilot 2')`), true)
      await click('Add account')
      await waitFor(
        `document.querySelector('dialog[open]')?.textContent.includes('Continue with GitHub')`
      )
      assert.equal(await js(`!!document.querySelector('input[aria-label="Account name"]')`), false)

      await win.loadURL('http://localhost:3101/providers.html?picker')
      await waitFor(`!!document.querySelector('button')`)
      await js(`document.querySelector('button').click()`)
      await waitFor(`document.body.textContent.includes('GitHub Copilot 2')`)
      assert.equal(await js(`document.body.textContent.includes('GitHub Copilot 1')`), true)
      await win.setSize(390, 844)
      await win.loadURL('http://localhost:3101/providers.html')
      await waitFor(`document.body.textContent.includes('GitHub Copilot 2')`)
      assert.equal(
        await js(`document.documentElement.scrollWidth <= window.innerWidth`),
        true,
        'Settings must fit a narrow viewport'
      )
      console.log(
        'PROVIDER UI OK: rename, add without label, distinct picker accounts, narrow Settings'
      )
    } finally {
      win.destroy()
      rmSync(userData, { recursive: true, force: true })
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    }
  )
