import { normalizeMotion, type MotionPreference } from '../../src/shared/motion'

declare global {
  interface Window {
    __canvasTest: {
      opened: string[]
      copied: string[]
      cancelled: string[]
      logoDecodes: number
      logoPaints: number
      botPaints: number
      logoFallbacks: number
      releaseLogo: () => void
      motionSaveFails: boolean
    }
  }
}

// Test-only bridge: no external browser launches or system clipboard writes.
let releaseLogo = (): void => {}
const logoReady = new Promise<void>((resolve) => {
  releaseLogo = resolve
})
if (!new URLSearchParams(location.search).has('holdLogo')) releaseLogo()
window.__canvasTest = {
  opened: [],
  copied: [],
  cancelled: [],
  logoDecodes: 0,
  logoPaints: 0,
  botPaints: 0,
  logoFallbacks: 0,
  releaseLogo,
  motionSaveFails: false
}
const motionListeners = new Set<(motion: MotionPreference) => void>()

// Delay decode independently of the load event to exercise message churn and cached-image remounts.
const decode = HTMLImageElement.prototype.decode
HTMLImageElement.prototype.decode = async function () {
  if (this.src.includes('/roxy.png')) {
    window.__canvasTest.logoDecodes++
    await logoReady
  }
  await decode.call(this)
}
const drawImage = CanvasRenderingContext2D.prototype.drawImage
CanvasRenderingContext2D.prototype.drawImage = function (
  image: CanvasImageSource,
  ...args: number[]
) {
  if (
    image instanceof HTMLImageElement &&
    image.src.includes('/roxy.png') &&
    this.canvas.closest('[data-canvas-surface]')
  )
    window.__canvasTest.logoPaints++
  if (
    image instanceof HTMLImageElement &&
    image.src.startsWith('data:image/svg+xml,') &&
    this.canvas.closest('[data-canvas-surface]')
  )
    window.__canvasTest.botPaints++
  Reflect.apply(drawImage, this, [image, ...args])
}
const fillText = CanvasRenderingContext2D.prototype.fillText
CanvasRenderingContext2D.prototype.fillText = function (text: string, ...args: number[]) {
  if (text === 'R' && this.canvas.closest('[data-canvas-surface]'))
    window.__canvasTest.logoFallbacks++
  Reflect.apply(fillText, this, [text, ...args])
}
window.roxy = {
  settings: {
    getAll: async () => ({ motion: normalizeMotion(localStorage.getItem('roxy.test.motion')) }),
    setMotion: async (value: MotionPreference) => {
      if (window.__canvasTest.motionSaveFails) throw new Error('Test motion write failure')
      const motion = normalizeMotion(value)
      localStorage.setItem('roxy.test.motion', motion)
      for (const listener of motionListeners) listener(motion)
      return { motion }
    },
    onMotionChanged: (listener: (motion: MotionPreference) => void) => {
      motionListeners.add(listener)
      return () => motionListeners.delete(listener)
    }
  },
  system: {
    openExternal: async (url: string) => {
      window.__canvasTest.opened.push(url)
    }
  },
  clipboard: { hasContent: async () => false, exec: async () => {} }
} as unknown as typeof window.roxy
Object.defineProperty(navigator.clipboard, 'writeText', {
  value: async (text: string) => {
    window.__canvasTest.copied.push(text)
  },
  configurable: true
})
export {}
