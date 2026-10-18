import { createHash } from 'node:crypto'
import type {
  Wallpaper,
  WallpaperPage,
  WallpaperQuery,
  WallpaperSubmitRequest,
  WallpaperResult,
  WallpaperError
} from '../../shared/wallpapers'

const MAX_BYTES = 25 * 1024 * 1024
export const validWallpaperId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
class WallpaperFailure extends Error {
  constructor(readonly code: WallpaperError) {
    super(code)
  }
}

export class WallpaperClient {
  private readonly base: URL
  constructor(
    base = process.env.ROXY_CATALOG_BASE || 'https://roxy.gg',
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.base = new URL(base)
    if (
      (this.base.protocol !== 'https:' &&
        !(
          this.base.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname)
        )) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== '/'
    )
      throw Error('Invalid wallpaper catalog URL')
  }

  async result<T>(operation: () => Promise<T>): Promise<WallpaperResult<T>> {
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      return { ok: false, error: error instanceof WallpaperFailure ? error.code : 'unavailable' }
    }
  }

  private async request(
    route: string,
    max: number,
    init?: RequestInit
  ): Promise<{ bytes: Buffer; type: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init ? 180_000 : 30_000)
    try {
      const response = await this.fetchImpl(new URL(route, this.base), {
        ...init,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit'
      })
      if (!response.ok)
        throw new WallpaperFailure(
          response.status === 429
            ? 'rateLimited'
            : [400, 413, 415, 422].includes(response.status)
              ? 'unsupported'
              : 'unavailable'
        )
      if (!response.body || Number(response.headers.get('content-length') || 0) > max)
        throw Error('Invalid response')
      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let length = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          length += part.value.byteLength
          if (length > max) throw Error('Response too large')
          chunks.push(Buffer.from(part.value))
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      return {
        bytes: Buffer.concat(chunks),
        type: response.headers.get('content-type')?.split(';')[0] || ''
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async json(route: string, init?: RequestInit): Promise<any> {
    const response = await this.request(route, 512 * 1024, init)
    if (response.type !== 'application/json') throw Error('Invalid response')
    return JSON.parse(response.bytes.toString('utf8'))
  }

  private wallpaper(raw: any): Wallpaper {
    if (
      !raw ||
      !validWallpaperId(raw.id) ||
      !['image', 'video'].includes(raw.kind) ||
      !/^[a-f0-9]{64}$/.test(raw.sha256) ||
      typeof raw.featured !== 'boolean'
    )
      throw Error('Invalid wallpaper')
    for (const [key, max] of [
      ['title', 100],
      ['description', 500],
      ['tags', 200],
      ['credit', 100],
      ['license', 500]
    ] as const)
      if (typeof raw[key] !== 'string' || raw[key].length > max) throw Error('Invalid wallpaper')
    for (const key of ['width', 'height', 'bytes'] as const)
      if (
        !Number.isSafeInteger(raw[key]) ||
        raw[key] <= 0 ||
        raw[key] > (key === 'bytes' ? MAX_BYTES : 2048)
      )
        throw Error('Invalid wallpaper')
    if (!Number.isFinite(raw.duration) || raw.duration < 0 || raw.duration > 60)
      throw Error('Invalid wallpaper')
    return {
      id: raw.id,
      title: raw.title,
      description: raw.description,
      tags: raw.tags,
      credit: raw.credit,
      license: raw.license,
      kind: raw.kind,
      width: raw.width,
      height: raw.height,
      bytes: raw.bytes,
      duration: raw.duration,
      sha256: raw.sha256,
      featured: raw.featured,
      posterUrl: new URL(`/api/wallpapers/${raw.id}/poster`, this.base).href,
      mediaUrl: new URL(`/api/wallpapers/${raw.id}/media`, this.base).href
    }
  }

  async search(input: WallpaperQuery): Promise<WallpaperPage> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new WallpaperFailure('invalid')
    const { q = '', kind = 'all', sort = 'featured', cursor = '0' } = input
    if (
      typeof q !== 'string' ||
      q.length > 120 ||
      /[\x00-\x1f]/.test(q) ||
      !['all', 'image', 'video'].includes(kind) ||
      !['featured', 'newest'].includes(sort) ||
      typeof cursor !== 'string' ||
      !/^\d{1,6}$/.test(cursor)
    )
      throw new WallpaperFailure('invalid')
    const raw = await this.json(`/api/wallpapers?${new URLSearchParams({ q, kind, sort, cursor })}`)
    if (
      !Array.isArray(raw.entries) ||
      raw.entries.length > 24 ||
      (raw.nextCursor !== null &&
        (typeof raw.nextCursor !== 'string' || !/^\d{1,6}$/.test(raw.nextCursor)))
    )
      throw Error('Invalid page')
    return {
      entries: raw.entries.map((item: unknown) => this.wallpaper(item)),
      nextCursor: raw.nextCursor
    }
  }

  async download(id: string) {
    if (!validWallpaperId(id)) throw new WallpaperFailure('invalid')
    const wallpaper = this.wallpaper(await this.json(`/api/wallpapers/${id}`))
    if (wallpaper.id !== id) throw Error('Mismatched wallpaper')
    const media = await this.request(`/api/wallpapers/${id}/media`, MAX_BYTES)
    if (
      media.type !== (wallpaper.kind === 'video' ? 'video/mp4' : 'image/png') ||
      media.bytes.length !== wallpaper.bytes ||
      createHash('sha256').update(media.bytes).digest('hex') !== wallpaper.sha256
    )
      throw Error('Invalid wallpaper media')
    return { bytes: media.bytes, extension: wallpaper.kind === 'video' ? '.mp4' : '.png' }
  }

  async submit(input: WallpaperSubmitRequest, image: string | null): Promise<{ id: string }> {
    if (!input || input.rightsConsent !== true) throw new WallpaperFailure('invalid')
    const metadata: Record<string, string | boolean> = { rightsConsent: true }
    for (const [key, max] of [
      ['title', 100],
      ['description', 500],
      ['tags', 200],
      ['credit', 100],
      ['license', 500]
    ] as const) {
      if (
        typeof input[key] !== 'string' ||
        input[key].length > max ||
        /[\x00-\x1f\x7f]/.test(input[key]) ||
        (['title', 'license'].includes(key) && !input[key].trim())
      )
        throw new WallpaperFailure('invalid')
      metadata[key] = input[key].trim()
    }
    if (!image) throw new WallpaperFailure('noBackground')
    if (
      typeof input.expectedImageHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.expectedImageHash) ||
      createHash('sha256').update(image).digest('hex') !== input.expectedImageHash
    )
      throw new WallpaperFailure('changed')
    const match = /^data:(image\/(?:png|gif)|video\/mp4);base64,([A-Za-z0-9+/=]+)$/.exec(image)
    if (!match || image.length > Math.ceil(MAX_BYTES / 3) * 4 + 32)
      throw new WallpaperFailure('unsupported')
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.length > MAX_BYTES) throw new WallpaperFailure('unsupported')
    const header = Buffer.from(JSON.stringify(metadata)).toString('base64url')
    if (header.length > 4096) throw new WallpaperFailure('invalid')
    const raw = await this.json('/api/wallpaper-submissions', {
      method: 'POST',
      headers: { 'Content-Type': match[1], 'X-Wallpaper-Metadata': header },
      body: new Uint8Array(bytes)
    })
    if (!validWallpaperId(raw.id) || raw.status !== 'pending')
      throw Error('Invalid submission response')
    return { id: raw.id }
  }
}
