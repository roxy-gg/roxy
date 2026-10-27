import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
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
export class WallpaperFailure extends Error {
  constructor(readonly code: WallpaperError) {
    super(code)
  }
}

export class WallpaperClient {
  private readonly base: URL
  private readonly thumbnails = new Map<string, Promise<string>>()
  private readonly previews = new Map<string, Promise<string | null>>()
  private cacheWork: Promise<unknown> = Promise.resolve()
  private reconciledCache = false
  constructor(
    base = process.env.ROXY_CATALOG_BASE || 'https://roxy.gg',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly cacheDirectory?: () => string
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
    init?: RequestInit,
    allowMissing = false
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
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        if (allowMissing && response.status === 404)
          return { bytes: Buffer.from('null'), type: 'application/json' }
        throw new WallpaperFailure(
          response.status === 429
            ? 'rateLimited'
            : [400, 413, 415, 422].includes(response.status)
              ? 'unsupported'
              : 'unavailable'
        )
      }
      if (!response.body || Number(response.headers.get('content-length') || 0) > max) {
        await response.body?.cancel().catch(() => {})
        throw Error('Invalid response')
      }
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
    const mime =
      raw.mime === undefined ? (raw.kind === 'video' ? 'video/mp4' : 'image/png') : raw.mime
    if (!(raw.kind === 'video' ? ['video/mp4'] : ['image/png', 'image/gif']).includes(mime))
      throw Error('Invalid wallpaper media type')
    const preview = raw.preview ?? null
    if (
      preview &&
      (!['video/mp4', 'image/webp'].includes(preview.mime) ||
        !Number.isSafeInteger(preview.bytes) ||
        preview.bytes <= 0 ||
        preview.bytes > 1024 * 1024 ||
        typeof preview.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(preview.sha256))
    )
      throw Error('Invalid wallpaper preview')
    return {
      id: raw.id,
      title: raw.title,
      description: raw.description,
      tags: raw.tags,
      credit: raw.credit,
      license: raw.license,
      kind: raw.kind,
      mime,
      width: raw.width,
      height: raw.height,
      bytes: raw.bytes,
      duration: raw.duration,
      sha256: raw.sha256,
      featured: raw.featured,
      activeUses: Number.isSafeInteger(raw.activeUses) && raw.activeUses >= 0 ? raw.activeUses : 0,
      approvedAt: typeof raw.approvedAt === 'string' ? raw.approvedAt : null,
      posterUrl: new URL(`/api/wallpapers/${raw.id}/poster`, this.base).href,
      mediaUrl: new URL(`/api/wallpapers/${raw.id}/media`, this.base).href,
      preview
    }
  }

  async search(input: WallpaperQuery): Promise<WallpaperPage> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new WallpaperFailure('invalid')
    const { q = '', kind = 'all', sort = 'mostUsed', cursor = '0', limit = 10 } = input
    if (
      typeof q !== 'string' ||
      q.length > 120 ||
      /[\x00-\x1f]/.test(q) ||
      !['all', 'image', 'video'].includes(kind) ||
      !['mostUsed', 'recentApproved'].includes(sort) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 24 ||
      typeof cursor !== 'string' ||
      !/^\d{1,6}$/.test(cursor)
    )
      throw new WallpaperFailure('invalid')
    const raw = await this.json(
      `/api/wallpapers?${new URLSearchParams({ q, kind, sort, cursor, limit: String(limit) })}`
    )
    if (
      !Array.isArray(raw.entries) ||
      raw.entries.length > limit ||
      (raw.nextCursor !== null &&
        (typeof raw.nextCursor !== 'string' || !/^\d{1,6}$/.test(raw.nextCursor)))
    )
      throw Error('Invalid page')
    return {
      entries: raw.entries.map((item: unknown) => this.wallpaper(item)),
      nextCursor: raw.nextCursor
    }
  }

  thumbnail(id: string, sha256: string): Promise<string> {
    if (!validWallpaperId(id) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
      return Promise.reject(new WallpaperFailure('invalid'))
    const key = createHash('sha256')
      .update(`${this.base.origin}:${id}:${sha256}:thumbnail-v1`)
      .digest('hex')
    const existing = this.thumbnails.get(key)
    if (existing) return existing
    const work = (async () => {
      const directory = this.cacheDirectory?.()
      if (directory && !this.reconciledCache) {
        this.reconciledCache = true
        const prune = this.cacheWork.catch(() => {}).then(() => this.pruneThumbnails(directory))
        this.cacheWork = prune
        await prune.catch(() => {})
      }
      const file = directory ? path.join(directory, `${key}.webp`) : undefined
      const validate = async (bytes: Buffer): Promise<void> => {
        if (!bytes.length || bytes.length > 256 * 1024) throw Error('Invalid thumbnail size')
        const decoder = sharp(bytes, { limitInputPixels: 480 * 270 }).timeout({ seconds: 5 })
        const info = await decoder.metadata()
        if (
          info.format !== 'webp' ||
          (info.pages || 1) !== 1 ||
          !info.width ||
          !info.height ||
          info.width > 480 ||
          info.height > 270
        )
          throw Error('Invalid thumbnail')
        await decoder.raw().toBuffer()
      }
      let bytes: Buffer | undefined
      if (file)
        try {
          if ((await fs.stat(file)).size > 256 * 1024) throw Error('Oversized cache')
          bytes = await fs.readFile(file)
          await validate(bytes)
          await fs.utimes(file, new Date(), new Date()).catch(() => {})
        } catch {
          bytes = undefined
          await fs.rm(file, { force: true }).catch(() => {})
        }
      if (!bytes) {
        const response = await this.request(`/api/wallpapers/${id}/thumbnail`, 256 * 1024)
        if (response.type !== 'image/webp') throw Error('Invalid thumbnail type')
        bytes = response.bytes
        await validate(bytes)
        if (file && directory) {
          const content = bytes
          const save = this.cacheWork
            .catch(() => {})
            .then(async () => {
              await fs.mkdir(directory, { recursive: true })
              const temporary = `${file}.${randomUUID()}.tmp`
              try {
                await fs.writeFile(temporary, content, { mode: 0o600 })
                await fs.rename(temporary, file)
              } finally {
                await fs.rm(temporary, { force: true }).catch(() => {})
              }
              await this.pruneThumbnails(directory)
            })
          this.cacheWork = save
          await save.catch(() => {}) // Cache errors never prevent browsing.
        }
      }
      return `data:image/webp;base64,${bytes.toString('base64')}`
    })()
    this.thumbnails.set(key, work)
    void work.finally(() => this.thumbnails.delete(key)).catch(() => {})
    return work
  }

  private async pruneThumbnails(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true })
    const entries: { name: string; size: number; modified: number }[] = []
    for (const name of await fs.readdir(directory)) {
      if (!/^[a-f0-9]{64}\.webp(?:\.[a-f0-9-]+\.tmp)?$/.test(name)) continue
      try {
        const stat = await fs.stat(path.join(directory, name))
        if (name.endsWith('.tmp')) {
          if (stat.mtimeMs < Date.now() - 3600_000)
            await fs.rm(path.join(directory, name), { force: true })
          continue
        }
        entries.push({ name, size: stat.size, modified: stat.mtimeMs })
      } catch {
        /* Another cache owner may already have removed it. */
      }
    }
    entries.sort((a, b) => b.modified - a.modified)
    let total = 0
    for (let index = 0; index < entries.length; index++) {
      total += entries[index].size
      if (index >= 500 || total > 50 * 1024 * 1024)
        await fs.rm(path.join(directory, entries[index].name), { force: true })
    }
  }

  async usage(deviceId: string, wallpaperId: string | null, sequence: number): Promise<void> {
    if (
      !validWallpaperId(deviceId) ||
      (wallpaperId !== null && !validWallpaperId(wallpaperId)) ||
      !Number.isSafeInteger(sequence)
    )
      throw new WallpaperFailure('invalid')
    const result = await this.json('/api/wallpapers/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, wallpaperId, sequence })
    })
    if (result.ok !== true) throw Error('Invalid usage response')
  }

  preview(id: string): Promise<string | null> {
    if (!validWallpaperId(id)) return Promise.reject(new WallpaperFailure('invalid'))
    const existing = this.previews.get(id)
    if (existing) return existing
    // Bound abandoned selections as well as each response; only a few clicks may fetch at once.
    if (this.previews.size >= 4) return Promise.reject(new WallpaperFailure('unavailable'))
    const work = (async () => {
      const wallpaper = this.wallpaper(await this.json(`/api/wallpapers/${id}`))
      if (wallpaper.id !== id) throw Error('Mismatched wallpaper')
      if (!wallpaper.preview) return null
      const media = await this.request(`/api/wallpapers/${id}/preview`, 1024 * 1024)
      if (
        media.type !== wallpaper.preview.mime ||
        media.bytes.length !== wallpaper.preview.bytes ||
        createHash('sha256').update(media.bytes).digest('hex') !== wallpaper.preview.sha256
      )
        throw Error('Invalid preview media')
      if (media.type === 'image/webp') {
        const decoder = sharp(media.bytes, {
          animated: true,
          limitInputPixels: 480 * 270 * 80
        }).timeout({ seconds: 5 })
        const info = await decoder.metadata()
        if (
          info.format !== 'webp' ||
          !info.width ||
          !info.height ||
          info.width > 480 ||
          (info.pageHeight ?? info.height) > 270 ||
          (info.pages ?? 1) > 80
        )
          throw Error('Invalid animated preview')
        await decoder.raw().toBuffer()
      }
      return `data:${media.type};base64,${media.bytes.toString('base64')}`
    })()
    this.previews.set(id, work)
    void work.finally(() => this.previews.delete(id)).catch(() => {})
    return work
  }

  async download(id: string) {
    if (!validWallpaperId(id)) throw new WallpaperFailure('invalid')
    const wallpaper = this.wallpaper(await this.json(`/api/wallpapers/${id}`))
    if (wallpaper.id !== id) throw Error('Mismatched wallpaper')
    const media = await this.request(`/api/wallpapers/${id}/media`, MAX_BYTES)
    if (
      media.type !== wallpaper.mime ||
      media.bytes.length !== wallpaper.bytes ||
      createHash('sha256').update(media.bytes).digest('hex') !== wallpaper.sha256
    )
      throw Error('Invalid wallpaper media')
    return {
      bytes: media.bytes,
      extension:
        wallpaper.mime === 'video/mp4' ? '.mp4' : wallpaper.mime === 'image/gif' ? '.gif' : '.png'
    }
  }

  async isPublished(id: string): Promise<boolean> {
    if (!validWallpaperId(id)) throw new WallpaperFailure('invalid')
    const response = await this.request(`/api/wallpapers/${id}`, 512 * 1024, undefined, true)
    if (response.type !== 'application/json') throw Error('Invalid response')
    const raw = JSON.parse(response.bytes.toString('utf8'))
    if (raw === null) return false
    const wallpaper = this.wallpaper(raw)
    if (wallpaper.id !== id) throw Error('Mismatched wallpaper')
    return true
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
