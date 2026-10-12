import { ditherPixels, type BackgroundEffect } from '@shared/background'

/** Static artwork only: no work on the chat's scroll/streaming render path. */
self.onmessage = async (
  event: MessageEvent<{ image: string; effect: BackgroundEffect }>
): Promise<void> => {
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(await (await fetch(event.data.image)).blob())
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, width, height)
    const { effect } = event.data
    if (effect === 'dither') {
      const pixels = ctx.getImageData(0, 0, width, height)
      ditherPixels(pixels.data, width)
      ctx.putImageData(pixels, 0, 0)
    } else if (effect === 'scanlines') {
      // Transparent lines let the selected theme supply the paper color.
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = 'rgba(0,0,0,0.48)'
      for (let y = 0; y < height; y += 3) ctx.fillRect(0, y, width, 1)
    } else if (effect === 'ascii' || effect === 'halftone') {
      const cellW = effect === 'ascii' ? 7 : 5
      const cellH = effect === 'ascii' ? 10 : 5
      const cols = Math.ceil(width / cellW)
      const rows = Math.ceil(height / cellH)
      const sample = new OffscreenCanvas(cols, rows)
      const sampleCtx = sample.getContext('2d')!
      sampleCtx.drawImage(bitmap, 0, 0, cols, rows)
      const data = sampleCtx.getImageData(0, 0, cols, rows).data
      ctx.clearRect(0, 0, width, height)
      ctx.font = '10px monospace'
      ctx.textBaseline = 'top'
      const glyphs = ' .:-=+*#%@'
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const i = (y * cols + x) * 4
          const [r, g, b, a] = data.subarray(i, i + 4)
          const brightness = Math.sqrt((r * 0.2126 + g * 0.7152 + b * 0.0722) / 255)
          ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`
          if (effect === 'ascii') {
            ctx.fillText(glyphs[Math.min(9, Math.floor(brightness * 10))], x * cellW, y * cellH)
          } else {
            ctx.beginPath()
            ctx.arc(
              x * cellW + cellW / 2,
              y * cellH + cellH / 2,
              0.6 + brightness * 1.8,
              0,
              Math.PI * 2
            )
            ctx.fill()
          }
        }
    }
    self.postMessage({ blob: await canvas.convertToBlob({ type: 'image/png' }) })
  } catch {
    self.postMessage({ error: true })
  } finally {
    bitmap?.close()
  }
}
