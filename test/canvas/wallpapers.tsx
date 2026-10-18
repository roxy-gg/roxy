import './bridge'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist/index.css'
import '../../src/renderer/src/assets/main.css'
import '../../src/renderer/src/i18n'
import { WallpaperWorkshop } from '../../src/renderer/src/components/WallpaperWorkshop'
import { applyMotion } from '../../src/renderer/src/lib/motion'
import type { Wallpaper } from '../../src/shared/wallpapers'

const canvas = document.createElement('canvas')
canvas.width = 640
canvas.height = 360
const ctx = canvas.getContext('2d')!
const gradient = ctx.createLinearGradient(0, 0, 640, 360)
gradient.addColorStop(0, '#183144')
gradient.addColorStop(1, '#689a8b')
ctx.fillStyle = gradient
ctx.fillRect(0, 0, 640, 360)
const image = canvas.toDataURL()
const item: Wallpaper = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Aurora Hills',
  description: 'A quiet original horizon.',
  tags: 'nature, minimal',
  credit: 'Roxy',
  license: 'Original / MIT',
  kind: 'image',
  width: 1600,
  height: 900,
  duration: 0,
  bytes: 1024,
  sha256: 'a'.repeat(64),
  featured: true,
  activeUses: 7,
  approvedAt: '2026-10-18T00:00:00.000Z',
  posterUrl: image,
  mediaUrl: image
}
const state = {
  searches: [] as string[],
  queries: [] as unknown[],
  thumbnails: [] as string[],
  applied: [] as string[],
  submissions: [] as unknown[],
  fail: false
}
;(window as any).__wallpapers = state
let change: (image: string) => void = () => {}
window.roxy.background = {
  get: async () => ({
    image: null,
    settings: {
      effect: 'none',
      showOn: 'all',
      emptyOpacity: 30,
      sessionOpacity: 15,
      glass: true,
      sidebarStyle: 'default',
      sidebarOpacity: 66
    }
  })
} as typeof window.roxy.background
window.roxy.background.search = async (input) => {
  state.searches.push(input.q || '')
  state.queries.push(input)
  await new Promise((resolve) => setTimeout(resolve, input.q === 'slow' ? 700 : 20))
  if (state.fail) return { ok: false, error: 'unavailable' }
  return {
    ok: true,
    value: {
      entries: Array.from({ length: 10 }, (_, index) => ({
        ...item,
        id: `00000000-0000-4000-8000-${String(index + Number(input.cursor || 0) + 1).padStart(12, '0')}`,
        title: index === 0 ? input.q || item.title : `Silent Drift ${index}`,
        kind: index % 2 === 0 ? 'image' : 'video',
        mediaUrl: 'https://do-not-load.test/full.mp4'
      })),
      nextCursor: input.cursor ? null : '10'
    }
  }
}
window.roxy.background.thumbnail = async (id) => {
  state.thumbnails.push(id)
  return { ok: true, value: image }
}
window.roxy.background.applyCatalog = async (id) => {
  state.applied.push(id)
  change(image)
  return { ok: true, value: { ok: true, state: await window.roxy.background.get() } }
}
window.roxy.background.submit = async (input) => {
  state.submissions.push(input)
  return { ok: true, value: { id: item.id } }
}
function Harness() {
  const [background, setBackground] = useState<string | null>(null)
  const [active, setActive] = useState(true)
  change = setBackground
  return (
    <main className="@container mx-auto max-w-4xl p-4 text-text">
      <h1 className="text-lg font-medium">Background Settings</h1>
      <div className="mt-3 flex gap-3">
        <button id="active" onClick={() => setActive(!active)}>
          Toggle active
        </button>
        <button id="local" onClick={() => setBackground(image)}>
          Choose local
        </button>
        <button id="replace" onClick={() => setBackground(image + '#changed')}>
          Replace local
        </button>
        <button id="reduce" onClick={() => applyMotion('reduced')}>
          Reduce motion
        </button>
      </div>
      <WallpaperWorkshop image={background} disabled={false} active={active} />
      <div id="actions" className="flex flex-wrap gap-2">
        <button>Reset effects</button>
        <WallpaperWorkshop image={background} disabled={false} active={active} mode="submit" />
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
