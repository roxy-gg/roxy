const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const root = path.resolve(__dirname, '../../../roxy.gg')
const express = require(path.join(root, 'node_modules/express'))
let server, win
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => win.webContents.executeJavaScript(`(async()=>{${code}})()`, true)
const until = async (code) => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`return ${code}`)) return
    await wait(50)
  }
  throw Error(`Timeout: ${code}`)
}
app.whenReady().then(async () => {
  let code = 0
  try {
    const png = await require('sharp')({
      create: { width: 320, height: 180, channels: 3, background: '#234659' }
    })
      .png()
      .toBuffer()
    const id = '00000000-0000-4000-8000-000000000001'
    const fixture = {
      id,
      title: 'Original Horizon',
      description: 'Original test artwork',
      tags: 'minimal',
      credit: 'Test artist',
      license: 'Original / MIT',
      kind: 'image',
      width: 320,
      height: 180,
      duration: 0,
      bytes: png.length,
      status: 'pending',
      version: 1,
      featured: false,
      reviewNote: '',
      posterUrl: `/api/admin/wallpapers/${id}/poster`,
      mediaUrl: `/api/admin/wallpapers/${id}/media`
    }
    const web = express()
    web.use(express.json())
    let loggedIn = false
    let staff = true,
      reviewed = 0
    const me = () => ({
      user: { id: 1, email: 'fred@a2.agency', name: 'Reviewer' },
      teams: [],
      billingConfigured: true,
      needsOnboarding: true,
      isAdmin: false,
      canReviewWallpapers: staff
    })
    web.get('/api/auth/me', (_req, res) => {
      if (!loggedIn) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      res.json(me())
    })
    web.post('/api/auth/login', (_req, res) => {
      loggedIn = true
      res.json(me())
    })
    web.post('/api/auth/signup', (_req, res) => {
      loggedIn = true
      res.json(me())
    })
    web.get('/api/admin/wallpapers', async (req, res) => {
      await wait(req.query.status === 'approved' ? 350 : 30)
      res.json({ entries: req.query.status === 'pending' ? [fixture] : [], nextCursor: null })
    })
    web.get('/api/admin/wallpapers/:id/:variant', (_req, res) => res.type('png').send(png))
    web.post('/api/admin/wallpapers/:id/review', (req, res) => {
      assert.equal(req.body.version, 1)
      reviewed++
      res.json({ ok: true })
    })
    web.use(express.static(path.join(root, 'web/dist')))
    web.get('*', (_req, res) => res.sendFile(path.join(root, 'web/dist/index.html')))
    server = web.listen(3102, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    win = new BrowserWindow({
      width: 1100,
      height: 950,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    await win.loadURL('http://127.0.0.1:3102/wallpapers/review')
    await until(`document.querySelector('input[type=email]')`)
    await evaluate(
      `for (const [selector,value] of [['input[type=email]','fred@a2.agency'],['input[type=password]','fixture-password']]) { const el=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true})); }`
    )
    await wait(50)
    await evaluate(`document.querySelector('form').requestSubmit()`)
    await until(`document.querySelector('h1')?.textContent==='Wallpaper Review'`)
    assert.equal(
      new URL(win.webContents.getURL()).pathname,
      '/wallpapers/review',
      'staff moderation does not require billing onboarding'
    )
    await until(`document.querySelector('button[aria-pressed]')`)
    assert.equal(
      await evaluate(`return !!document.querySelector('nav a[href="/wallpapers/review"]')`),
      true,
      'listed users see Wallpapers tab'
    )
    assert.equal(
      await evaluate(
        `return [...document.querySelectorAll('nav a')].some(link=>link.textContent==='Analytics')`
      ),
      false
    )
    await evaluate(`document.querySelector('button[aria-pressed]').click()`)
    await until(`document.querySelector('h2')`)
    assert.equal(
      await evaluate(
        `return [...document.querySelectorAll('button')].find(button=>button.textContent==='Approve and publish').disabled`
      ),
      true
    )
    await evaluate(`document.querySelectorAll('input[type=checkbox]')[1].click()`)
    await until(
      `![...document.querySelectorAll('button')].find(button=>button.textContent==='Approve and publish').disabled`
    )
    win.setContentSize(390, 900)
    await wait(100)
    assert.equal(
      await evaluate(`return document.documentElement.scrollWidth<=innerWidth`),
      true,
      'staff portal mobile has no overflow'
    )
    await fs.writeFile(
      path.join(__dirname, '../.out/wallpapers-admin-mobile.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    await evaluate(
      `[...document.querySelectorAll('button')].find(button=>button.textContent==='Approve and publish').click()`
    )
    await until(`!document.querySelector('h2')`)
    assert.equal(reviewed, 1)
    await evaluate(
      `const el=document.querySelector('select');el.value='approved';el.dispatchEvent(new Event('change',{bubbles:true}));`
    )
    await wait(80)
    assert.equal(
      await evaluate(`return document.querySelectorAll('button[aria-pressed]').length`),
      0,
      'stale queue rows clear while loading'
    )
    await until(`document.body.textContent.includes('No submissions in this queue.')`)
    staff = false
    await win.reload()
    await until(`location.pathname!='/wallpapers/review'`)
    loggedIn = false
    staff = true
    await win.loadURL('http://127.0.0.1:3102/signup')
    await until(`document.querySelectorAll('input[type=password]').length===2`)
    await evaluate(
      `for (const el of document.querySelectorAll('input')) { const value=el.type==='email'?'fred@a2.agency':'fixture-password';Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true})); }`
    )
    await wait(50)
    await evaluate(`document.querySelector('form').requestSubmit()`)
    await until(
      `location.pathname==='/wallpapers/review' && document.querySelector('h1')?.textContent==='Wallpaper Review'`
    )
    console.log(
      'STAFF WALLPAPER UI OK: auth gate, billing independence, consent, queue transitions, moderation action, mobile'
    )
  } catch (error) {
    console.error(error)
    code = 1
  }
  win?.destroy()
  if (server) await new Promise((resolve) => server.close(resolve))
  app.exit(code)
})
