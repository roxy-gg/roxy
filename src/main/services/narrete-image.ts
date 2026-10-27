import sharp from 'sharp'
import type { OutputInfo, OverlayOptions } from 'sharp'
import { NARRETE_NOTE_LIMIT, type NarreteRegion } from '../../shared/narrete'
import type { QueueImage } from '../../shared/types'
import { MAX_IMAGE_BYTES } from '../../shared/attachments'

/** A bounded contact sheet, with each instruction baked into its screenshot card. */
export async function composeNarrete(
  regions: NarreteRegion[],
  cancelled = (): boolean => false
): Promise<QueueImage> {
  if (!regions.length) throw new Error('Invalid brief')
  let width = 960
  let padding = 24
  const columns = regions.length === 1 ? 1 : Math.max(2, Math.ceil(Math.sqrt(regions.length / 2)))
  const cards: {
    source: string
    image: { data?: Buffer; info: { width: number; height: number } }
    text: { data: Buffer; info: OutputInfo }
    height: number
  }[] = []
  for (const [index, region] of regions.entries()) {
    if (cancelled()) throw new Error('Cancelled')
    if (!region.note.trim() || region.note.length > NARRETE_NOTE_LIMIT)
      throw new Error('Invalid note')
    const metadata = await sharp(Buffer.from(region.dataUrl.split(',')[1], 'base64'), {
      limitInputPixels: 4096 * 4096
    }).metadata()
    if (!metadata.width || !metadata.height) throw new Error('Invalid image')
    const imageScale = Math.min(1, (width - padding * 2) / metadata.width, 520 / metadata.height)
    const image = {
      info: {
        width: Math.max(1, Math.round(metadata.width * imageScale)),
        height: Math.max(1, Math.round(metadata.height * imageScale))
      }
    }
    // Pango markup must never interpret feedback as formatting or entities.
    const escaped = region.note
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    const text = await sharp({
      text: {
        text: `<span foreground="#17191e"><b>${String(index + 1).padStart(2, '0')}</b>\n${escaped}</span>`,
        font: 'sans 22',
        width: width - padding * 2,
        wrap: 'word-char',
        spacing: 6,
        rgba: true
      }
    })
      .png()
      .toBuffer({ resolveWithObject: true })
    cards.push({
      source: region.dataUrl,
      image,
      text,
      height: padding * 3 + image.info.height + text.info.height
    })
  }
  const rowCount = Math.ceil(cards.length / columns)
  const naturalWidth = columns * width + (columns + 1) * padding
  const naturalHeight =
    padding +
    Array.from(
      { length: rowCount },
      (_, row) =>
        Math.max(...cards.slice(row * columns, (row + 1) * columns).map((card) => card.height)) +
        padding
    ).reduce((sum, height) => sum + height, 0)
  // Fit the whole sequence, rather than imposing a region-count limit or
  // allocating an unbounded full-size intermediate contact sheet.
  const scale = Math.min(
    1,
    4096 / naturalWidth,
    4096 / naturalHeight,
    Math.sqrt(8_000_000 / (naturalWidth * naturalHeight))
  )
  if (scale < 1) {
    width = Math.max(4, Math.floor(width * scale))
    padding = Math.max(1, Math.floor(padding * scale))
  }
  for (const card of cards) {
    if (cancelled()) throw new Error('Cancelled')
    card.image = await sharp(Buffer.from(card.source.split(',')[1], 'base64'), {
      limitInputPixels: 4096 * 4096
    })
      .resize({
        width: Math.max(1, Math.floor(card.image.info.width * scale)),
        height: Math.max(1, Math.floor(card.image.info.height * scale)),
        fit: 'fill'
      })
      .png()
      .toBuffer({ resolveWithObject: true })
    if (scale < 1) {
      const content = card.text
      card.text = await sharp(content.data)
        .resize({
          width: Math.max(1, Math.floor(content.info.width * scale)),
          height: Math.max(1, Math.floor(content.info.height * scale)),
          fit: 'fill'
        })
        .png()
        .toBuffer({ resolveWithObject: true })
    }
    card.height = padding * 3 + card.image.info.height + card.text.info.height
  }
  const canvasWidth = columns * width + (columns + 1) * padding
  const rows = Array.from({ length: rowCount }, (_, row) =>
    Math.max(...cards.slice(row * columns, (row + 1) * columns).map((card) => card.height))
  )
  const height = padding + rows.reduce((sum, height) => sum + height + padding, 0)
  if (height > 4096 || canvasWidth * height > 8_000_000) throw new Error('Brief too large')
  const layers: OverlayOptions[] = []
  let top = padding
  for (const [row, rowHeight] of rows.entries()) {
    for (let column = 0; column < columns; column++) {
      const card = cards[row * columns + column]
      if (!card) break
      const left = padding + column * (width + padding)
      layers.push({
        input: { create: { width, height: rowHeight, channels: 3, background: '#ffffff' } },
        left,
        top
      })
      layers.push({ input: card.image.data!, left: left + padding, top: top + padding })
      layers.push({
        input: card.text.data,
        left: left + padding,
        top: top + padding * 2 + card.image.info.height
      })
    }
    top += rowHeight + padding
  }
  if (cancelled()) throw new Error('Cancelled')
  const composite = await sharp({
    create: { width: canvasWidth, height, channels: 3, background: '#e9ebef' }
  })
    .composite(layers)
    .png()
    .toBuffer()
  if (composite.length <= MAX_IMAGE_BYTES)
    return {
      dataUrl: 'data:image/png;base64,' + composite.toString('base64'),
      mediaType: 'image/png',
      name: 'Narrete.png'
    }
  for (const quality of [92, 82, 72]) {
    const jpeg = await sharp(composite).jpeg({ quality }).toBuffer()
    if (jpeg.length <= MAX_IMAGE_BYTES)
      return {
        dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
        mediaType: 'image/jpeg',
        name: 'Narrete.jpg'
      }
  }
  throw new Error('Brief too large')
}
