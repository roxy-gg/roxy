const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync } = require('node:fs')
const { rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const baseURL = `${process.env.CANVAS_URL ?? 'http://localhost:3102'}/providers.html`
const userData = mkdtempSync(join(tmpdir(), 'roxy-onboarding-ui-'))
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
    const button = (text) =>
      `Array.from(document.querySelectorAll('button')).find(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(text)})`
    const click = async (text) => {
      await waitFor(`!!(${button(text)})`)
      await js(`(${button(text)}).click()`)
    }
    try {
      for (const width of [1100, 390]) {
        win.setSize(width, 850)
        await win.loadURL(`${baseURL}#/settings/about`)
        await waitFor(`!!(${button('Replay onboarding')})`)
        const before = await js('window.onboardingState()')
        assert.equal(
          await js(`(() => {
        const headings = Array.from(document.querySelectorAll('h2'))
          .filter(h => h.getClientRects().length).map(h => h.textContent)
        return headings.indexOf('About') < headings.indexOf('Onboarding') &&
          headings.indexOf('Onboarding') < headings.indexOf('Danger zone')
      })()`),
          true,
          'Replay sits below About and above Danger zone'
        )
        assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true)

        await click('Replay onboarding')
        await waitFor(`document.querySelector('h1')?.textContent === 'Aloha'`)
        assert.deepEqual(await js('window.onboardingState()'), before)
        assert.equal(
          await js(`(() => {
        const rect = (${button('Back to Settings')}).getBoundingClientRect()
        return rect.left >= 0 && rect.right <= innerWidth - 144 &&
          getComputedStyle(${button('Back to Settings')}).webkitAppRegion === 'no-drag'
      })()`),
          true,
          'Exit stays clickable and clear of native window controls'
        )
        await click('Back to Settings')
        await waitFor(`location.hash === '#/settings/about'`)

        await click('Replay onboarding')
        await waitFor(`document.querySelector('h1')?.textContent === 'Aloha'`)
        await click('Continue')
        await waitFor(`document.querySelector('h1')?.textContent === 'Connect a provider'`)
        assert.equal(await js(`(${button('Continue')}).disabled`), false)
        assert.equal(
          await js(`(() => {
        const rect = (${button('Back to Settings')}).getBoundingClientRect()
        return rect.left >= 0 && rect.right <= innerWidth - 144
      })()`),
          true,
          'Provider-step exit fits a narrow window'
        )
        await click('Back to Settings')
        await waitFor(`location.hash === '#/settings/about'`)

        await click('Replay onboarding')
        await waitFor(`document.querySelector('h1')?.textContent === 'Aloha'`)
        await click('Continue')
        await waitFor(`document.querySelector('h1')?.textContent === 'Connect a provider'`)
        await click('Continue')
        await waitFor(`location.hash === '#/settings/about'`)
        assert.deepEqual(
          await js('window.onboardingState()'),
          before,
          'Replay preserves providers, settings and drafts without reset or bootstrap'
        )
      }

      await win.loadURL(`${baseURL}?first-run#/onboarding`)
      await waitFor(`document.querySelector('h1')?.textContent === 'Aloha'`)
      assert.equal(
        await js(`!!(${button('Back to Settings')})`),
        false,
        'First-run onboarding has no replay exit'
      )
      await click('Continue')
      await waitFor(`document.querySelector('h1')?.textContent === 'Connect a provider'`)
      await click('Continue')
      await waitFor(`location.hash === '#/'`)
      const firstRun = await js('window.onboardingState()')
      assert.equal(firstRun.settings.onboardingCompleted, true)
      assert.deepEqual(firstRun.calls, { complete: 1, reset: 0, bootstrap: 1 })
      console.log(
        'ONBOARDING UI OK: replay placement, welcome restart, both exits, completion, preserved data, narrow window, first-run completion'
      )
    } finally {
      win.destroy()
      await rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    }
  )
