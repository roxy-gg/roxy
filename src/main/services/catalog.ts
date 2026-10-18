import type {
  CatalogEntry,
  CatalogKind,
  CatalogMcpDetail,
  CatalogMcpSetup,
  CatalogSearchResult,
  CatalogSkillDetail
} from '../../shared/catalog'
import { randomUUID } from 'node:crypto'
import { catalogMcpId, catalogMcpOptions, resolveCatalogMcpConfig } from '../../shared/catalog-mcp'
import { isSafeSkillFilePath } from '../../shared/portable'
import { sanitizeSkillName, parseSkillFrontmatter } from '../../shared/skills'

const REVIEW_TTL = 10 * 60_000
const MAX_JSON = 2 * 1024 * 1024

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid catalog response.')
  return value as Record<string, any>
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw Error('Invalid catalog response.')
  return value
}

function skillId(value: unknown): string {
  const id = text(value, 302)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}){1,2}$/.test(id))
    throw Error('Invalid catalog skill ID.')
  return id
}

/** Independently validate bundles on the machine that will write them. */
export function prepareCatalogSkill(detail: CatalogSkillDetail): {
  name: string
  files: { path: string; contents: string }[]
} {
  if (!Array.isArray(detail.files) || !detail.files.length || detail.files.length > 128)
    throw Error('This skill has no installable file snapshot.')
  let total = 0
  const paths = new Set<string>()
  const files = detail.files.map((raw) => {
    const file = object(raw)
    const path = text(file.path, 240)
    if (
      !isSafeSkillFilePath(path) ||
      /[:\x00-\x1f\x7f]/.test(path) ||
      path
        .split('/')
        .some(
          (p) => /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
        ) ||
      paths.has(path.toLowerCase())
    )
      throw Error('The skill snapshot contains an unsafe or duplicate file path.')
    paths.add(path.toLowerCase())
    const contents = text(file.contents, 512 * 1024)
    const bytes = Buffer.byteLength(contents)
    total += bytes
    if (bytes > 512 * 1024 || total > 1024 * 1024) throw Error('The skill snapshot is too large.')
    return { path, contents }
  })
  // A file cannot also be the parent of another file, on any supported OS.
  for (const path of paths) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) {
      if (paths.has(segments.slice(0, i).join('/')))
        throw Error('The skill snapshot has conflicting paths.')
    }
  }
  const markdown = files.find((f) => f.path === 'SKILL.md')
  if (!markdown) throw Error('The skill snapshot needs a root SKILL.md file.')
  const { data } = parseSkillFrontmatter(markdown.contents)
  const name = data.name?.trim() || detail.entry.id.split('/').at(-1)!
  const directory = sanitizeSkillName(name)
  if (
    !directory ||
    name.length > 256 ||
    /[\x00-\x1f\x7f]/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(directory)
  )
    throw Error('The skill snapshot has an invalid name.')
  return { name, files }
}

function entry(raw: unknown, kind: CatalogKind): CatalogEntry {
  const item = object(raw)
  const id = kind === 'skills' ? skillId(item.id) : catalogMcpId(item.id)
  if (item.kind !== kind) throw Error('Invalid catalog response.')
  let url: string | null = null
  if (item.url !== null) {
    const parsed = new URL(text(item.url, 2048))
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.href
  }
  return {
    id,
    kind,
    name: text(item.name, 256),
    description: text(item.description, 4096),
    source: text(item.source, 256),
    url,
    iconUrl: typeof item.iconUrl === 'string' ? text(item.iconUrl, 2048) : null,
    installs:
      kind === 'skills' && Number.isSafeInteger(item.installs) && item.installs >= 0
        ? item.installs
        : null,
    version: typeof item.version === 'string' ? text(item.version, 255) : null
  }
}

/** One client per settings window: reviews cannot be replaced by another window. */
export class CatalogClient {
  private readonly base: URL
  private readonly reviews = new Map<
    string,
    { key: string; expires: number; value: CatalogSkillDetail | CatalogMcpDetail }
  >()

  constructor(
    base = process.env.ROXY_CATALOG_BASE || 'https://roxy.gg',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
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
      throw Error('Invalid catalog relay URL.')
  }

  private async bytes(path: string, max: number): Promise<{ bytes: Buffer; type: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await this.fetchImpl(new URL(path, this.base), {
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'application/json, image/png, image/jpeg, image/webp' }
      })
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get('content-length') ?? 0) > max
      )
        throw Error()
      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > max) throw Error()
          chunks.push(Buffer.from(part.value))
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      return {
        bytes: Buffer.concat(chunks),
        type: response.headers.get('content-type')?.split(';')[0] ?? ''
      }
    } catch {
      throw Error('The catalog is unavailable. Check your connection and try again.')
    } finally {
      clearTimeout(timer)
    }
  }

  private async json(path: string): Promise<Record<string, any>> {
    const result = await this.bytes(path, MAX_JSON)
    if (result.type !== 'application/json') throw Error('Invalid catalog response.')
    return object(JSON.parse(result.bytes.toString('utf8')))
  }

  private icon(url: string | null): string | null {
    if (!url) return null
    let parsed: URL
    try {
      parsed = new URL(url, this.base)
    } catch {
      return null
    }
    if (
      parsed.origin !== this.base.origin ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !/^\/api\/catalog\/icons\/[a-f0-9]{64}$/.test(parsed.pathname)
    )
      return null
    // Browser loads this first-party cached raster lazily; cold icon providers
    // must never hold up the search results or review response.
    return parsed.href
  }

  async search(kind: CatalogKind, query: string, cursor?: string): Promise<CatalogSearchResult> {
    if (
      !['skills', 'mcp'].includes(kind) ||
      typeof query !== 'string' ||
      query.length > 120 ||
      /[\x00-\x1f]/.test(query)
    )
      throw Error('Invalid catalog search.')
    const q = query.trim()
    if (q.length === 1) throw Error('Enter at least two characters.')
    const params = new URLSearchParams({ q })
    if (cursor !== undefined) params.set('cursor', text(cursor, 2048))
    const raw = await this.json(`/api/catalog/${kind}/search?${params}`)
    if (
      !Array.isArray(raw.entries) ||
      raw.entries.length > 50 ||
      typeof raw.stale !== 'boolean' ||
      !Number.isFinite(Date.parse(raw.updatedAt))
    )
      throw Error('Invalid catalog response.')
    const entries = raw.entries.map((item: unknown) => entry(item, kind))
    entries.forEach((item) => {
      item.iconUrl = this.icon(item.iconUrl)
    })
    return {
      entries,
      nextCursor: raw.nextCursor === null ? null : text(raw.nextCursor, 2048),
      stale: raw.stale,
      updatedAt: raw.updatedAt
    }
  }

  private remember(
    key: string,
    value: CatalogSkillDetail | CatalogMcpDetail,
    reviewId: string
  ): void {
    if (this.reviews.size >= 20) this.reviews.delete(this.reviews.keys().next().value!)
    this.reviews.set(reviewId, { key, expires: this.now() + REVIEW_TTL, value })
  }

  private reviewed(key: string, reviewId: string): CatalogSkillDetail | CatalogMcpDetail {
    const review = this.reviews.get(reviewId)
    if (!review || review.key !== key || review.expires <= this.now()) {
      this.reviews.delete(reviewId)
      throw Error('This review has expired. Reopen the item before installing.')
    }
    return review.value
  }

  async skillDetail(id: string): Promise<CatalogSkillDetail> {
    skillId(id)
    const raw = await this.json(`/api/catalog/skills/detail?${new URLSearchParams({ id })}`)
    const detail: CatalogSkillDetail = {
      reviewId: randomUUID(),
      entry: entry(raw.entry, 'skills'),
      hash: raw.hash === null ? null : text(raw.hash, 256),
      files: raw.files
    }
    if (detail.entry.id !== id) throw Error('Invalid catalog response.')
    if (detail.files !== null) {
      const bundle = prepareCatalogSkill(detail)
      detail.entry.name = bundle.name
      detail.entry.description =
        parseSkillFrontmatter(bundle.files.find((f) => f.path === 'SKILL.md')!.contents).data
          .description || ''
      detail.files = bundle.files
    }
    detail.entry.iconUrl = this.icon(detail.entry.iconUrl)
    this.remember(`skills:${id}`, structuredClone(detail), detail.reviewId)
    return detail
  }

  skillForInstall(id: string, reviewId: string): ReturnType<typeof prepareCatalogSkill> {
    skillId(id)
    return prepareCatalogSkill(this.reviewed(`skills:${id}`, reviewId) as CatalogSkillDetail)
  }

  async mcpSetup(id: string): Promise<CatalogMcpSetup> {
    catalogMcpId(id)
    const raw = await this.json(`/api/catalog/mcp/detail?${new URLSearchParams({ id })}`)
    const detail: CatalogMcpDetail = {
      entry: entry(raw.entry, 'mcp'),
      server: object(raw.server) as CatalogMcpDetail['server']
    }
    if (detail.entry.id !== id || detail.server.name !== id)
      throw Error('Invalid catalog response.')
    const options = catalogMcpOptions(detail.server)
    detail.entry.iconUrl = this.icon(detail.entry.iconUrl)
    const reviewId = randomUUID()
    this.remember(`mcp:${id}`, structuredClone(detail), reviewId)
    return { reviewId, entry: detail.entry, options }
  }

  mcpForInstall(id: string, reviewId: string, optionId: string, values: Record<string, string>) {
    catalogMcpId(id)
    const detail = this.reviewed(`mcp:${id}`, reviewId) as CatalogMcpDetail
    return resolveCatalogMcpConfig(detail.server, optionId, values)
  }

  forget(reviewId: string): void {
    this.reviews.delete(reviewId)
  }
}
