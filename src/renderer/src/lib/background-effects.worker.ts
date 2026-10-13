import { ditherPixels, type BackgroundEffect } from '@shared/background'

// Chromium supports ImageDecoder in workers; TypeScript does not declare it yet.
declare const ImageDecoder: {
  new (options: { data: ArrayBuffer; type: string }): {
    tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } }
    decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>
    close(): void
  }
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(data.length + 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, data.length)
  bytes.set(
    Array.from(type, (c) => c.charCodeAt(0)),
    4
  )
  bytes.set(data, 8)
  let crc = 0xffffffff
  for (const byte of bytes.subarray(4, bytes.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0)
  return bytes
}

/** Prepare artwork once off-thread, then let Chromium play the encoded animation. */
self.onmessage = async (
  event: MessageEvent<{ image: string; effect: BackgroundEffect }>
): Promise<void> => {
  let bitmap: ImageBitmap | undefined
  let decoder: InstanceType<typeof ImageDecoder> | undefined
  let frame: VideoFrame | undefined
  try {
    const bytes = await (await fetch(event.data.image)).arrayBuffer()
    let count = 1
    if (event.data.image.startsWith('data:image/gif;')) {
      if (bytes.byteLength < 10 || bytes.byteLength > 25 * 1024 * 1024) {
        throw new Error('Invalid GIF size')
      }
      const gifHeader = new DataView(bytes)
      const pixels = gifHeader.getUint16(6, true) * gifHeader.getUint16(8, true)
      if (!pixels || pixels > 40_000_000) throw new Error('GIF dimensions exceed wallpaper bounds')
      decoder = new ImageDecoder({ data: bytes, type: 'image/gif' })
      await decoder.tracks.ready
      count = decoder.tracks.selectedTrack.frameCount
      if (!count || count > 80 || pixels * count > 40_000_000) {
        throw new Error('Animation exceeds wallpaper bounds')
      }
      frame = (await decoder.decode({ frameIndex: 0 })).image
    } else bitmap = await createImageBitmap(new Blob([bytes]))
    const sourceWidth = frame?.displayWidth ?? bitmap!.width
    const sourceHeight = frame?.displayHeight ?? bitmap!.height
    const scale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    const { effect } = event.data
    const parts: Uint8Array<ArrayBuffer>[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]
    let outputBytes = 8
    const append = (type: string, data: Uint8Array): void => {
      outputBytes += data.length + 12
      if (outputBytes > 25 * 1024 * 1024)
        throw new Error('Animation output exceeds wallpaper bounds')
      parts.push(chunk(type, data))
    }
    let sequence = 0
    let header: Uint8Array | undefined
    for (let index = 0; index < count; index++) {
      if (decoder && index > 0) frame = (await decoder.decode({ frameIndex: index })).image
      const source = frame ?? bitmap!
      ctx.globalCompositeOperation = 'source-over'
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(source, 0, 0, width, height)
      if (effect === 'dither') {
        const pixels = ctx.getImageData(0, 0, width, height)
        ditherPixels(pixels.data, width)
        ctx.putImageData(pixels, 0, 0)
      } else if (effect === 'scanlines') {
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
        sampleCtx.drawImage(source, 0, 0, cols, rows)
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
      const png = await canvas.convertToBlob({ type: 'image/png' })
      if (count === 1) {
        self.postMessage({ blob: png })
        return
      }
      // Full, composited GIF frames become APNG frames, preserving alpha and timing.
      const encoded = new Uint8Array(await png.arrayBuffer())
      const view = new DataView(encoded.buffer)
      const frameHeader = encoded.slice(16, 29)
      if (!header) {
        header = frameHeader
        append('IHDR', header)
        const animation = new Uint8Array(8)
        new DataView(animation.buffer).setUint32(0, count)
        append('acTL', animation) // Zero plays means loop forever.
      } else if (header.some((value, i) => frameHeader[i] !== value)) {
        throw new Error('Inconsistent frame encoding')
      }
      const control = new Uint8Array(26)
      const controlView = new DataView(control.buffer)
      controlView.setUint32(0, sequence++)
      controlView.setUint32(4, width)
      controlView.setUint32(8, height)
      controlView.setUint16(
        20,
        Math.min(65535, Math.max(1, Math.round((frame?.duration ?? 100000) / 10000)))
      )
      controlView.setUint16(22, 100)
      append('fcTL', control)
      for (let offset = 8; offset < encoded.length; ) {
        const length = view.getUint32(offset)
        if (String.fromCharCode(...encoded.subarray(offset + 4, offset + 8)) === 'IDAT') {
          const data = encoded.slice(offset + 8, offset + 8 + length)
          if (index === 0) append('IDAT', data)
          else {
            const frameData = new Uint8Array(length + 4)
            new DataView(frameData.buffer).setUint32(0, sequence++)
            frameData.set(data, 4)
            append('fdAT', frameData)
          }
        }
        offset += length + 12
      }
      frame?.close()
      frame = undefined
    }
    append('IEND', new Uint8Array())
    self.postMessage({ blob: new Blob(parts, { type: 'image/png' }) })
  } catch {
    self.postMessage({ error: true })
  } finally {
    frame?.close()
    decoder?.close()
    bitmap?.close()
  }
}
