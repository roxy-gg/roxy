import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, mkdirSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { closeDb, getDb } from '../src/main/db/database'
import * as sounds from '../src/main/services/notification-sounds'
import { SOUND_MAX_BYTES } from '../src/shared/notification-sounds'

const root = process.env.ROXY_SOUND_RELOAD ?? mkdtempSync(path.join(os.tmpdir(), 'roxy-sounds-'))
app.setPath('userData', root)
mkdirSync(path.join(root, 'session'), { recursive: true })
app.setPath('sessionData', path.join(root, 'session'))
app.on('window-all-closed', () => {})

function wav(seconds: number, frequency = 440): Buffer {
  const rate = 24000
  const samples = Math.round(rate * seconds)
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++)
    buffer.writeInt16LE(
      Math.round(Math.sin((i * frequency * 2 * Math.PI) / rate) * 1000),
      44 + i * 2
    )
  return buffer
}

async function run(): Promise<void> {
  if (process.env.ROXY_SOUND_RELOAD) {
    const state = sounds.getSoundLibrary()
    assert.equal(state.sounds.length, 1)
    assert.equal(state.selectedId, state.sounds[0].id)
    assert.ok((await sounds.soundAudio())?.startsWith('data:audio/wav;base64,'))
    console.log('Fresh process restored library, selection and copied audio without original')
    return
  }
  assert.deepEqual(sounds.getSoundLibrary(), { selectedId: null, sounds: [] })
  const unrecognized = path.join(root, 'fake.mp3')
  await fs.writeFile(unrecognized, Buffer.from('ID3this is not an audio stream'))
  assert.deepEqual(await sounds.importSound(unrecognized), { ok: false, error: 'invalidAudio' })
  const original = path.join(root, 'Original sound.wav')
  const bytes = wav(0.5)
  await fs.writeFile(original, bytes)
  const imported = await sounds.importSound(original)
  assert.ok(imported.ok, JSON.stringify(imported))
  assert.equal(imported.state.selectedId, null, 'import does not select or enable notifications')
  assert.equal(imported.state.sounds.length, 1)
  const sound = imported.state.sounds[0]
  assert.equal(sound.name, 'Original sound')
  assert.ok(
    Math.abs(sound.duration - 0.5) < 0.001,
    'decoded duration tolerates sample-rate rounding'
  )
  assert.equal(
    getDb().prepare("SELECT value FROM settings WHERE key = 'notify_on_complete'").get(),
    undefined
  )
  assert.deepEqual(await fs.readFile(original), bytes)
  assert.ok((await sounds.importSound(original)).ok)
  assert.equal(sounds.getSoundLibrary().sounds.length, 1, 'duplicates do not consume slots')
  assert.ok((await sounds.selectSound(sound.id)).ok)
  await fs.rm(original)
  assert.deepEqual(Buffer.from((await sounds.soundAudio())!.split(',')[1], 'base64'), bytes)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1]], {
      env: { ...process.env, ROXY_SOUND_RELOAD: root },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolve() : reject(Error(`Reload failed: ${code}`))))
  })
  const invalid = path.join(root, 'invalid.wav')
  await fs.writeFile(invalid, 'not audio')
  assert.deepEqual(await sounds.importSound(invalid), { ok: false, error: 'invalidAudio' })
  await fs.writeFile(invalid, Buffer.alloc(SOUND_MAX_BYTES + 1))
  assert.deepEqual(await sounds.importSound(invalid), { ok: false, error: 'tooLarge' })
  for (const seconds of [0.05, 5.1, 20]) {
    await fs.writeFile(invalid, wav(seconds))
    assert.deepEqual(await sounds.importSound(invalid), { ok: false, error: 'duration' })
  }
  for (const seconds of [0.1, 5]) {
    await fs.writeFile(invalid, wav(seconds))
    assert.ok((await sounds.importSound(invalid)).ok, `${seconds}s boundary accepted`)
  }
  const disguised = path.join(root, 'disguised.mp3')
  await fs.writeFile(disguised, bytes)
  assert.deepEqual(await sounds.importSound(disguised), { ok: false, error: 'invalidAudio' })
  const mp3 = path.join(process.cwd(), 'test/fixtures/notification.mp3')
  assert.ok((await sounds.importSound(mp3)).ok, 'MP3 decodes in Chromium')
  assert.deepEqual(await sounds.selectSound('../escape'), { ok: false, error: 'readFailed' })
  assert.equal(await sounds.soundAudio('../escape'), null)
  const copy = path.join(root, 'notification-sounds', `${sound.id}.wav`)
  await fs.writeFile(copy, 'damaged')
  assert.equal(await sounds.soundAudio(), null, 'corrupt copy requests fallback')
  await fs.writeFile(original, bytes)
  assert.ok((await sounds.importSound(original)).ok, 'reimport repairs copy')
  assert.ok(await sounds.soundAudio())
  assert.ok((await sounds.deleteSound(sound.id)).ok)
  assert.equal(sounds.getSoundLibrary().selectedId, null, 'delete active restores default')
  assert.deepEqual(await fs.readFile(original), bytes, 'delete never touches original')
  await assert.rejects(fs.access(copy), { code: 'ENOENT' })
  const delayed = sounds.importSound(original)
  await sounds.resetNotificationSounds()
  assert.deepEqual(await delayed, { ok: false, error: 'cancelled' })
  assert.deepEqual(sounds.getSoundLibrary(), { sounds: [], selectedId: null })
  const closedOwner = new BrowserWindow({ show: false })
  const interrupted = sounds.importSound(original, closedOwner)
  closedOwner.destroy()
  assert.deepEqual(await interrupted, { ok: false, error: 'invalidAudio' })

  // Fill the library cheaply, then exercise the real serialized count check.
  const entries = Array.from({ length: 19 }, (_, index) => ({
    ...sound,
    id: index.toString(16).padStart(64, '0')
  }))
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('notification_sound_library', JSON.stringify({ selectedId: null, sounds: entries }))
  await fs.writeFile(invalid, wav(0.3, 520))
  const concurrent = await Promise.all([sounds.importSound(original), sounds.importSound(invalid)])
  assert.equal(concurrent.filter((result) => result.ok).length, 1)
  assert.ok(concurrent.some((result) => !result.ok && result.error === 'libraryFull'))
  assert.equal(sounds.getSoundLibrary().sounds.length, 20)
  await sounds.resetNotificationSounds()
  await assert.rejects(fs.access(path.join(root, 'notification-sounds')), { code: 'ENOENT' })
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'no leaked decoder windows')
  console.log(
    'Sound imports, real WAV/MP3 decoding, limits, copies, persistence, delete, reset and concurrency passed'
  )
}

void app
  .whenReady()
  .then(run)
  .then(
    () => {
      closeDb()
      app.exit(0)
    },
    (error) => {
      console.error(error)
      closeDb()
      app.exit(1)
    }
  )
