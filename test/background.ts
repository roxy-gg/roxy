import assert from 'node:assert/strict'
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  BACKGROUND_EFFECTS,
  DEFAULT_BACKGROUND,
  backgroundOpacity,
  ditherPixels,
  normalizeBackground
} from '../src/shared/background'
import * as service from '../src/main/services/background'

async function run(): Promise<void> {
  if (process.env.ROXY_BACKGROUND_RELOAD_TEST) {
    app.setPath('userData', process.env.ROXY_BACKGROUND_RELOAD_TEST)
    const state = await service.getBackground()
    assert.deepEqual(state.settings, { ...DEFAULT_BACKGROUND, effect: 'ascii', sessionOpacity: 22 })
    assert.ok(state.image?.startsWith('data:image/png;base64,'))
    console.log('Fresh process restored wallpaper without the original file')
    return
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-background-'))
  app.setPath('userData', directory)
  try {
    assert.deepEqual(normalizeBackground(null), DEFAULT_BACKGROUND)
    assert.deepEqual(
      normalizeBackground({
        effect: 'url(https://bad)',
        glass: 'true',
        emptyOpacity: NaN,
        sessionOpacity: Infinity
      }),
      DEFAULT_BACKGROUND
    )
    assert.equal(normalizeBackground({ emptyOpacity: -100, sessionOpacity: 500 }).emptyOpacity, 0)
    assert.equal(normalizeBackground({ sessionOpacity: 500 }).sessionOpacity, 100)
    for (const effect of BACKGROUND_EFFECTS)
      assert.equal(normalizeBackground({ effect }).effect, effect)
    assert.equal(backgroundOpacity({ ...DEFAULT_BACKGROUND, showOn: 'empty' }, false), 0)
    assert.equal(backgroundOpacity(DEFAULT_BACKGROUND, true), 0.3)
    assert.equal(backgroundOpacity(DEFAULT_BACKGROUND, false), 0.15)
    const pixels = new Uint8ClampedArray(4 * 16).fill(120)
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 137
    ditherPixels(pixels, 4)
    assert.equal(pixels[3], 137)
    assert.ok(new Set(pixels.filter((_, i) => i % 4 !== 3)).size > 1)
    assert.ok(pixels.every((n, i) => i % 4 === 3 || n % 85 === 0))
    assert.deepEqual(await service.getBackground(), { settings: DEFAULT_BACKGROUND, image: null })

    const input = path.join(directory, 'photo.jpg')
    await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#235d8d' } })
      .jpeg()
      .withMetadata()
      .toFile(input)
    const imported = await service.importBackground(input)
    assert.ok(imported.ok)
    assert.ok(imported.state.image?.startsWith('data:image/png;base64,'))
    const data = Buffer.from(imported.state.image!.split(',')[1], 'base64')
    const meta = await sharp(data).metadata()
    assert.equal(meta.width, 2048)
    assert.equal(meta.height, 1024)
    assert.equal(meta.exif, undefined)
    const saved = JSON.parse(
      await fs.readFile(path.join(directory, 'chat-background.json'), 'utf8')
    )
    assert.equal(saved.image, imported.state.image)
    assert.ok(!JSON.stringify(saved).includes(input))

    const updated = await service.updateBackground({
      ...DEFAULT_BACKGROUND,
      effect: 'ascii',
      sessionOpacity: 22
    })
    assert.ok(updated.ok)
    assert.equal(updated.state.image, imported.state.image)
    await fs.rm(input)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [process.argv[1]], {
        env: { ...process.env, ROXY_BACKGROUND_RELOAD_TEST: directory },
        stdio: 'inherit'
      })
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Reload test exited ${code}`))
      )
    })
    const invalid = path.join(directory, 'bad.png')
    await fs.writeFile(
      invalid,
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>'
    )
    assert.deepEqual(await service.importBackground(invalid), { ok: false, error: 'invalidImage' })
    assert.deepEqual(await service.importBackground(path.join(directory, 'missing')), {
      ok: false,
      error: 'readFailed'
    })
    const oversized = path.join(directory, 'large.png')
    const handle = await fs.open(oversized, 'w')
    await handle.truncate(26 * 1024 * 1024)
    await handle.close()
    assert.deepEqual(await service.importBackground(oversized), { ok: false, error: 'tooLarge' })
    assert.equal((await service.getBackground()).image, imported.state.image)
    await Promise.all([
      service.updateBackground({ ...DEFAULT_BACKGROUND, effect: 'dither' }),
      service.removeBackground()
    ])
    assert.deepEqual(await service.getBackground(), {
      settings: { ...DEFAULT_BACKGROUND, effect: 'dither' },
      image: null
    })
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(directory, 'chat-background.json'), 'utf8')),
      await service.getBackground()
    )
    await service.resetBackground()
    assert.deepEqual(await service.getBackground(), { settings: DEFAULT_BACKGROUND, image: null })
    await service.resetBackground()
    await fs.writeFile(path.join(directory, 'chat-background.json'), 'null')
    assert.deepEqual(await service.getBackground(), { settings: DEFAULT_BACKGROUND, image: null })
    console.log(
      'BACKGROUND OK: defaults, validation, six effects, quantization, import, resize, metadata stripping, persistence, removal and reset'
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
void app
  .whenReady()
  .then(run)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    }
  )
