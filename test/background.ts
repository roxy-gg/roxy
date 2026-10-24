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
import { WallpaperClient } from '../src/main/services/wallpapers'
import { createHash } from 'node:crypto'

async function run(): Promise<void> {
  app.on('window-all-closed', () => {})
  if (process.env.ROXY_BACKGROUND_RELOAD_TEST) {
    app.setPath('userData', process.env.ROXY_BACKGROUND_RELOAD_TEST)
    if (process.env.ROXY_BACKGROUND_LIBRARY_WRITE) {
      const color = process.env.ROXY_BACKGROUND_LIBRARY_WRITE
      const file = path.join(app.getPath('userData'), `worker-${color}.png`)
      await sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
        .png()
        .toFile(file)
      assert.ok((await service.importBackground(file)).ok)
      await fs.rm(file)
      return
    }
    if (process.env.ROXY_BACKGROUND_LIBRARY_RELOAD) {
      const entries = await service.listCustomBackgrounds()
      assert.equal(entries.length, 2)
      assert.ok(entries.some((entry) => entry.title === 'Blue flowers'))
      const current = await service.getBackground()
      assert.ok(current.customId)
      assert.ok(entries.some((entry) => entry.id === current.customId))
      console.log('Fresh process restored the custom library and active selection')
      return
    }
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
    const catalogId = '00000000-0000-4000-8000-000000000001'
    const catalogImport = await service.importBackground(
      input,
      undefined,
      service.reserveBackgroundImport(),
      catalogId
    )
    assert.ok(catalogImport.ok)
    assert.equal(catalogImport.state.catalogId, catalogId)
    await service.updateBackground({ ...DEFAULT_BACKGROUND })
    assert.equal(
      (await service.getBackground()).catalogId,
      catalogId,
      'reset effects preserves catalog selection'
    )
    assert.equal(
      JSON.parse(await fs.readFile(path.join(directory, 'chat-background.json'), 'utf8')).catalogId,
      catalogId
    )
    await service.importBackground(input)
    assert.equal(
      (await service.getBackground()).catalogId,
      undefined,
      'local upload clears catalog identity'
    )
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
    const download = async (media: Buffer, mime: string, kind: 'image' | 'video') => {
      const client = new WallpaperClient('https://roxy.gg', async (url) =>
        String(url).endsWith('/media')
          ? new Response(new Uint8Array(media), { headers: { 'Content-Type': mime } })
          : Response.json({
              id: catalogId,
              title: 'Animated round trip',
              description: '',
              tags: '',
              credit: '',
              license: 'MIT',
              kind,
              mime,
              width: 96,
              height: 64,
              duration: 1,
              bytes: media.length,
              sha256: createHash('sha256').update(media).digest('hex'),
              featured: false
            })
      )
      const downloaded = await client.download(catalogId)
      const file = path.join(directory, `downloaded${downloaded.extension}`)
      await fs.writeFile(file, downloaded.bytes)
      const result = await service.importBackground(
        file,
        undefined,
        service.reserveBackgroundImport(),
        catalogId
      )
      assert.ok(result.ok)
      assert.equal(result.state.catalogId, catalogId)
      await fs.rm(file)
      return result.state
    }
    const downloadedGif = await download(
      Buffer.from(gif.state.image!.split(',')[1], 'base64'),
      'image/gif',
      'image'
    )
    assert.ok(downloadedGif.image?.startsWith('data:image/gif;'))
    assert.equal(
      (
        await sharp(Buffer.from(downloadedGif.image!.split(',')[1], 'base64'), {
          animated: true
        }).metadata()
      ).pages,
      2
    )
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
      if (extension === 'mp4') {
        const downloaded = await download(await fs.readFile(videoInput), 'video/mp4', 'video')
        assert.equal(
          downloaded.image,
          result.state.image,
          'catalog video keeps the verified animated media'
        )
        assert.ok(downloaded.poster?.startsWith('data:image/png;'))
      }
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
    const blackIntro = await service.importBackground(
      path.join(process.cwd(), 'test/fixtures/background-black-intro.mp4')
    )
    assert.ok(blackIntro.ok)
    for (const preview of [
      blackIntro.state.poster!,
      (await service.listCustomBackgrounds())[0].thumbnail
    ]) {
      const { data: pixel } = await sharp(Buffer.from(preview.split(',')[1], 'base64'))
        .resize(1, 1)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      assert.ok(
        pixel[0] > 200 && pixel[1] < 40 && pixel[2] < 40,
        'video preview seeks past the black opening frame'
      )
    }
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
      image: null,
      libraryVersion: (await service.getBackground()).libraryVersion
    })
    const retained = await service.listCustomBackgrounds()
    assert.ok(retained.length > 1, 'clearing active background keeps uploaded media')
    assert.equal(
      JSON.parse(await fs.readFile(path.join(directory, 'chat-background.json'), 'utf8')).library
        .length,
      retained.length
    )
    await service.resetBackground()
    await assert.rejects(
      fs.access(path.join(directory, 'chat-backgrounds')),
      { code: 'ENOENT' },
      'factory reset removes all personal media'
    )
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
    // Saved media is independent of its source, reusable, bounded and privately managed.
    await service.importBackground(imageFile)
    const first = (await service.listCustomBackgrounds())[0]
    assert.equal(first.title, 'valid')
    assert.equal((await service.getBackground()).customId, first.id)
    const thumb = await sharp(Buffer.from(first.thumbnail.split(',')[1], 'base64')).metadata()
    assert.equal(thumb.format, 'webp')
    assert.ok(thumb.width! <= 480 && thumb.height! <= 270)
    assert.ok(first.thumbnail.length < 350000)
    assert.equal('image' in first, false, 'list excludes full media')
    assert.equal('poster' in first, false)
    await service.importBackground(imageFile)
    assert.equal(
      (await service.listCustomBackgrounds()).length,
      1,
      'duplicate uploads reuse the same card'
    )
    const secondFile = path.join(directory, 'second.png')
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#f0b0c0' } })
      .png()
      .toFile(secondFile)
    await service.importBackground(secondFile)
    const second = (await service.listCustomBackgrounds()).find((entry) => entry.id !== first.id)!
    assert.ok(second)
    await fs.rm(secondFile)
    await service.renameCustomBackground(first.id, 'Blue flowers')
    await service.updateBackground({ effect: 'ascii', sidebarOpacity: 39 })
    await service.applyCustomBackground(first.id)
    assert.equal((await service.getBackground()).image, imported.state.image)
    assert.equal((await service.getBackground()).settings.sidebarOpacity, 39)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [process.argv[1]], {
        env: {
          ...process.env,
          ROXY_BACKGROUND_RELOAD_TEST: directory,
          ROXY_BACKGROUND_LIBRARY_RELOAD: '1'
        },
        stdio: 'inherit'
      })
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(Error(`Library reload exited ${code}`))
      )
    })
    await service.importBackground(
      imageFile,
      undefined,
      service.reserveBackgroundImport(),
      catalogId
    )
    assert.equal((await service.getBackground()).customId, undefined)
    await service.applyCustomBackground(second.id)
    assert.equal((await service.getBackground()).catalogId, undefined)
    const inactiveSubmission = await service.getCustomSubmission(first.id)
    assert.equal(
      inactiveSubmission.image,
      imported.state.image,
      'submission loads the selected saved media, not the active image'
    )
    assert.equal(inactiveSubmission.entry.id, first.id)
    assert.equal(
      (await service.getBackground()).customId,
      second.id,
      'preparing inactive publication does not apply it'
    )
    await assert.rejects(() => service.getCustomSubmission('../escape'))
    await service.recordBackgroundSubmission(first.id, catalogId, 'Blue flowers')
    const laterSubmission = '00000000-0000-4000-8000-000000000002'
    await service.recordBackgroundSubmission(first.id, laterSubmission, 'Later submission')
    assert.equal(
      (await service.listCustomBackgrounds()).find((entry) => entry.id === first.id)?.publishedId,
      undefined,
      'submission is not publication'
    )
    await service.refreshCustomPublications(async (id) => id === catalogId)
    assert.equal(
      (await service.listCustomBackgrounds()).find((entry) => entry.id === first.id)?.publishedId,
      catalogId
    )
    assert.equal(
      (await service.getBackground()).customId,
      second.id,
      'approval of another item never switches selection'
    )
    await service.applyCustomBackground(first.id)
    assert.equal((await service.getBackground()).customPublished, true)
    await assert.rejects(
      () => service.getCustomSubmission(first.id),
      'published entries cannot be resubmitted'
    )
    const now = Date.now
    try {
      Date.now = () => now() + 61000
      await service.refreshCustomPublications(async () => {
        throw Error('offline')
      })
      assert.equal(
        (await service.getBackground()).customPublished,
        true,
        'offline checks retain last confirmed publication'
      )
      Date.now = () => now() + 122000
      await service.refreshCustomPublications(async () => false)
      assert.equal(
        (await service.getBackground()).customPublished,
        false,
        'authoritative withdrawal restores Custom'
      )
    } finally {
      Date.now = now
    }
    assert.equal(
      (await service.getBackground()).catalogId,
      undefined,
      'publication badges do not report a local upload as catalog use'
    )
    await service.deleteCustomBackground(second.id)
    await assert.rejects(
      () => service.getCustomSubmission(second.id),
      'deleted saved media cannot be submitted'
    )
    assert.equal(
      (await service.getBackground()).customId,
      first.id,
      'deleting an inactive item keeps current wallpaper'
    )
    await assert.rejects(fs.access(path.join(directory, 'chat-backgrounds', `${second.id}.json`)), {
      code: 'ENOENT'
    })
    assert.deepEqual(await service.applyCustomBackground('../escape'), {
      ok: false,
      error: 'readFailed'
    })
    assert.deepEqual(await service.renameCustomBackground(first.id, 'bad\nname'), {
      ok: false,
      error: 'readFailed'
    })
    const asset = path.join(directory, 'chat-backgrounds', `${first.id}.json`)
    const stalePreview = JSON.parse(
      await fs.readFile(path.join(directory, 'chat-background.json'), 'utf8')
    )
    stalePreview.library.find((entry: { id: string }) => entry.id === first.id).thumbnail =
      'data:image/webp;base64,AAAA'
    await fs.writeFile(path.join(directory, 'chat-background.json'), JSON.stringify(stalePreview))
    await fs.writeFile(asset, '{}')
    assert.equal(
      (await service.applyCustomBackground(first.id)).ok,
      false,
      'corrupt retained assets cannot replace active media'
    )
    assert.equal((await service.getBackground()).customId, first.id)
    assert.ok(
      (await service.importBackground(imageFile)).ok,
      'reupload repairs a damaged retained asset'
    )
    assert.ok((await service.applyCustomBackground(first.id)).ok)
    assert.equal(
      (await service.listCustomBackgrounds())[0].thumbnail,
      first.thumbnail,
      'reupload repairs stale previews'
    )
    assert.equal(
      (await service.listCustomBackgrounds())[0].title,
      'Blue flowers',
      'repair preserves custom name'
    )
    await service.deleteCustomBackground(first.id)
    assert.equal((await service.getBackground()).image, null, 'deleting the active item clears it')
    assert.equal((await service.getBackground()).settings.sidebarOpacity, 39)
    assert.equal((await service.listCustomBackgrounds()).length, 0)
    const manifest = path.join(directory, 'chat-background.json')
    const emptyManifest = await fs.readFile(manifest, 'utf8')
    const fullLibrary = Array.from({ length: 50 }, (_, index) => ({
      ...first,
      id: index === 0 ? first.id : index.toString(16).padStart(64, '0')
    }))
    await fs.writeFile(
      manifest,
      JSON.stringify({
        settings: DEFAULT_BACKGROUND,
        image: null,
        librarySchema: 1,
        library: fullLibrary
      })
    )
    assert.ok(
      (await service.importBackground(imageFile)).ok,
      'duplicate import succeeds at count capacity'
    )
    const capacityFile = path.join(directory, 'capacity.png')
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } })
      .png()
      .toFile(capacityFile)
    assert.deepEqual(await service.importBackground(capacityFile), {
      ok: false,
      error: 'libraryFull'
    })
    await fs.writeFile(
      manifest,
      JSON.stringify({
        settings: DEFAULT_BACKGROUND,
        image: null,
        librarySchema: 1,
        library: Array.from({ length: 11 }, (_, index) => ({
          ...first,
          id: index.toString(16).padStart(64, '0'),
          bytes: 34 * 1024 * 1024
        }))
      })
    )
    assert.deepEqual(
      await service.importBackground(capacityFile),
      { ok: false, error: 'libraryFull' },
      'retained bytes are bounded independently of count'
    )
    await fs.writeFile(manifest, emptyManifest)
    await Promise.all(
      ['red', 'green'].map(
        (color) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [process.argv[1]], {
              env: {
                ...process.env,
                ROXY_BACKGROUND_RELOAD_TEST: directory,
                ROXY_BACKGROUND_LIBRARY_WRITE: color
              },
              stdio: 'inherit'
            })
            child.once('error', reject)
            child.once('exit', (code) =>
              code === 0 ? resolve() : reject(Error(`Concurrent library write exited ${code}`))
            )
          })
      )
    )
    await service.updateBackground({ sidebarOpacity: 42 })
    const sharedEntries = await service.listCustomBackgrounds()
    assert.equal(
      sharedEntries.length,
      2,
      'concurrent processes retain both uploads despite previously cached state'
    )
    for (const entry of sharedEntries) assert.ok((await service.applyCustomBackground(entry.id)).ok)
    const staleGeneration = service.backgroundGeneration()
    await service.recordBackgroundSubmission(sharedEntries[0].id, catalogId, 'Delayed')
    let releasePublication: (published: boolean) => void = () => {}
    let publicationStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      publicationStarted = resolve
    })
    const originalNow = Date.now
    Date.now = () => originalNow() + 183000
    const delayedPublication = service.refreshCustomPublications(async () => {
      publicationStarted()
      return new Promise<boolean>((resolve) => {
        releasePublication = resolve
      })
    })
    await started
    Date.now = originalNow
    await service.resetBackground()
    releasePublication(true)
    await delayedPublication
    await assert.rejects(
      fs.access(manifest),
      { code: 'ENOENT' },
      'late publication check cannot recreate reset storage'
    )
    await service.recordBackgroundSubmission(first.id, catalogId, 'Stale', staleGeneration)
    await assert.rejects(
      fs.access(path.join(directory, 'chat-background.json')),
      { code: 'ENOENT' },
      'late submission completion cannot recreate reset storage'
    )
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
    assert.equal(
      (await service.listCustomBackgrounds()).length,
      1,
      'legacy local background is migrated into the library once'
    )
    assert.ok((await service.getBackground()).customId)
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
    await fs.writeFile(
      file,
      JSON.stringify({ settings: DEFAULT_BACKGROUND, image: 'data:image/png;base64,AAAA' })
    )
    assert.equal(
      (await service.getBackground()).image,
      'data:image/png;base64,AAAA',
      'failed legacy thumbnail generation does not block reads'
    )
    assert.ok(
      (await service.removeBackground()).ok,
      'damaged legacy background can still be cleared'
    )
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
