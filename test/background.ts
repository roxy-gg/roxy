import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
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
  app.on('window-all-closed', () => {})
  if (process.env.ROXY_BACKGROUND_RELOAD_TEST) {
    app.setPath('userData', process.env.ROXY_BACKGROUND_RELOAD_TEST)
    if (process.env.ROXY_BACKGROUND_VIDEO_RELOAD) {
      const state = await service.getBackground()
      assert.ok(state.image?.startsWith('data:video/mp4;base64,'))
      assert.ok(state.poster?.startsWith('data:image/png;base64,'))
      assert.equal(state.settings.sidebarOpacity, 37)
      console.log('Fresh process restored video without the original file')
      return
    }
    const state = await service.getBackground()
    assert.deepEqual(state.settings, {
      ...DEFAULT_BACKGROUND,
      effect: 'ascii',
      sessionOpacity: 22,
      sidebarStyle: 'glass'
    })
    assert.ok(state.image?.startsWith('data:image/png;base64,'))
    const gif = await service.importBackground(
      path.join(process.env.ROXY_BACKGROUND_RELOAD_TEST, 'animated.gif')
    )
    assert.ok(gif.ok)
    assert.ok(gif.state.image?.startsWith('data:image/gif;base64,'))
    console.log('Fresh process restored wallpaper without the original file')
    await service.importBackground(
      path.join(process.env.ROXY_BACKGROUND_RELOAD_TEST, 'restored.png')
    )
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
    assert.equal(normalizeBackground({ sidebarStyle: 'glass' }).sidebarStyle, 'glass')
    assert.equal(normalizeBackground({ sidebarStyle: 'dimmed' }).sidebarStyle, 'dimmed')
    assert.equal(normalizeBackground({ sidebarStyle: 'bad' }).sidebarStyle, 'default')
    assert.equal(normalizeBackground({ sidebarOpacity: -1 }).sidebarOpacity, 0)
    assert.equal(normalizeBackground({ sidebarOpacity: 120 }).sidebarOpacity, 100)
    assert.equal(normalizeBackground({ sidebarOpacity: NaN }).sidebarOpacity, 66)
    assert.equal(normalizeBackground({ sidebarOpacity: 37 }).sidebarOpacity, 37)
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
    const gifInput = path.join(directory, 'animated.gif')
    const frames = Buffer.alloc(16 * 16 * 2 * 4)
    for (let i = 0; i < 16 * 16; i++) {
      frames[i * 4] = 255
      frames[i * 4 + 3] = 255
      frames[(16 * 16 + i) * 4 + 2] = 255
      frames[(16 * 16 + i) * 4 + 3] = 255
    }
    await sharp(frames, { raw: { width: 16, height: 32, channels: 4, pageHeight: 16 } })
      .gif({ delay: [100, 100], loop: 1 })
      .toFile(gifInput)
    const gif = await service.importBackground(gifInput)
    assert.ok(gif.ok)
    assert.ok(gif.state.image?.startsWith('data:image/gif;base64,'))
    const gifMeta = await sharp(Buffer.from(gif.state.image!.split(',')[1], 'base64'), {
      animated: true
    }).metadata()
    assert.equal(gifMeta.pages, 2)
    assert.deepEqual(gifMeta.delay, [100, 100])
    assert.equal((await service.getBackground()).image, gif.state.image)

    assert.equal(gifMeta.loop, 0, 'GIFs always loop even if the original has a finite loop')
    assert.ok(gif.state.poster?.startsWith('data:image/png;base64,'))
    for (const extension of ['mp4', 'mov']) {
      const videoInput = path.join(directory, `clip.${extension}`)
      await fs.copyFile(
        path.join(process.cwd(), `test/fixtures/background.${extension}`),
        videoInput
      )
      const result = await service.importBackground(videoInput)
      assert.ok(result.ok, `${extension} video decodes`)
      assert.ok(result.state.image?.startsWith('data:video/mp4;base64,'))
      assert.ok(result.state.poster?.startsWith('data:image/png;base64,'))
      const frame = await sharp(
        Buffer.from(result.state.poster!.split(',')[1], 'base64')
      ).metadata()
      assert.equal(frame.width, 96)
      assert.equal(frame.height, 64)
      await service.updateBackground({ sidebarOpacity: 37 })
      await fs.rm(videoInput)
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [process.argv[1]], {
          env: {
            ...process.env,
            ROXY_BACKGROUND_RELOAD_TEST: directory,
            ROXY_BACKGROUND_VIDEO_RELOAD: '1'
          },
          stdio: 'inherit'
        })
        child.once('error', reject)
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`Video reload exited ${code}`))
        )
      })
      const badVideo = path.join(directory, 'bad.mp4')
      await fs.writeFile(badVideo, data)
      assert.deepEqual(await service.importBackground(badVideo), {
        ok: false,
        error: 'invalidVideo'
      })
      assert.equal(
        (await service.getBackground()).image,
        result.state.image,
        'invalid video keeps previous background'
      )
      await service.removeBackground()
      assert.equal((await service.getBackground()).poster, undefined)
    }
    assert.deepEqual(
      await service.importBackground(
        path.join(process.cwd(), 'test/fixtures/background-unsupported.mov')
      ),
      { ok: false, error: 'invalidVideo' },
      'unsupported MOV codec is rejected'
    )
    await fs.writeFile(path.join(directory, 'restored.png'), data)
    await service.importBackground(input)
    const updated = await service.updateBackground({
      ...DEFAULT_BACKGROUND,
      effect: 'ascii',
      sessionOpacity: 22,
      sidebarStyle: 'glass'
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
    await Promise.all([
      service.updateBackground({ effect: 'halftone' }),
      service.updateBackground({ glass: false })
    ])
    assert.deepEqual(
      (await service.getBackground()).settings,
      {
        ...DEFAULT_BACKGROUND,
        effect: 'halftone',
        glass: false
      },
      'independent concurrent settings do not overwrite one another'
    )

    const imageFile = path.join(directory, 'valid.png')
    await fs.writeFile(imageFile, data)
    const delayedImport = service.importBackground(imageFile)
    const catalogRevision = service.reserveBackgroundImport()
    await service.removeBackground()
    await service.importBackground(imageFile, undefined, catalogRevision)
    assert.equal(
      (await service.getBackground()).image,
      null,
      'remove cancels a catalog import reserved before download'
    )
    await service.removeBackground()
    await delayedImport
    assert.equal((await service.getBackground()).image, null, 'remove cancels older imports')
    const resetImport = service.importBackground(imageFile)
    await service.resetBackground()
    await resetImport
    assert.deepEqual(await service.getBackground(), { settings: DEFAULT_BACKGROUND, image: null })
    const file = path.join(directory, 'chat-background.json')
    await assert.rejects(
      fs.access(file),
      { code: 'ENOENT' },
      'cancelled import cannot recreate reset storage'
    )
    // A directory at the destination forces rename to fail after the image temp file was written.
    await fs.mkdir(file)
    assert.deepEqual(await service.importBackground(imageFile), { ok: false, error: 'saveFailed' })
    await assert.rejects(
      fs.access(`${file}.tmp`),
      { code: 'ENOENT' },
      'failed save removes image temp file'
    )
    await fs.rm(file, { recursive: true })
    await fs.writeFile(`${file}.tmp`, JSON.stringify(imported.state))
    await service.resetBackground()
    await assert.rejects(
      fs.access(`${file}.tmp`),
      { code: 'ENOENT' },
      'reset removes stale temp file'
    )
    await fs.writeFile(
      file,
      JSON.stringify({ settings: DEFAULT_BACKGROUND, image: gif.state.image })
    )
    assert.ok(
      (await service.getBackground()).poster?.startsWith('data:image/png;base64,'),
      'older GIF state gains a reduced-motion poster'
    )
    await service.resetBackground()
    await fs.writeFile(
      file,
      JSON.stringify({
        settings: DEFAULT_BACKGROUND,
        image: 'data:video/mp4;base64,AAAA',
        poster: 'data:image/png;base64,AAAA'
      })
    )
    assert.equal((await service.getBackground()).image, null, 'corrupt video poster is rejected')
    await service.resetBackground()
    for (const interrupt of ['closed', 'crashed'] as const) {
      app.once('browser-window-created', (_event, decoder) => {
        decoder.webContents.once('did-finish-load', () => {
          if (interrupt === 'closed') decoder.destroy()
          else decoder.webContents.forcefullyCrashRenderer()
        })
      })
      assert.deepEqual(
        await service.importBackground(path.join(process.cwd(), 'test/fixtures/background.mp4')),
        { ok: false, error: 'invalidVideo' },
        `${interrupt} decoder does not hang import`
      )
      assert.equal(BrowserWindow.getAllWindows().length, 0, 'decoder disposed on interruption')
    }
    const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    app.once('browser-window-created', (_event, decoder) => {
      decoder.webContents.once('did-finish-load', () => owner.destroy())
    })
    assert.deepEqual(
      await service.importBackground(
        path.join(process.cwd(), 'test/fixtures/background.mov'),
        owner
      ),
      { ok: false, error: 'invalidVideo' },
      'closing the picker owner aborts the hidden decoder'
    )
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    console.log(
      'BACKGROUND OK: looping GIF, MP4/MOV decode, codec rejection, posters, interrupted imports, persistence, effects and reset'
    )
  } finally {
    await fs
      .rm(directory, { recursive: true, force: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (!['EPERM', 'EBUSY'].includes(error.code ?? '')) throw error
        // Chromium releases its temporary profile locks when Electron exits on Windows.
        console.warn(`Temporary decoder profile retained until process exit: ${error.code}`)
      })
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
