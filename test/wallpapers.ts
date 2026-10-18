import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { WallpaperClient } from '../src/main/services/wallpapers'
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
assert.equal(result.entries[0].posterUrl, `https://roxy.gg/api/wallpapers/${id}/poster`)
assert.equal(result.entries[0].mediaUrl, `https://roxy.gg/api/wallpapers/${id}/media`)
assert.deepEqual(await client.download(id), { bytes, extension: '.png' })
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
console.log(
  'PASS wallpaper client: URL boundaries, bounded responses, integrity, anonymous consented submission and errors'
)
