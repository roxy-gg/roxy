const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const port = Number(process.env.ROXY_TEST_PORT || 3102)
let win, server
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) =>
  win.webContents.executeJavaScript(`(async()=>{${code}})()`, true).catch((error) => {
    throw Error(`${error.message}\nEvaluating: ${code}`)
  })
const until = async (code) => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`return ${code}`)) return
    await wait(50)
  }
  throw Error(`Timeout: ${code}`)
}
const click = async (text) => {
  await evaluate(
    `const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('Missing button: '+${JSON.stringify(text)});button.click()`
  )
  await wait(100)
}
const input = async (selector, value) => {
  await evaluate(
    `const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));`
  )
  await wait(50)
}
const select = async (name, value) => {
  await evaluate(
    `const el=document.querySelector('select[name="${name}"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}))`
  )
  await wait(50)
}
const tagKey = async (key) => {
  await evaluate(
    `document.querySelector('#wallpaper-tags').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`
  )
  await wait(50)
}
app.whenReady().then(async () => {
  let code = 0
  const timer = setTimeout(() => app.exit(2), 90000)
  try {
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.join(__dirname, 'vite.config.mjs'),
      server: { host: '127.0.0.1', port, strictPort: true }
    })
    await server.listen()
    win = new BrowserWindow({
      width: 1000,
      height: 1000,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    const errors = []
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) {
        errors.push(message)
        console.error(message)
      }
    })
    await win.loadURL(`http://127.0.0.1:${port}/wallpapers.html`)
    await until(`document.querySelector('h3')`)
    await until(`document.querySelectorAll('button[aria-pressed]').length===10`)
    assert.equal(await evaluate(`return window.__wallpapers.queries[0].limit`), 10)
    assert.equal(await evaluate(`return window.__wallpapers.queries[0].sort`), 'mostUsed')
    const customFirst = `document.querySelector('[aria-busy] > button:first-child')?.getAttribute('aria-label') === 'Add Custom Background'`
    const submitVisible = `[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Submit for review')`
    assert.equal(
      await evaluate(`return ${submitVisible}`),
      false,
      'no submission before a custom upload'
    )
    assert.equal(await evaluate(`return ${customFirst}`), true, 'custom tile is always first')
    await evaluate(`document.querySelector('button[aria-label="Add Custom Background"]').click()`)
    await click('Add Custom Background')
    assert.equal(await evaluate(`return window.__wallpapers.customAdds`), 2)
    assert.equal(
      await evaluate(`return document.querySelectorAll('button[aria-pressed]').length`),
      10,
      'adding a custom background does not hide the catalog or replace a store result'
    )
    await until(`document.querySelectorAll('button[aria-pressed] img').length===10`)
    assert.deepEqual(
      await evaluate(
        `return [...document.querySelectorAll('button[aria-pressed]')].map(button=>button.textContent.trim())`
      ),
      ['Aurora Hills', ...Array.from({ length: 9 }, (_, index) => `Silent Drift ${index + 1}`)],
      'wallpaper cards show titles without media type, dimensions, or active-device counts'
    )
    assert.equal(
      await evaluate(
        `return !!document.querySelectorAll('button[aria-pressed]')[1].querySelector('svg')`
      ),
      true,
      'video cards retain the play indicator'
    )
    assert.equal(
      await evaluate(`return [...document.images].every(image=>image.src.startsWith('data:'))`),
      true
    )
    assert.equal(
      await evaluate(`return !!document.querySelector('#actions button[title]')`),
      true,
      'submit sits next to reset effects'
    )
    assert.equal(
      await evaluate(`return window.__wallpapers.previews.length`),
      0,
      'grid never fetches animation'
    )
    await evaluate(`document.querySelector('button[aria-pressed]').click()`)
    await until(`document.querySelector('h4')`)
    assert.equal(
      await evaluate(`return window.__wallpapers.applied.length`),
      0,
      'preview does not apply'
    )
    await click('Use background')
    assert.equal(await evaluate(`return window.__wallpapers.applied.length`), 1)
    assert.equal(
      await evaluate(`return ${submitVisible}`),
      false,
      'catalog wallpapers cannot be resubmitted'
    )
    await click('Choose local')
    assert.equal(
      await evaluate(`return ${submitVisible}`),
      true,
      'custom upload reveals submission even for identical image bytes'
    )
    await click('Submit for review')
    assert.equal(
      await evaluate(`return document.querySelector('button[type=submit]').disabled`),
      true
    )
    await input('form input[name=title]', 'Moonlit Forest')
    const tagValues = `return [...document.querySelectorAll('form button[aria-label^="Remove tag "]')].map(button=>button.getAttribute('aria-label').replace('Remove tag ',''))`
    assert.deepEqual(
      await evaluate(tagValues),
      ['image', 'moonlit', 'forest'],
      'tags generated from title and media'
    )
    assert.equal(
      await evaluate(`return document.querySelector('input[name=credit]').required`),
      false
    )
    assert.equal(
      await evaluate(`return document.querySelector('select[name=license]').value`),
      '',
      'license must be chosen explicitly'
    )
    await select('license', 'other')
    assert.equal(
      await evaluate(`return document.querySelector('input[name=permission]').required`),
      true
    )
    await input('input[name=permission]', 'Original artwork / MIT')
    await select('license', 'CC0-1.0')
    assert.equal(await evaluate(`return !!document.querySelector('input[name=permission]')`), false)
    await input('#wallpaper-tags', ' Nature ')
    await tagKey('Enter')
    await input('#wallpaper-tags', 'NATURE')
    await tagKey(',')
    assert.deepEqual(
      await evaluate(tagValues),
      ['image', 'moonlit', 'forest', 'nature'],
      'tag entry normalizes and deduplicates'
    )
    await evaluate(`document.querySelector('button[aria-label="Remove tag moonlit"]').click()`)
    await input('form input[name=title]', 'Quiet Forest')
    assert.deepEqual(
      await evaluate(tagValues),
      ['image', 'forest', 'nature'],
      'title edits preserve manual tags and removals'
    )
    await click('Generate tags')
    assert.deepEqual(await evaluate(tagValues), ['image', 'forest', 'nature', 'quiet'])
    await evaluate(
      `const data=new DataTransfer();data.setData('text','mist, Nature\\nnight');document.querySelector('#wallpaper-tags').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))`
    )
    assert.deepEqual(
      await evaluate(tagValues),
      ['image', 'forest', 'nature', 'quiet', 'mist', 'night'],
      'paste creates normalized chips'
    )
    await tagKey('Backspace')
    assert.deepEqual(
      await evaluate(tagValues),
      ['image', 'forest', 'nature', 'quiet', 'mist'],
      'backspace removes last chip'
    )
    await evaluate(`document.querySelector('input[type=checkbox]').click()`)
    await until(
      `!document.querySelector('form:has(input[name=title]) button[type=submit]').disabled`
    )
    await input('#wallpaper-tags', 'x'.repeat(200))
    assert.equal(
      await evaluate(`return document.querySelector('button[type=submit]').disabled`),
      true,
      'serialized tags are bounded to 200 characters'
    )
    await input('#wallpaper-tags', '')
    await until(`!document.querySelector('button[type=submit]').disabled`)
    await click('Send for review')
    const submission = await evaluate(`return window.__wallpapers.submissions[0]`)
    assert.equal(submission.credit, '', 'author may be empty')
    assert.equal(submission.license, 'CC0-1.0')
    assert.equal(submission.tags, 'image, forest, nature, quiet, mist')
    await click('Submit for review')
    await select('license', 'other')
    await input('input[name=permission]', 'Original artwork / MIT')
    await evaluate(`document.querySelector('input[type=checkbox]').click()`)
    await click('Replace local')
    await until(`!document.querySelector('input[type=checkbox]').checked`)
    await evaluate(`document.querySelector('input[type=checkbox]').click()`)
    await click('Send for review')
    assert.equal(await evaluate(`return window.__wallpapers.submissions.length`), 2)
    assert.equal(
      await evaluate(`return window.__wallpapers.submissions[1].license`),
      'Original artwork / MIT'
    )
    await until(`document.querySelector('[role=status]').textContent.includes('Submitted')`)
    await input('input[type=search]', 'slow')
    assert.equal(await evaluate(`return ${customFirst}`), true, 'custom tile stays during loading')
    await wait(300)
    await input('input[type=search]', 'fast')
    await wait(1100)
    assert.equal(
      await evaluate(`return document.querySelector('button[aria-pressed] span').textContent`),
      'fast'
    )
    await evaluate(`document.querySelectorAll('button[aria-pressed]')[1].click()`)
    await until(`!!document.querySelector('h4')`)
    await evaluate(`document.querySelector('[data-wallpaper-preview]').scrollIntoView()`)
    await until(`document.querySelector('[data-wallpaper-preview] video')?.videoWidth===96`)
    assert.equal(
      await evaluate(
        `const v=document.querySelector('[data-wallpaper-preview] video');return v.loop && v.muted && v.playsInline && !v.paused`
      ),
      true
    )
    assert.equal(
      await evaluate(`return window.__wallpapers.applied.length`),
      1,
      'preview never applies'
    )
    const times = []
    for (let i = 0; i < 30; i++) {
      times.push(
        await evaluate(
          `return document.querySelector('[data-wallpaper-preview] video').currentTime`
        )
      )
      await wait(100)
    }
    assert.ok(
      times.some((time, index) => index && time < times[index - 1]),
      'video loops back to start'
    )
    await evaluate(`document.querySelectorAll('button[aria-pressed]')[2].click()`)
    await until(
      `document.querySelector('[data-wallpaper-preview] img')?.src.startsWith('data:image/gif;')`
    )
    const colors = new Set()
    for (let i = 0; i < 12; i++) {
      const rect = await evaluate(
        `const img=document.querySelector('[data-wallpaper-preview] img');await img.decode();const r=img.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}`
      )
      colors.add((await win.webContents.capturePage(rect)).toPNG().toString('base64'))
      await wait(100)
    }
    assert.ok(colors.size > 1, 'GIF preview changes frames')
    await evaluate(
      `window.__wallpapers.previewDelay=300;document.querySelectorAll('button[aria-pressed]')[1].click()`
    )
    await evaluate(`document.querySelectorAll('button[aria-pressed]')[0].click()`)
    await wait(500)
    assert.equal(
      await evaluate(`return !!document.querySelector('[data-wallpaper-preview] video')`),
      false,
      'late selection is ignored'
    )
    await evaluate(
      `window.__wallpapers.previewDelay=0;window.__wallpapers.previewFail=true;document.querySelectorAll('button[aria-pressed]')[1].click()`
    )
    await wait(100)
    assert.equal(
      await evaluate(`return !!document.querySelector('[data-wallpaper-preview] img')`),
      true,
      'failed preview retains thumbnail'
    )
    await evaluate(
      `window.__wallpapers.previewFail=false;document.querySelectorAll('button[aria-pressed]')[0].click();`
    )
    await evaluate(`document.querySelectorAll('button[aria-pressed]')[1].click()`)
    await until(`!!document.querySelector('[data-wallpaper-preview] video')`)
    assert.equal(
      await evaluate(
        `return performance.getEntriesByType('resource').some(entry=>entry.name.includes('do-not-load'))`
      ),
      false
    )
    await click('Reduce motion')
    await until(`!document.querySelector('video')`)
    const previewCount = await evaluate(`return window.__wallpapers.previews.length`)
    await evaluate(`document.querySelectorAll('button[aria-pressed]')[3].click()`)
    await wait(100)
    assert.equal(
      await evaluate(`return window.__wallpapers.previews.length`),
      previewCount,
      'reduced motion does not fetch previews'
    )
    await click('Full motion')
    await until(`!!document.querySelector('[data-wallpaper-preview] video')`)
    const searches = await evaluate(`return window.__wallpapers.searches.length`)
    await click('Toggle active')
    await wait(400)
    assert.equal(await evaluate(`return window.__wallpapers.searches.length`), searches)
    assert.equal(await evaluate(`return document.querySelector('input[type=search]')`), null)
    assert.equal(
      await evaluate(`return document.querySelector('[data-wallpaper-preview] video')`),
      null,
      'inactive view releases media'
    )
    await click('Toggle active')
    await until(`document.querySelectorAll('button[aria-pressed]').length===10`)
    await evaluate(`window.__wallpapers.fail=true`)
    await input('input[type=search]', 'error')
    await until(`!!document.querySelector('[role=alert]')`)
    assert.equal(await evaluate(`return ${customFirst}`), true, 'custom tile survives store errors')
    assert.equal(
      await evaluate(
        `return document.querySelector('button[aria-label="Add Custom Background"]').disabled`
      ),
      false
    )
    await evaluate(`window.__wallpapers.fail=false`)
    await click('Retry catalog')
    await until(`document.querySelectorAll('button[aria-pressed]').length===10`)
    await evaluate(
      `const el=document.querySelector('select[aria-label="Sort wallpapers"]');el.value='recentApproved';el.dispatchEvent(new Event('change',{bubbles:true}));`
    )
    await until(
      `window.__wallpapers.queries.at(-1).sort==='recentApproved' && document.querySelectorAll('button[aria-pressed]').length===10`
    )
    await click('Load more')
    await until(`document.querySelectorAll('button[aria-pressed]').length===20`)
    assert.equal(
      await evaluate(`return ${customFirst}`),
      true,
      'custom tile stays first after sorting and pagination'
    )
    assert.equal(
      await evaluate(
        `return document.querySelectorAll('button[aria-label="Add Custom Background"]').length`
      ),
      1,
      'pagination does not duplicate the custom tile'
    )
    await input('input[type=search]', 'empty')
    await until(
      `document.querySelector('[aria-busy]')?.getAttribute('aria-busy')==='false' && document.querySelectorAll('button[aria-pressed]').length===0`
    )
    assert.equal(
      await evaluate(`return ${customFirst}`),
      true,
      'custom tile stays with an empty store'
    )
    await evaluate(
      `localStorage.removeItem('roxy.test.background');localStorage.removeItem('roxy.test.background.library');localStorage.removeItem('roxy.test.background.assets')`
    )
    await win.loadURL(`http://127.0.0.1:${port}/?background`)
    await until(`document.querySelector('#wallpaper-settings #wallpaper-workshop-heading')`)
    assert.equal(
      await evaluate(
        `return !document.querySelector('#background-heading') && !document.querySelector('#wallpaper-settings .background-preview-host') && ![...document.querySelectorAll('#wallpaper-settings button')].some(button=>['Save background','Choose background','Change background'].includes(button.textContent.trim()))`
      ),
      true,
      'Background has no duplicate preview, upload, or save section'
    )
    assert.equal(
      await evaluate(`return ${submitVisible}`),
      false,
      'Background hides submission before a custom upload'
    )
    await evaluate(`location.hash='cancel'`)
    const previousImage = await evaluate(`return (await window.roxy.background.get()).image`)
    await click('Add Custom Background')
    assert.equal(
      await evaluate(`return (await window.roxy.background.get()).image`),
      previousImage,
      'cancel preserves the current background'
    )
    assert.equal(
      await evaluate(`return ${submitVisible}`),
      false,
      'cancel does not reveal submission'
    )
    await evaluate(`location.hash=''`)
    await evaluate(
      `document.querySelector('#wallpaper-settings button[aria-label="Add Custom Background"]').click()`
    )
    await until(
      `[...document.querySelectorAll('#wallpaper-settings button')].some(button=>button.textContent.trim()==='Submit for review' && !button.disabled)`
    )
    assert.equal(
      await evaluate(
        `const add=[...document.querySelectorAll('#wallpaper-settings button')].find(button=>button.textContent.trim()==='Add Custom Background');return !!add.parentElement.querySelector('button[title]')`
      ),
      false,
      'publication is not in the catalog header'
    )
    assert.equal(
      await evaluate(
        `const detail=document.querySelector('[data-custom-details]');return !!detail.querySelector('button[title]') && !![...detail.querySelectorAll('button')].find(button=>button.textContent.trim()==='In use')`
      ),
      true,
      'publication sits beside the selected local card use action'
    )
    await click('Add Custom Background')
    assert.equal(
      await evaluate(`return window.__backgroundActions.choices`),
      3,
      'header and first tile use the real local upload picker'
    )
    assert.equal(
      await evaluate(`return window.__backgroundActions.submissions`),
      0,
      'custom upload never publishes'
    )
    await evaluate(
      `await window.roxy.background.applyCatalog('00000000-0000-4000-8000-000000000001')`
    )
    await until(`!(${submitVisible})`)
    await win.reload()
    await until(`document.querySelector('#wallpaper-settings #wallpaper-workshop-heading')`)
    assert.equal(
      await evaluate(`return ${submitVisible}`),
      false,
      'catalog provenance survives reload'
    )
    await click('Add Custom Background')
    await until(submitVisible)
    await win.reload()
    await until(submitVisible)
    assert.equal(
      await evaluate(`return ${submitVisible}`),
      true,
      'custom upload eligibility survives reload'
    )
    await evaluate(`document.querySelector('#background-sidebar-tab').click()`)
    await until(`document.querySelector('#sidebar-heading')`)
    await click('Remove')
    await evaluate(`document.querySelector('#background-background-tab').click()`)
    await until(`!(${submitVisible})`)
    await evaluate(`document.querySelector('[data-custom-id]').click()`)
    assert.equal(
      await evaluate(`return ${submitVisible}`),
      true,
      'saved local cards can be published without being in use'
    )
    await click('Add Custom Background')
    await evaluate(`location.hash='fail'`)
    await click('Add Custom Background')
    await until(
      `document.querySelector('#wallpaper-settings [role=alert]')?.textContent.includes('Could not save')`
    )
    await evaluate(`location.hash=''`)
    await click('Add Custom Background')
    assert.equal(
      await evaluate(`return window.__backgroundActions.submissions`),
      0,
      'uploads save locally without publishing'
    )
    assert.equal(
      await evaluate(`return !!(await window.roxy.background.get()).image`),
      true,
      'custom upload is saved without a separate Save action'
    )
    await evaluate(`location.hash='';document.querySelector('#background-sidebar-tab').click()`)
    await until(`!!document.querySelector('#background-glass')`)
    await evaluate(`document.querySelector('#background-glass').click()`)
    await evaluate(`document.querySelector('#background-background-tab').click()`)
    await until(
      `!document.querySelector('#wallpaper-settings [role=status]')?.textContent.includes('Nothing was uploaded')`
    )
    await evaluate(
      `[...document.querySelectorAll('#wallpaper-settings button')].find(button=>button.textContent.trim()==='Submit for review').click()`
    )
    await until(`!!document.querySelector('#wallpaper-settings form:has(input[name=title])')`)
    assert.equal(
      await evaluate(
        `return !!document.querySelector('[data-custom-details] form:has(input[name=title])')`
      ),
      true,
      'publication form stays in the selected card details'
    )
    await input('form input[name=title]', 'Aurora Mountains')
    await input('#wallpaper-tags', 'a'.repeat(160))
    await tagKey('Enter')
    win.setContentSize(390, 900)
    await wait(200)
    assert.equal(
      await evaluate(
        `const host=document.querySelector('#wallpaper-settings');return host.scrollWidth<=host.clientWidth`
      ),
      true,
      'real wallpaper settings and expanded submission form do not overflow on mobile'
    )
    await fs.mkdir(path.join(__dirname, '../.out'), { recursive: true })
    await fs.writeFile(
      path.join(__dirname, '../.out/wallpapers-mobile.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    win.setContentSize(1000, 1000)
    await wait(100)
    await fs.writeFile(
      path.join(__dirname, '../.out/wallpapers-desktop.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    for (const [hash, media] of [
      ['gif', 'gif'],
      ['mp4', 'video']
    ]) {
      await evaluate(`location.hash=${JSON.stringify(hash)}`)
      await click('Add Custom Background')
      await until(submitVisible)
      await click('Submit for review')
      const custom = await evaluate(`return (await window.roxy.background.get()).customId`)
      await evaluate(
        `document.querySelector('[data-custom-id="${custom}"]').click();document.querySelector('[data-wallpaper-preview]').scrollIntoView()`
      )
      await until(
        media === 'video'
          ? `document.querySelector('[data-wallpaper-preview] video')?.videoWidth===96`
          : `document.querySelector('[data-wallpaper-preview] img')?.src.startsWith('data:image/gif;')`
      )
      await until(`document.querySelector('button[aria-label="Remove tag ${media}"]')`)
      assert.equal(
        await evaluate(`return document.querySelector('input[type=checkbox]').checked`),
        false,
        'replacing media clears publication consent'
      )
    }
    await evaluate(`location.hash=''`)
    await click('Add Custom Background')
    await until(`document.querySelector('[data-custom-id][aria-current=true]')`)
    const firstCustom = await evaluate(`return (await window.roxy.background.get()).customId`)
    assert.equal(
      await evaluate(
        `return document.querySelector('[data-custom-id="${firstCustom}"]').getAttribute('aria-pressed')`
      ),
      'true',
      'upload is automatically selected'
    )
    assert.ok(
      await evaluate(
        `return document.querySelector('[data-custom-id="${firstCustom}"]').textContent.includes('Custom')`
      )
    )
    await input('input[name=customTitle]', 'Blue Flowers')
    await click('Rename')
    await until(
      `document.querySelector('[data-custom-id="${firstCustom}"]').textContent.includes('Blue Flowers')`
    )
    const libraryBefore = await evaluate(
      `return (await window.roxy.background.listCustom()).value.length`
    )
    await click('Add Custom Background')
    assert.equal(
      await evaluate(`return (await window.roxy.background.listCustom()).value.length`),
      libraryBefore,
      'duplicate upload reuses its card'
    )
    await evaluate(`location.hash='second'`)
    await click('Add Custom Background')
    await until(`document.querySelectorAll('[data-custom-id]').length===${libraryBefore + 1}`)
    const secondCustom = await evaluate(`return (await window.roxy.background.get()).customId`)
    await evaluate(`document.querySelector('[data-custom-id="${firstCustom}"]').click()`)
    assert.equal(
      await evaluate(
        `return document.querySelector('[data-custom-id="${firstCustom}"]').getAttribute('aria-pressed')`
      ),
      'true',
      'click selects card'
    )
    assert.equal(
      await evaluate(
        `return document.querySelector('[data-custom-id="${secondCustom}"]').getAttribute('aria-current')`
      ),
      'true',
      'browsing another card preserves in-use marker'
    )
    await click('Submit for review')
    await until(`document.querySelector('form input[name=title]')`)
    assert.equal(
      await evaluate(`return document.querySelector('form input[name=title]').value`),
      'Blue Flowers',
      'publication form is prefilled for the selected local card'
    )
    await select('license', 'CC0-1.0')
    await evaluate(`document.querySelector('[data-custom-details] input[type=checkbox]').click()`)
    await click('Send for review')
    assert.equal(
      await evaluate(`return window.__backgroundActions.lastSubmission.customId`),
      firstCustom
    )
    assert.equal(
      await evaluate(`return window.__backgroundActions.lastSubmission.expectedImageHash`),
      firstCustom,
      'consent is bound to selected saved media'
    )
    assert.equal(
      await evaluate(`return (await window.roxy.background.get()).customId`),
      secondCustom,
      'publishing an inactive card does not change the active background'
    )
    await evaluate(`document.querySelector('[data-custom-id="${secondCustom}"]').click()`)
    assert.equal(
      await evaluate(`return !!document.querySelector('form input[name=title]')`),
      false,
      'switching cards closes the previous card publication form'
    )
    await evaluate(`document.querySelector('[data-custom-id="${firstCustom}"]').click()`)
    await click('Use background')
    await until(`document.querySelector('[data-custom-id="${firstCustom}"][aria-current=true]')`)
    await win.reload()
    await until(
      `document.querySelector('[data-custom-id="${firstCustom}"][aria-pressed=true][aria-current=true]')`
    )
    assert.ok(
      await evaluate(
        `return document.querySelector('[data-custom-id="${firstCustom}"]').textContent.includes('Blue Flowers')`
      ),
      'name and active selection survive reload'
    )
    await evaluate(`document.querySelector('[data-custom-id="${secondCustom}"]').click()`)
    await click('Add Custom Background')
    await until(`document.querySelector('[data-custom-id="${secondCustom}"][aria-pressed=true]')`)
    await evaluate(
      `location.hash='';document.querySelector('[data-custom-id="${firstCustom}"]').click()`
    )
    await click('Add Custom Background')
    await until(`document.querySelector('[data-custom-id="${firstCustom}"][aria-pressed=true]')`)
    await evaluate(`document.querySelector('[data-custom-id="${secondCustom}"]').click()`)
    await click('Delete from My Backgrounds')
    assert.equal(
      await evaluate(`return document.activeElement?.textContent.trim()`),
      'Cancel',
      'delete confirmation focuses the safe action'
    )
    await click('Cancel')
    assert.equal(
      await evaluate(`return document.activeElement?.textContent.trim()`),
      'Delete from My Backgrounds',
      'cancel restores keyboard focus'
    )
    assert.ok(
      await evaluate(`return !!document.querySelector('[data-custom-id="${secondCustom}"]')`)
    )
    await click('Delete from My Backgrounds')
    await click('Delete background')
    await until(`!document.querySelector('[data-custom-id="${secondCustom}"]')`)
    assert.equal(
      await evaluate(`return (await window.roxy.background.get()).customId`),
      firstCustom,
      'inactive deletion does not clear selection'
    )
    await evaluate(`location.hash='library-fail';window.dispatchEvent(new Event('focus'))`)
    await until(`document.querySelector('[role=alert]')?.textContent.includes('My Backgrounds')`)
    await evaluate(`location.hash=''`)
    await click('Retry catalog')
    await until(`!document.querySelector('[role=alert]')`)
    await evaluate(`document.querySelector('[data-custom-id="${firstCustom}"]').click()`)
    await click('Submit for review')
    await until(`!!document.querySelector('form input[name=title]')`)
    await input('form input[name=title]', 'Published Flowers')
    await select('license', 'CC0-1.0')
    await evaluate(`document.querySelector('input[type=checkbox]').click()`)
    await click('Send for review')
    assert.ok(
      await evaluate(
        `return document.querySelector('[data-custom-id="${firstCustom}"]').textContent.includes('Custom')`
      ),
      'pending submission is still Custom'
    )
    await evaluate(`location.hash='published'`)
    await win.reload()
    await until(`document.querySelector('[data-custom-id="${firstCustom}"]')`)
    assert.equal(
      await evaluate(
        `return document.querySelector('[data-custom-id="${firstCustom}"]').textContent.includes('Custom')`
      ),
      false,
      'confirmed publication removes Custom badge'
    )
    assert.equal(
      await evaluate(`return ${submitVisible}`),
      false,
      'published background cannot be resubmitted'
    )
    await evaluate(`location.hash=''`)
    await click('Delete from My Backgrounds')
    await click('Delete background')
    await until(`!document.querySelector('[data-custom-id="${firstCustom}"]')`)
    assert.equal(
      await evaluate(`return (await window.roxy.background.get()).image`),
      null,
      'active deletion clears the background'
    )
    assert.deepEqual(errors, [])
    console.log(
      'WALLPAPER UI OK: persistent custom cards, selected/in-use states, rename/delete/focus/retry, publication badges, custom-only submission, licenses, tags, consent, local save, mobile'
    )
  } catch (error) {
    console.error(error)
    code = 1
  }
  clearTimeout(timer)
  win?.destroy()
  await server?.close()
  app.exit(code)
})
