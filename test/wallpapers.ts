import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { WallpaperClient } from '../src/main/services/wallpapers'
import { startWallpaperUsage } from '../src/main/services/wallpaper-usage'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
const id = '00000000-0000-4000-8000-000000000001'
const bytes = Buffer.from('bounded test media')
const entry = {
  id,
  title: 'Quiet hills',
  description: '',
  tags: 'blue',
  credit: 'Test',
  license: 'MIT',
  kind: 'image',
  width: 100,
  height: 50,
  bytes: bytes.length,
  duration: 0,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  featured: true,
  posterUrl: 'https://attacker.test/image',
  mediaUrl: 'file:///secret'
}
const metadata = {
  title: 'Original',
  description: '',
  tags: '',
  credit: '',
  license: 'Original / MIT',
  rightsConsent: true
}
const image = `data:image/png;base64,${bytes.toString('base64')}`
const submission = {
  ...metadata,
  expectedImageHash: createHash('sha256').update(image).digest('hex')
}
const calls: { url: URL; init: RequestInit }[] = []
const client = new WallpaperClient('https://roxy.gg', async (url, init) => {
  calls.push({ url: new URL(String(url)), init: init! })
  assert.equal(init?.redirect, 'error')
  assert.equal(init?.credentials, 'omit')
  if (init?.method === 'POST') return Response.json({ id, status: 'pending' })
  if (String(url).endsWith('/media'))
    return new Response(bytes, { headers: { 'Content-Type': 'image/png' } })
  return Response.json(String(url).includes('?') ? { entries: [entry], nextCursor: null } : entry)
})
const result = await client.search({ q: 'blue' })
assert.equal(calls[0].url.searchParams.get('limit'), '10')
assert.equal(calls[0].url.searchParams.get('sort'), 'mostUsed')
assert.equal(result.entries[0].posterUrl, `https://roxy.gg/api/wallpapers/${id}/poster`)
assert.equal(result.entries[0].mediaUrl, `https://roxy.gg/api/wallpapers/${id}/media`)
assert.deepEqual(await client.download(id), { bytes, extension: '.png' })
for (const [kind, mime, extension] of [
  ['image', 'image/gif', '.gif'],
  ['video', 'video/mp4', '.mp4']
] as const) {
  const animated = new WallpaperClient('https://roxy.gg', async (url) =>
    String(url).endsWith('/media')
      ? new Response(bytes, { headers: { 'Content-Type': mime } })
      : Response.json({ ...entry, kind, mime, duration: 1 })
  )
  assert.deepEqual(await animated.download(id), { bytes, extension })
  const wrongType = new WallpaperClient('https://roxy.gg', async (url) =>
    String(url).endsWith('/media')
      ? new Response(bytes, { headers: { 'Content-Type': 'image/png' } })
      : Response.json({ ...entry, kind, mime, duration: 1 })
  )
  await assert.rejects(() => wrongType.download(id), 'animated media MIME must match metadata')
}
const invalidMime = new WallpaperClient('https://roxy.gg', async () =>
  Response.json({ ...entry, mime: 'text/html' })
)
await assert.rejects(() => invalidMime.download(id))
assert.equal(
  await client.isPublished(id),
  true,
  'valid public detail confirms publication without downloading media'
)
const unpublished = new WallpaperClient(
  'https://roxy.gg',
  async () => new Response('', { status: 404 })
)
assert.equal(await unpublished.isPublished(id), false, 'pending and rejected are not public')
const offline = new WallpaperClient('https://roxy.gg', async () => {
  throw Error('offline')
})
await assert.rejects(() => offline.isPublished(id), 'offline status is unknown, not unpublished')
const wrongId = new WallpaperClient('https://roxy.gg', async () =>
  Response.json({ ...entry, id: '00000000-0000-4000-8000-000000000002' })
)
await assert.rejects(() => wrongId.isPublished(id))
await assert.rejects(() => client.download('../secret'))
const before = calls.length
await assert.rejects(() => client.submit({ ...submission, rightsConsent: false }, null))
assert.equal(calls.length, before)
assert.deepEqual(await client.result(() => client.submit(submission, null)), {
  ok: false,
  error: 'noBackground'
})
assert.deepEqual(await client.result(() => client.submit(submission, image + 'changed')), {
  ok: false,
  error: 'changed'
})
assert.equal(calls.length, before, 'changed image never leaves the device')
await client.submit(submission, image)
const post = calls.at(-1)!
assert.equal(post.url.pathname, '/api/wallpaper-submissions')
assert.deepEqual(Buffer.from(post.init.body as Uint8Array), bytes)
const headers = post.init.headers as Record<string, string>
assert.deepEqual(
  JSON.parse(Buffer.from(headers['X-Wallpaper-Metadata'], 'base64url').toString()),
  metadata
)
assert.equal(headers.Authorization, undefined)
for (const base of [
  'http://attacker.test',
  'https://user:password@roxy.gg',
  'https://roxy.gg/elsewhere'
])
  assert.throws(() => new WallpaperClient(base))
const limited = new WallpaperClient(
  'https://roxy.gg',
  async () => new Response('', { status: 429 })
)
assert.deepEqual(await limited.result(() => limited.search({})), {
  ok: false,
  error: 'rateLimited'
})
const tampered = new WallpaperClient('https://roxy.gg', async (url) =>
  String(url).endsWith('/media')
    ? new Response('wrong', { headers: { 'Content-Type': 'image/png' } })
    : Response.json(entry)
)
await assert.rejects(() => tampered.download(id))
const huge = new WallpaperClient(
  'https://roxy.gg',
  async () =>
    new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(1024 * 1024) }
    })
)
await assert.rejects(() => huge.search({}))
const previewBytes = await fs.readFile(path.join(process.cwd(), 'test/fixtures/background.mp4'))
const previewMetadata = {
  mime: 'video/mp4',
  bytes: previewBytes.length,
  sha256: createHash('sha256').update(previewBytes).digest('hex')
}
const previewCalls: string[] = []
const previewClient = new WallpaperClient('https://roxy.gg', async (url) => {
  const route = new URL(String(url)).pathname
  previewCalls.push(route)
  return route.endsWith('/preview')
    ? new Response(previewBytes, { headers: { 'Content-Type': 'video/mp4' } })
    : Response.json({ ...entry, kind: 'video', mime: 'video/mp4', preview: previewMetadata })
})
const previewResults = await Promise.all([previewClient.preview(id), previewClient.preview(id)])
assert.equal(previewResults[0], `data:video/mp4;base64,${previewBytes.toString('base64')}`)
assert.equal(previewResults[0], previewResults[1])
assert.deepEqual(
  previewCalls,
  [`/api/wallpapers/${id}`, `/api/wallpapers/${id}/preview`],
  'deduped fixed-route previews never request originals'
)
const beforeLegacy = calls.length
assert.equal(await client.preview(id), null, 'legacy entries keep still thumbnail')
assert.equal(calls.length, beforeLegacy + 1, 'missing preview does not fetch full media')
for (const [data, type] of [
  [Buffer.from('bad'), 'video/mp4'],
  [previewBytes, 'text/html']
] as const) {
  const invalidPreview = new WallpaperClient('https://roxy.gg', async (url) =>
    String(url).endsWith('/preview')
      ? new Response(data, { headers: { 'Content-Type': type } })
      : Response.json({ ...entry, preview: previewMetadata })
  )
  await assert.rejects(() => invalidPreview.preview(id), 'preview validates MIME/size/hash')
}
await assert.rejects(() => previewClient.preview('../escape'))
const animatedPreview = await sharp(
  await fs.readFile(path.join(process.cwd(), 'test/fixtures/background.gif')),
  { animated: true }
)
  .webp({ loop: 0 })
  .toBuffer()
const webpPreviewClient = new WallpaperClient('https://roxy.gg', async (url) =>
  String(url).endsWith('/preview')
    ? new Response(animatedPreview, { headers: { 'Content-Type': 'image/webp' } })
    : Response.json({
        ...entry,
        mime: 'image/gif',
        preview: {
          mime: 'image/webp',
          bytes: animatedPreview.length,
          sha256: createHash('sha256').update(animatedPreview).digest('hex')
        }
      })
)
assert.ok((await webpPreviewClient.preview(id))?.startsWith('data:image/webp;'))
console.log(
  'PASS animated previews: bounded first-party route, dedupe, integrity, GIF/WebP and legacy fallback'
)
console.log(
  'PASS wallpaper client: URL boundaries, bounded responses, integrity, anonymous consented submission and errors'
)

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roxy-wallpaper-client-'))
try {
  const thumbnail = await sharp({
    create: { width: 80, height: 45, channels: 3, background: '#456789' }
  })
    .webp()
    .toBuffer()
  let reads = 0
  const thumbnailFetch: typeof fetch = async (url) => {
    assert.ok(String(url).endsWith('/thumbnail'), 'thumbnail lookup never requests media')
    reads++
    return new Response(thumbnail, { headers: { 'Content-Type': 'image/webp' } })
  }
  const cached = new WallpaperClient('https://roxy.gg', thumbnailFetch, () => directory)
  const previews = await Promise.all([
    cached.thumbnail(id, entry.sha256),
    cached.thumbnail(id, entry.sha256)
  ])
  assert.equal(reads, 1, 'concurrent thumbnail requests share a fetch')
  assert.equal(previews[0], `data:image/webp;base64,${thumbnail.toString('base64')}`)
  assert.equal(await cached.thumbnail(id, entry.sha256), previews[0])
  assert.equal(reads, 1, 'disk thumbnail hit avoids network')
  const restarted = new WallpaperClient(
    'https://roxy.gg',
    async () => {
      throw Error('offline')
    },
    () => directory
  )
  assert.equal(
    await restarted.thumbnail(id, entry.sha256),
    previews[0],
    'cache survives process/client recreation'
  )
  const file = (await fs.readdir(directory)).find((name) => name.endsWith('.webp'))!
  await fs.writeFile(path.join(directory, file), 'corrupt image')
  assert.equal(await cached.thumbnail(id, entry.sha256), previews[0])
  assert.equal(reads, 2, 'corrupt thumbnail is replaced')
  await cached.thumbnail(id, 'b'.repeat(64))
  assert.equal(reads, 3, 'content hash invalidates cached preview')
  const beforeInvalid = reads
  await assert.rejects(() => cached.thumbnail('../escape', entry.sha256))
  assert.equal(reads, beforeInvalid)
  let fail = true
  const retried = new WallpaperClient('https://roxy.gg', async () => {
    if (fail) throw Error('temporary failure')
    return new Response(thumbnail, { headers: { 'Content-Type': 'image/webp' } })
  })
  await assert.rejects(() => retried.thumbnail(id, entry.sha256))
  fail = false
  assert.equal(await retried.thumbnail(id, entry.sha256), previews[0])
  const evictionDirectory = path.join(directory, 'eviction')
  await fs.mkdir(evictionDirectory)
  await Promise.all(
    Array.from({ length: 505 }, async (_, index) => {
      await fs.writeFile(
        path.join(evictionDirectory, `${index.toString(16).padStart(64, '0')}.webp`),
        thumbnail
      )
    })
  )
  const abandoned = path.join(
    evictionDirectory,
    `${'c'.repeat(64)}.webp.00000000-0000-4000-8000-000000000001.tmp`
  )
  await fs.writeFile(abandoned, 'abandoned')
  await fs.utimes(abandoned, new Date(0), new Date(0))
  await new WallpaperClient('https://roxy.gg', thumbnailFetch, () => evictionDirectory).thumbnail(
    id,
    entry.sha256
  )
  assert.ok(
    (await fs.readdir(evictionDirectory)).length <= 500,
    'pruning enforces count cap and removes stale temporary files'
  )
  const bytesDirectory = path.join(directory, 'byte-eviction')
  await fs.mkdir(bytesDirectory)
  for (let index = 0; index < 30; index++) {
    const file = await fs.open(
      path.join(bytesDirectory, `${index.toString(16).padStart(64, '0')}.webp`),
      'w'
    )
    await file.truncate(2 * 1024 * 1024)
    await file.close()
  }
  await new WallpaperClient('https://roxy.gg', thumbnailFetch, () => bytesDirectory).thumbnail(
    id,
    entry.sha256
  )
  const totalBytes = (
    await Promise.all(
      (await fs.readdir(bytesDirectory)).map(
        async (name) => (await fs.stat(path.join(bytesDirectory, name))).size
      )
    )
  ).reduce((sum, bytes) => sum + bytes, 0)
  assert.ok(totalBytes <= 50 * 1024 * 1024, 'cache byte cap is independent of file count')
  console.log(
    'PASS thumbnail cache: bounded WebP, disk persistence, dedupe, corruption recovery, content invalidation and retry'
  )

  const usageDirectory = path.join(directory, 'usage')
  let selection: string | null = null
  let wake: () => void = () => {}
  const reports: { deviceId: string; wallpaperId: string | null; sequence: number }[] = []
  const options = {
    directory: usageDirectory,
    current: async () => selection,
    subscribe: (listener: () => void) => {
      wake = listener
      return () => {
        wake = () => {}
      }
    },
    report: async (deviceId: string, wallpaperId: string | null, sequence: number) => {
      reports.push({ deviceId, wallpaperId, sequence })
    },
    retryMs: 10,
    heartbeatMs: 100000
  }
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (check()) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw Error('Usage report timeout')
  }
  let stop = startWallpaperUsage(options)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(reports.length, 0, 'local-only users do not create/report wallpaper device IDs')
  selection = id
  wake()
  await until(() => reports.length === 1)
  const deviceId = reports[0].deviceId
  assert.notEqual(deviceId, id)
  selection = null
  wake()
  await until(() => reports.length === 2)
  assert.equal(reports[1].deviceId, deviceId)
  assert.equal(reports[1].wallpaperId, null)
  assert.ok(reports[1].sequence > reports[0].sequence)
  stop()
  stop = startWallpaperUsage(options)
  await until(() => reports.length === 3)
  assert.equal(
    reports[2].deviceId,
    deviceId,
    'restart preserves identity and reconciles a cleared background'
  )
  stop()
  let release: () => void = () => {}
  let block = true
  selection = id
  stop = startWallpaperUsage({
    ...options,
    report: async (deviceId, wallpaperId, sequence) => {
      reports.push({ deviceId, wallpaperId, sequence })
      if (block) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        throw Error('offline')
      }
    }
  })
  await until(() => reports.length === 4)
  selection = '00000000-0000-4000-8000-000000000002'
  wake()
  selection = null
  wake()
  block = false
  release()
  await until(() => reports.length === 5)
  assert.equal(
    reports[4].wallpaperId,
    null,
    'retry reports latest state, not intermediate wallpaper'
  )
  assert.ok(reports[4].sequence > reports[3].sequence)
  stop()
  console.log(
    'PASS wallpaper usage: separate durable device ID, switching/clearing, restart, monotonic ordering and coalesced retries'
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  await fs.writeFile(path.join(usageDirectory, 'wallpaper-device.json'), '{broken')
  selection = id
  const beforeCorruption = reports.length
  stop = startWallpaperUsage(options)
  await until(() => reports.length > beforeCorruption)
  assert.notEqual(
    reports.at(-1)!.deviceId,
    deviceId,
    'corrupt identity recovers instead of retrying forever'
  )
  stop()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const beforeOwners = reports.length
  const stopFirst = startWallpaperUsage(options)
  const stopSecond = startWallpaperUsage(options)
  await until(() => reports.length >= beforeOwners + 2)
  assert.equal(
    reports.at(-1)!.deviceId,
    reports.at(-2)!.deviceId,
    'concurrent reporters share one durable identity'
  )
  assert.ok(reports.at(-1)!.sequence > reports.at(-2)!.sequence)
  stopFirst()
  stopSecond()
  await new Promise((resolve) => setTimeout(resolve, 20))
  console.log('PASS usage corruption recovery and concurrent profile ownership')
  const previousReports = reports.length
  selection = null
  stop = startWallpaperUsage({
    ...options,
    retryMs: 100000,
    report: async () => {
      throw Error('offline clear')
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  stop()
  await new Promise((resolve) => setTimeout(resolve, 20))
  stop = startWallpaperUsage(options)
  await until(() => reports.length > previousReports)
  assert.equal(reports.at(-1)!.wallpaperId, null, 'offline clear is reconciled after app restart')
  stop()
  await new Promise((resolve) => setTimeout(resolve, 20))
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
