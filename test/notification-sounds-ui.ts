import assert from 'node:assert/strict'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdtempSync, promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createServer, type ViteDevServer } from 'vite'
import {
  registerNotificationSoundIpc,
  getSoundLibrary
} from '../src/main/services/notification-sounds'
import { getSettings, setNotifyOnComplete } from '../src/main/db/repo'
import { closeDb } from '../src/main/db/database'
import { CHANNELS } from '../src/shared/ipc'

const temp = mkdtempSync(path.join(os.tmpdir(), 'roxy-sound-ui-'))
app.setPath('userData', temp)
app.on('window-all-closed', () => {})
let window: BrowserWindow
let server: ViteDevServer | undefined
const errors: string[] = []
const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))
const evaluate = (code: string): Promise<any> =>
  window.webContents.executeJavaScript(`(async () => { ${code} })()`, true)
async function until(code: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await evaluate(`return ${code}`)) return
    await wait()
  }
  throw Error(
    `Timed out: ${code}\n${JSON.stringify(errors)}\n${await evaluate('return document.body.innerText')}`
  )
}
async function button(label: string): Promise<void> {
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)}).click()`
  )
  await wait()
}

async function run(): Promise<void> {
  const base = 'http://127.0.0.1:3100'
  const url = `${base}/notification-sounds.html`
  process.env.ELECTRON_RENDERER_URL = url
  server = await createServer({
    configFile: path.resolve('test/canvas/vite.config.mjs'),
    server: { host: '127.0.0.1', port: 3100, strictPort: true }
  })
  await server.listen()
  registerNotificationSoundIpc()
  ipcMain.handle(CHANNELS.settingsGetAll, () => getSettings())
  ipcMain.handle(CHANNELS.settingsSetNotifyOnComplete, (_event, enabled) =>
    setNotifyOnComplete(enabled)
  )
  let toastCount = 0
  ipcMain.handle(CHANNELS.notifyToast, () => {
    toastCount++
  })
  const source = path.join(temp, 'Demo sound.mp3')
  await fs.copyFile('test/fixtures/notification.mp3', source)
  let picked = source
  dialog.showOpenDialog = async () => ({ canceled: !picked, filePaths: picked ? [picked] : [] })
  window = new BrowserWindow({
    width: 960,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.resolve('test/.out/sound-preload.cjs'),
      sandbox: true,
      contextIsolation: true
    }
  })
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })
  await window.loadURL(url)
  await until(`document.querySelector('input[type=radio]:checked')`)
  assert.equal(
    await evaluate(`return document.querySelector('[role=switch]').getAttribute('aria-checked')`),
    'false'
  )
  await button('Import sound')
  await until(`document.querySelectorAll('input[type=radio]').length === 2`)
  assert.equal(getSoundLibrary().selectedId, null)
  assert.equal(getSettings().notifyOnComplete, false)
  await evaluate(`document.querySelectorAll('input[type=radio]')[1].click()`)
  await until(`document.querySelectorAll('input[type=radio]')[1].checked`)
  const selected = getSoundLibrary().selectedId
  assert.ok(selected)
  await fs.rm(source)
  await window.reload()
  await until(`document.querySelectorAll('input[type=radio]')[1]?.checked`)
  await evaluate(`window.__audioSources = []; window.__audioPlays = 0; window.__audioStops = 0;
    window.__originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      window.__audioSources.push(this.src); window.__audioPlays++;
      return window.__originalPlay.call(this);
    };
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function() { window.__audioStops++; return pause.call(this); };`)
  await button('Listen to Demo sound')
  await until(`window.__audioPlays === 1`)
  assert.ok(await evaluate(`return window.__audioSources[0].startsWith('data:audio/mpeg;base64,')`))
  await button('Stop sound')
  assert.ok(await evaluate(`return window.__audioStops > 0`))
  assert.equal(getSettings().notifyOnComplete, false)
  await button('Test notification')
  await until(`window.__audioPlays === 2`)
  assert.equal(toastCount, 1)
  // Rejected custom playback retries the bundled sound, without dropping the toast.
  await evaluate(`HTMLMediaElement.prototype.play = function() {
    window.__audioSources.push(this.src); window.__audioPlays++;
    return this.src.startsWith('data:') ? Promise.reject(new Error('decode failed')) : Promise.resolve();
  };`)
  await button('Test notification')
  await until(`window.__audioPlays === 4`)
  assert.equal(toastCount, 2)
  assert.ok(await evaluate(`return window.__audioSources.at(-1).includes('chime.wav')`))
  // Missing custom copy falls back before playback.
  await fs.rm(path.join(temp, 'notification-sounds', `${selected}.mp3`))
  await button('Test notification')
  await until(`window.__audioPlays === 5`)
  assert.equal(toastCount, 3)
  assert.ok(await evaluate(`return window.__audioSources.at(-1).includes('chime.wav')`))
  await window.setContentSize(390, 800)
  await wait()
  assert.equal(
    await evaluate(`return document.documentElement.scrollWidth <= innerWidth`),
    true,
    'narrow layout does not overflow'
  )
  await fs.mkdir('test/.out', { recursive: true })
  await fs.writeFile(
    'test/.out/notification-sounds-mobile.png',
    (await window.webContents.capturePage()).toPNG()
  )
  window.setContentSize(960, 800)
  await wait()
  await fs.writeFile(
    'test/.out/notification-sounds-desktop.png',
    (await window.webContents.capturePage()).toPNG()
  )
  await button('Delete Demo sound')
  await until(`document.querySelectorAll('input[type=radio]').length === 1`)
  assert.equal(getSoundLibrary().selectedId, null)
  assert.equal(getSettings().notifyOnComplete, false)
  picked = ''
  await button('Import sound')
  await until(
    `!document.querySelector('section').getAttribute('aria-busy') || document.querySelector('section').getAttribute('aria-busy') === 'false'`
  )
  assert.equal(
    await evaluate(`return document.querySelector('[role=alert]')`),
    null,
    'cancel is silent'
  )
  picked = path.join(temp, 'bad.mp3')
  await fs.writeFile(picked, 'not audio')
  await button('Import sound')
  await until(`document.querySelector('[role=alert]')`)
  assert.ok(
    await evaluate(
      `return document.querySelector('[role=alert]').textContent.includes('could not be decoded')`
    )
  )
  assert.equal(getSoundLibrary().sounds.length, 0)
  await evaluate(`document.querySelector('[role=switch]').click()`)
  await until(`document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true'`)
  assert.equal(getSettings().notifyOnComplete, true)
  const unauthorized = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.resolve('test/.out/sound-preload.cjs'),
      sandbox: true,
      contextIsolation: true
    }
  })
  await unauthorized.loadURL('data:text/html,untrusted')
  assert.equal(
    await unauthorized.webContents.executeJavaScript('window.roxy.notifications.soundAudio()'),
    null
  )
  assert.deepEqual(
    await unauthorized.webContents.executeJavaScript('window.roxy.notifications.selectSound(null)'),
    { ok: false, error: 'readFailed' }
  )
  unauthorized.destroy()
  assert.deepEqual(errors, [])
  console.log(
    'Sound UI and real IPC: import, select, reload, preview, fallback, delete, cancel, errors, opt-in, untrusted caller, desktop/mobile passed'
  )
}

void app
  .whenReady()
  .then(run)
  .then(
    async () => {
      window?.destroy()
      await server?.close()
      closeDb()
      app.exit(0)
    },
    async (error) => {
      console.error(error)
      window?.destroy()
      await server?.close()
      closeDb()
      app.exit(1)
    }
  )
