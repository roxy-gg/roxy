const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const baseURL = `http://localhost:3101/@fs/${join(process.cwd(), 'test/canvas/providers.html')}`
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
      throw new Error(
        `Timed out: ${code}; dialogs=${await js(`document.querySelectorAll('dialog[open]').length`)}; focus=${await js(`document.activeElement?.outerHTML.slice(0,300)`)}`
      )
    }
    const click = async (text) => {
      const selector = `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`
      await waitFor(`!!(${selector})`)
      await js(`(${selector}).click()`)
    }
    const input = async (selector, value) => {
      await js(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
    }
    const actions = async (name) => {
      await js(
        `document.querySelector(${JSON.stringify(`[aria-label="Actions for ${name}"]`)}).scrollIntoView({ block: 'center' })`
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      await js(
        `document.querySelector(${JSON.stringify(`[aria-label="Actions for ${name}"]`)}).click()`
      )
      await waitFor(`!!document.querySelector('[role="menu"]')`)
    }
    try {
      await win.loadURL(baseURL)
      await waitFor(`document.body.textContent.includes('GitHub Copilot 2')`)
      await js(`document.querySelector('[aria-label="Actions for GitHub Copilot 1"]').click()`)
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
      await js(`document.querySelector('[aria-label="Actions for Work Copilot"]').click()`)
      await click('Add another account')
      await waitFor(
        `document.querySelector('dialog[open]')?.textContent.includes('Continue with GitHub')`
      )
      assert.equal(await js(`!!document.querySelector('input[aria-label="Account name"]')`), false)

      await win.loadURL(baseURL)
      await waitFor(`document.querySelectorAll('[data-provider-account]').length === 2`)
      assert.equal(await js(`document.querySelectorAll('button[aria-haspopup="menu"]').length`), 2)
      assert.equal(
        await js(
          `Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Disconnect')`
        ),
        false,
        'Maintenance actions stay out of the resting layout'
      )
      await actions('GitHub Copilot 1')
      await waitFor(`document.activeElement.textContent.trim() === 'Rename'`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
      await waitFor(`document.activeElement.textContent.trim() === 'Reconnect'`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await waitFor(`!document.querySelector('[role="menu"]')`)
      assert.equal(
        await js(`document.activeElement.getAttribute('aria-label')`),
        'Actions for GitHub Copilot 1'
      )

      await js(
        `document.querySelector('[aria-label="Manage models for GitHub Copilot 1"]').click()`
      )
      await waitFor(`!!document.querySelector('[role="checkbox"]')`)
      assert.ok(
        await js(`document.querySelectorAll('[role="checkbox"]').length < 30`),
        '600-model catalog stays windowed'
      )
      await js(`document.querySelector('[aria-label="Test Model"]').focus()`)
      await click('Test Model')
      await waitFor(
        `document.querySelector('[role="checkbox"]').getAttribute('aria-checked') === 'false'`
      )
      assert.deepEqual(await js(`window.accountState().hidden`), ['copilot-1:test-model'])
      assert.equal(await js(`document.activeElement.getAttribute('aria-label')`), 'Test Model')
      await input('input[aria-label="Search GitHub Copilot 1 models"]', 'Model 599')
      await click('Hide 1')
      await waitFor(`window.accountState().hidden.length === 2`)
      await click('Show 1')
      await waitFor(`window.accountState().hidden.length === 1`)
      await js(`window.failVisibility(true)`)
      await click('Hide 1')
      await waitFor(`document.body.textContent.includes("Couldn't save model visibility")`)
      assert.deepEqual(
        await js(`window.accountState().hidden`),
        ['copilot-1:test-model'],
        'Failed writes roll back only the edited account'
      )
      await js(`window.failVisibility(false)`)
      await input('input[aria-label="Search GitHub Copilot 1 models"]', '')
      await js(
        `document.querySelector('[aria-label="Manage models for GitHub Copilot 2"]').click()`
      )
      await waitFor(
        `!!document.querySelector('[data-provider-account="copilot-2"] [role="checkbox"]')`
      )
      assert.equal(
        await js(
          `document.querySelector('[data-provider-account="copilot-2"] [role="checkbox"]').getAttribute('aria-checked')`
        ),
        'true'
      )
      await js(
        `document.querySelector('[data-provider-account="copilot-1"] .overflow-y-auto').scrollTop = 15000`
      )
      await waitFor(
        `!document.querySelector('[data-provider-account="copilot-1"] [aria-label="Test Model"]')`
      )
      await js(
        `document.querySelector('[aria-label="Manage models for GitHub Copilot 1"]').click()`
      )
      await js(
        `document.querySelector('[aria-label="Manage models for GitHub Copilot 1"]').click()`
      )
      await waitFor(
        `!!document.querySelector('[data-provider-account="copilot-1"] [aria-label="Test Model"]')`
      )

      await actions('GitHub Copilot 1')
      await click('Move down')
      await waitFor(
        `document.querySelector('[data-provider-account]').dataset.providerAccount === 'copilot-2'`
      )
      await actions('GitHub Copilot 1')
      await click('Reconnect')
      await waitFor(
        `document.querySelector('dialog[open]')?.textContent.includes('GitHub Copilot 1')`
      )
      assert.equal(
        await js(`document.querySelector('dialog[open]').getAttribute('aria-label')`),
        'Reconnect'
      )
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await waitFor(`!document.querySelector('dialog[open]')`)

      await actions('GitHub Copilot 1')
      await click('Disconnect')
      await waitFor(`document.body.textContent.includes('Disconnect GitHub Copilot 1?')`)
      assert.equal(
        await js(`window.accountState().providers.length`),
        2,
        'Disconnect requires confirmation'
      )
      await click('Cancel')
      assert.equal(await js(`window.accountState().providers.length`), 2)
      await actions('GitHub Copilot 1')
      await click('Disconnect')
      await click('Disconnect')
      await waitFor(`document.querySelectorAll('[data-provider-account]').length === 1`)
      assert.equal(await js(`window.accountState().providers[0].id`), 'copilot-2')

      await click('Add account')
      await waitFor(`!!document.querySelector('input[aria-label="Search providers"]')`)
      await input('input[aria-label="Search providers"]', 'copilot')
      await js(
        `Array.from(document.querySelectorAll('dialog[open] button')).find(b => b.textContent.includes('GitHub Copilot')).click()`
      )
      await waitFor(
        `document.querySelector('dialog[open]')?.textContent.includes('Continue with GitHub')`
      )
      assert.equal(await js(`!!document.querySelector('input[aria-label="Account name"]')`), false)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await waitFor(`!!document.querySelector('dialog[open] input[aria-label="Search providers"]')`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await waitFor(`!document.querySelector('dialog[open]')`)

      await click('Add account')
      await waitFor(`!!document.querySelector('input[aria-label="Search providers"]')`)
      await input('input[aria-label="Search providers"]', 'roxy')
      await js(
        `Array.from(document.querySelectorAll('dialog[open] button')).find(b => b.textContent.includes('Roxy.gg Inference')).click()`
      )
      await waitFor(`!!document.querySelector('input[type="password"]')`)
      const countBeforeKey = await js(`window.accountState().providers.length`)
      await input('input[type="password"]', 'rejected')
      await click('Connect')
      await waitFor(
        `document.querySelector('dialog[open]').textContent.includes('Verifying key...')`
      )
      assert.equal(await js(`document.querySelector('input[type="password"]').disabled`), true)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await waitFor(
        `document.querySelector('[role="alert"]')?.textContent.includes('This API key was rejected')`
      )
      assert.equal(await js(`window.accountState().providers.length`), countBeforeKey)
      assert.equal(await js(`document.querySelector('input[type="password"]').value`), 'rejected')
      assert.equal(
        await js(`document.body.textContent.includes('Connect without verification')`),
        false
      )
      await input('input[type="password"]', 'unsupported')
      await waitFor(`!document.querySelector('[role="alert"]')`)
      await click('Connect')
      await waitFor(`document.body.textContent.includes('Connect without verification')`)
      assert.equal(await js(`window.accountState().providers.length`), countBeforeKey)
      await click('Connect without verification')
      await waitFor(`!document.querySelector('dialog[open]')`)
      await waitFor(`window.accountState().providers.length === ${countBeforeKey + 1}`)
      assert.equal(await js(`window.accountState().providers.length`), countBeforeKey + 1)

      await win.loadURL(`${baseURL}?catalog-failure`)
      await waitFor(`document.body.textContent.includes('Needs reconnection')`)
      assert.equal(
        await js(
          `document.querySelector('[role="status"]').textContent.includes('Update its API key')`
        ),
        true
      )
      assert.equal(
        await js(
          `!!document.querySelector('[role="group"][aria-labelledby^="account-warning-"] button')`
        ),
        true
      )
      await win.setSize(390, 844)
      assert.equal(
        await js(`document.documentElement.scrollWidth <= window.innerWidth`),
        true,
        'Recovery warning fits narrow Settings'
      )
      assert.equal(
        await js(`(() => {
        const group = document.querySelector('[role="group"][aria-labelledby^="account-warning-"]')
        return group.scrollWidth <= group.clientWidth
      })()`),
        true,
        'Recovery message and action stay within the warning'
      )
      await win.setSize(1100, 850)
      await click('Update API key')
      await waitFor(
        `document.querySelector('dialog[open]')?.textContent.includes('Roxy.gg Inference 1')`
      )
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await waitFor(`!document.querySelector('dialog[open]')`)
      await js(`document.querySelector('[aria-label="Manage models for ChatGPT 1"]').click()`)
      await js(`window.recoverCatalog()`)
      await click('Retry')
      await waitFor(`document.body.textContent.includes('Loading models')`)
      await waitFor(`!!document.querySelector('[role="checkbox"]')`)

      await win.loadURL(`${baseURL}?picker`)
      await waitFor(`!!document.querySelector('button')`)
      await js(`document.querySelector('button').click()`)
      await waitFor(`document.body.textContent.includes('GitHub Copilot 2')`)
      assert.equal(await js(`document.body.textContent.includes('GitHub Copilot 1')`), true)
      await win.loadURL(`${baseURL}?picker&catalog-failure`)
      await waitFor(`!!document.querySelector('button')`)
      await js(`document.querySelector('button').click()`)
      await waitFor(`document.body.textContent.includes('rejected the saved credentials')`)
      assert.equal(await js(`document.body.textContent.includes('models.dev')`), false)
      await click('ChatGPT 1')
      await waitFor(`document.body.textContent.includes('No models are available from ChatGPT 1')`)
      assert.equal(
        await js(`document.body.textContent.includes('rejected the saved credentials')`),
        false
      )
      await js(`window.recoverCatalog()`)
      await click('Retry')
      await waitFor(`document.body.textContent.includes('Loading models')`)
      await waitFor(
        `!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Test Model')`
      )
      await click('Roxy.gg Inference 1')
      await waitFor(
        `!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Test Model')`
      )
      assert.equal(
        await js(`document.body.textContent.includes('rejected the saved credentials')`),
        false
      )
      await win.setSize(390, 844)
      await win.loadURL(baseURL)
      await win.loadURL(`${baseURL}?picker&many-accounts`)
      await waitFor(`!!document.querySelector('button')`)
      await js(`document.querySelector('button').click()`)
      await waitFor(`!!document.querySelector('[data-provider-carousel]')`)
      const rail = `document.querySelector('[data-provider-carousel]')`
      await waitFor(`!!document.querySelector('[aria-label="Show more accounts"]')`)
      assert.equal(
        await js(`document.querySelector('[aria-label="Show previous accounts"]').disabled`),
        true
      )
      await js(`document.querySelector('[aria-label="Show more accounts"]').click()`)
      await waitFor(`${rail}.scrollLeft > 0`)
      await waitFor(`!document.querySelector('[aria-label="Show previous accounts"]').disabled`)
      await js(`document.querySelector('[aria-label="Show previous accounts"]').click()`)
      await waitFor(`${rail}.scrollLeft === 0`)
      await js(`${rail}.querySelector('button').focus()`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
      await waitFor(
        `document.activeElement === ${rail}.querySelectorAll('button')[1] && document.activeElement.getAttribute('aria-pressed') === 'true'`
      )
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' })
      await waitFor(
        `document.activeElement === ${rail}.querySelector('button:last-child') && document.activeElement.getAttribute('aria-pressed') === 'true'`
      )
      await waitFor(`document.querySelector('[aria-label="Show more accounts"]').disabled`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Home' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Home' })
      await waitFor(
        `document.activeElement === ${rail}.querySelector('button') && document.activeElement.getAttribute('aria-pressed') === 'true'`
      )
      assert.equal(
        await js(`(() => {
        const tabs = [...${rail}.querySelectorAll('button')]
        return tabs.every(tab => {
          const label = tab.querySelector('span[aria-hidden]')
          return tab.offsetWidth === 76 && label.offsetHeight === 28 &&
            Array.from(label.textContent.trim()).length <= 24 &&
            tab.getAttribute('aria-label') === tab.title
        })
      })()`),
        true,
        'Uniform tabs, two-line labels, character cap, full accessible names'
      )
      assert.equal(
        await js(`(() => {
        const rail = ${rail}
        rail.scrollLeft = 0
        const event = new WheelEvent('wheel', { deltaY: 80, cancelable: true })
        rail.dispatchEvent(event)
        return event.defaultPrevented && rail.scrollLeft === 80
      })()`),
        true,
        'Mouse wheel moves immediately and cancels vertical scrolling'
      )
      assert.equal(
        await js(`(() => {
        const rail = ${rail}
        const before = rail.scrollLeft
        const event = new WheelEvent('wheel', { deltaX: 40, deltaY: 10, cancelable: true })
        rail.dispatchEvent(event)
        return !event.defaultPrevented && rail.scrollLeft === before
      })()`),
        true,
        'Diagonal trackpad input stays native without double scrolling'
      )
      assert.equal(
        await js(`(() => {
        const rail = ${rail}
        rail.scrollLeft = 0
        rail.dispatchEvent(new WheelEvent('wheel', { deltaY: 2, deltaMode: 1, cancelable: true }))
        return rail.scrollLeft === 32
      })()`),
        true,
        'Line-mode mouse wheels are normalized'
      )
      await js(`${rail}.querySelector('button:last-child').click()`)
      await waitFor(`(() => {
        const rail = ${rail}
        const tab = rail.querySelector('button:last-child')
        return tab.getAttribute('aria-pressed') === 'true' &&
          tab.getBoundingClientRect().right <= rail.getBoundingClientRect().right + 1
      })()`)
      assert.equal(
        await js(`document.documentElement.scrollWidth <= innerWidth`),
        true,
        'Carousel fits narrow windows'
      )
      await js(`document.documentElement.dir = 'rtl'; ${rail}.scrollLeft = 0`)
      assert.equal(
        await js(`(() => {
        const rail = ${rail}
        rail.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, cancelable: true }))
        return rail.scrollLeft === -80
      })()`),
        true,
        'Mouse wheel respects RTL direction'
      )
      await js(`document.documentElement.dir = 'ltr'`)
      await win.loadURL(baseURL)
      await waitFor(`document.body.textContent.includes('GitHub Copilot 2')`)
      assert.equal(
        await js(`document.documentElement.scrollWidth <= window.innerWidth`),
        true,
        'Settings must fit a narrow viewport'
      )
      await js(
        `document.querySelector('[aria-label="Manage models for GitHub Copilot 1"]').click()`
      )
      await waitFor(`!!document.querySelector('[role="checkbox"]')`)
      assert.equal(
        await js(`document.documentElement.scrollWidth <= window.innerWidth`),
        true,
        'Expanded models fit narrow Settings'
      )
      await actions('GitHub Copilot 1')
      await click('Rename')
      await waitFor(`!!document.querySelector('input[aria-label="Account name"]')`)
      assert.equal(
        await js(`document.documentElement.scrollWidth <= window.innerWidth`),
        true,
        'Rename fits narrow Settings'
      )
      console.log(
        'PROVIDER UI OK: account menus, keyboard focus, rename, add, reconnect, confirmed disconnect, reorder, scoped visibility, rollback, 600-model windowing, retry, picker isolation, narrow Settings'
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
