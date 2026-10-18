export interface Wallpaper {
  id: string
  title: string
  description: string
  tags: string
  credit: string
  license: string
  kind: 'image' | 'video'
  width: number
  height: number
  bytes: number
  duration: number
  sha256: string
  featured: boolean
  activeUses: number
  approvedAt: string | null
  posterUrl: string
  mediaUrl: string
}
export interface WallpaperQuery {
  q?: string
  kind?: 'all' | 'image' | 'video'
  sort?: 'mostUsed' | 'recentApproved'
  cursor?: string
  limit?: number
}
export interface WallpaperPage {
  entries: Wallpaper[]
  nextCursor: string | null
}
export interface WallpaperSubmission {
  title: string
  description: string
  tags: string
  credit: string
  license: string
  rightsConsent: boolean
}
export interface WallpaperSubmitRequest extends WallpaperSubmission {
  expectedImageHash: string
}
export type WallpaperError =
  | 'unavailable'
  | 'invalid'
  | 'rateLimited'
  | 'unsupported'
  | 'noBackground'
  | 'changed'
export type WallpaperResult<T> = { ok: true; value: T } | { ok: false; error: WallpaperError }
