const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
let window
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => window.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
const until = async (code) => {
  for (let n = 0; n < 100; n++) {
    if (await evaluate(`return ${code}`)) return
    await wait()
  }
  throw Error('Timed out: ' + code)
}
const click = async (selector) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait()
}
const note = async (value) => {
  await evaluate(
    `const el=document.querySelector('#narrete-note');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))`
  )
  await wait()
}
const drag = async () => {
  await evaluate(`window.__narreteTest.drag(120,160,460,340,true)`)
  await until(`!!document.querySelector('#narrete-note')`)
}
const start = async () => {
  await click('[aria-label="Start Narrete capture"]')
  await until(`!!document.querySelector('[data-narrete-overlay]')`)
  assert.equal(
    await evaluate(
      `const button=document.querySelector('[aria-label="Start Narrete capture"]');return button.getAttribute('aria-pressed') === 'true' && button.classList.contains('bg-accent/15') && button.classList.contains('text-accent') && !!button.querySelector('.lucide-mouse-pointer-2') && !button.querySelector('.animate-spin') && !button.hasAttribute('aria-busy')`
    ),
    true,
    'Active capture highlights the cursor icon instead of showing a loading spinner'
  )
}
const assertInactive = async () => {
  assert.equal(
    await evaluate(
      `const button=document.querySelector('[aria-label="Start Narrete capture"]');return button.getAttribute('aria-pressed') === 'false' && !button.disabled && !button.classList.contains('bg-accent/15') && !!button.querySelector('.lucide-mouse-pointer-2')`
    ),
    true,
    'Cursor returns to its unselected state when capture ends'
  )
}
app
  .whenReady()
  .then(async () => {
    window = new BrowserWindow({
      width: 1100,
      height: 850,
      show: true,
      webPreferences: { contextIsolation: true, backgroundThrottling: false }
    })
    await window.loadURL('http://localhost:3101/?narrete')
    await until(`!!document.querySelector('[role="switch"]')`)
    await click('[role="switch"]')
    await assertInactive()
    await start()
    assert.equal(
      await evaluate(`return document.querySelector('[data-narrete-overlay] img')`),
      null,
      'Live mode has no screenshot'
    )
    assert.equal(await evaluate(`return window.__narreteTest.snapshots`), 0)
    await evaluate(
      `window.__narreteTest.drag(120,160,130,170,true);window.__narreteTest.drag(120,160,460,175,true);window.__narreteTest.drag(120,160,460,340)`
    )
    assert.equal(await evaluate(`return window.__narreteTest.snapshots`), 0)
    await drag()
    await until(`document.querySelector('[data-narrete-preview]')?.naturalWidth > 0`)
    const preview = await evaluate(`return document.querySelector('[data-narrete-preview]').src`)
    assert.equal(
      await evaluate(
        `const image=document.querySelector('[data-narrete-preview]');const r=image.getBoundingClientRect();return image.closest('[role="dialog"]') !== null && r.height > 100 && r.bottom <= document.querySelector('#narrete-note').getBoundingClientRect().top && image.draggable === false && getComputedStyle(image).objectFit === 'contain'`
      ),
      true,
      'The selected crop is visible above the note, fully contained and not draggable'
    )
    assert.equal(
      await evaluate(
        `const overlay=document.querySelector('[data-narrete-overlay]');return overlay.children.length === 1 && overlay.firstElementChild.getAttribute('role') === 'dialog'`
      ),
      true,
      'After capture only the prompt widget is rendered, no desktop image, dimming, border or extra bars'
    )
    await note('First feedback')
    assert.equal(
      await evaluate(`return !!document.querySelector('[role="dialog"] [aria-label="Send"]')`),
      false
    )
    await click('[aria-label="Add & next"]')
    await until(`!document.querySelector('#narrete-note')`)
    assert.equal(
      await evaluate(`return document.querySelector('[data-narrete-sequence] img').src`),
      preview,
      'Saved image is the exact crop previewed'
    )
    assert.equal(await evaluate(`return !!document.querySelector('[data-narrete-preview]')`), false)
    assert.equal(
      await evaluate(`return window.__narreteTest.snapshots`),
      1,
      'Next does not take a new screenshot'
    )
    assert.equal(
      await evaluate(
        `return document.querySelector('[data-narrete-saved-bar] [role="status"]').textContent`
      ),
      '1 saved'
    )
    await evaluate(`window.__narreteTest.editDraft('Edited while collecting')`)
    await drag()
    await until(`!!document.querySelector('[aria-label="Start voice transcription"]')`)
    await click('[role="dialog"] [aria-label="Start voice transcription"]')
    await evaluate(`window.__narreteTest.partial()`)
    await until(`document.querySelector('#narrete-note').value === 'Make this button'`)
    await click('[aria-label="Add & next"]')
    await until(`!document.querySelector('#narrete-note')`)
    assert.equal(
      await evaluate(
        `return document.querySelector('[data-narrete-saved-bar] [role="status"]').textContent`
      ),
      '2 saved'
    )
    await evaluate(`window.__narreteTest.failure=true`)
    await click('[aria-label="Add to prompt"]')
    await until(`!!document.querySelector('[data-narrete-overlay] [role="alert"]')`)
    assert.equal(await evaluate(`return window.__narreteTest.sends.length`), 0)
    await evaluate(`window.__narreteTest.failure=false`)
    await click('[aria-label="Add to prompt"]')
    await until(`!document.querySelector('[data-narrete-overlay]')`)
    await assertInactive()
    assert.equal(
      await evaluate(`return window.__narreteTest.draft().value`),
      'Edited while collecting\n\n1. First feedback\n\n2. Make this button red.'
    )
    assert.equal(await evaluate(`return window.__narreteTest.draft().images.length`), 2)
    assert.equal(
      await evaluate(`return window.__narreteTest.sends.length`),
      0,
      'Capture completion never submits'
    )
    await evaluate(`window.__narreteTest.late()`)
    assert.equal(await evaluate(`return window.__narreteTest.draft().images.length`), 2)
    assert.equal(
      await evaluate(`return window.__narreteTest.draft().value.includes('STALE')`),
      false
    )
    await start()
    await drag()
    await note('Discarded')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await until(`!document.querySelector('[data-narrete-overlay]')`)
    await assertInactive()
    assert.equal(await evaluate(`return window.__narreteTest.draft().images.length`), 2)
    await click('[aria-label="Send"]')
    assert.equal(
      await evaluate(`return window.__narreteTest.sends.length`),
      1,
      'Only explicit Composer Send submits'
    )
    assert.equal(await evaluate(`return window.__narreteTest.sends[0].images.length`), 2)
    window.setSize(400, 700)
    await start()
    for (let i = 0; i < 12; i++) {
      await drag()
      const dialog = await evaluate(
        `const r=document.querySelector('[role="dialog"]').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}`
      )
      assert(dialog.left >= 0 && dialog.right <= dialog.width)
      assert(dialog.top >= 0 && dialog.bottom <= dialog.height)
      await note(`Item ${i + 1}`)
      await click('[aria-label="Add & next"]')
      await until(`!document.querySelector('#narrete-note')`)
    }
    assert.equal(
      await evaluate(
        `return document.querySelector('[data-narrete-saved-bar] [role="status"]').textContent`
      ),
      '12 saved'
    )
    const bounds = await evaluate(
      `const r=document.querySelector('[data-narrete-saved-bar]').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}`
    )
    assert(bounds.left >= 0 && bounds.right <= bounds.width)
    await click('[aria-label="Add to prompt"]')
    await until(`!document.querySelector('[data-narrete-overlay]')`)
    assert.equal(await evaluate(`return window.__narreteTest.draft().images.length`), 1)
    assert.equal(await evaluate(`return window.__narreteTest.sends.length`), 1)
    const before = await evaluate(`return window.__narreteTest.draft().value`)
    await start()
    await evaluate(`window.__narreteTest.switchChat()`)
    await wait()
    await evaluate(`window.__narreteTest.lateResult()`)
    await wait()
    assert.equal(
      await evaluate(`return window.__narreteTest.draft().value`),
      before,
      'Late completion after chat switch cannot change the old or new draft'
    )
    console.log(
      'NARRETE UI OK: visible current crop above note, exact saved preview, widget-only capture, live armed state, threshold, Add & next, voice, draft append, attachment preservation, explicit Send and 12 saved'
    )
    window.destroy()
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    window?.destroy()
    app.exit(1)
  })
