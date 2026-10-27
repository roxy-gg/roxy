import assert from 'node:assert/strict'
import sharp from 'sharp'
import { composeNarrete } from '../src/main/services/narrete-image'
import { MAX_IMAGE_BYTES } from '../src/shared/attachments'

async function main(): Promise<void> {
  const red =
    'data:image/png;base64,' +
    (
      await sharp({ create: { width: 400, height: 200, channels: 3, background: '#ff0000' } })
        .png()
        .toBuffer()
    ).toString('base64')
  const blue =
    'data:image/png;base64,' +
    (
      await sharp({ create: { width: 200, height: 400, channels: 3, background: '#0000ff' } })
        .png()
        .toBuffer()
    ).toString('base64')
  await assert.rejects(composeNarrete([]))
  await assert.rejects(composeNarrete([{ dataUrl: red, note: 'Cancelled' }], () => true))
  await assert.rejects(composeNarrete([{ dataUrl: red, note: 'x'.repeat(801) }]))
  const result = await composeNarrete([
    { dataUrl: red, note: '<b>literal</b> & "text"' },
    { dataUrl: blue, note: 'Second screenshot' }
  ])
  const bytes = Buffer.from(result.dataUrl.split(',')[1], 'base64')
  const metadata = await sharp(bytes).metadata()
  assert.equal(metadata.width, 1992)
  assert(bytes.length <= MAX_IMAGE_BYTES)
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  const pixel = (x: number, y: number): number[] => [
    ...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)
  ]
  assert.deepEqual(pixel(60, 60), [255, 0, 0], 'First crop retains its pixels')
  assert.deepEqual(pixel(1044, 60), [0, 0, 255], 'Second crop retains its pixels in sequence')
  let dark = 0
  for (let y = 272; y < metadata.height! - 24; y++) {
    for (let x = 48; x < 960; x++) {
      const rgb = pixel(x, y)
      if (rgb.every((channel) => channel < 80)) dark++
    }
  }
  assert(dark > 300, 'Number and feedback are visibly rendered below the screenshot')
  for (const note of [
    '\u4e2d'.repeat(800),
    'W'.repeat(800),
    'line\n'.repeat(160),
    '??'.repeat(400),
    'a'.repeat(799) + '\u0001'
  ]) {
    const six = await composeNarrete(
      Array.from({ length: 6 }, (_, index) => ({ dataUrl: index % 2 ? blue : red, note }))
    )
    const bytes = Buffer.from(six.dataUrl.split(',')[1], 'base64')
    const meta = await sharp(bytes).metadata()
    assert(meta.height! <= 4096 && meta.width! * meta.height! <= 8_000_000)
    assert(bytes.length <= MAX_IMAGE_BYTES)
  }
  const landscape =
    'data:image/png;base64,' +
    (
      await sharp({ create: { width: 1536, height: 864, channels: 3, background: '#ffeecc' } })
        .png()
        .toBuffer()
    ).toString('base64')
  for (const count of [5, 6, 7, 12, 25]) {
    const maximum = await composeNarrete(
      Array.from({ length: count }, () => ({ dataUrl: landscape, note: '\u4e2d'.repeat(800) }))
    )
    const bytes = Buffer.from(maximum.dataUrl.split(',')[1], 'base64')
    const metadata = await sharp(bytes).metadata()
    assert(metadata.width! * metadata.height! <= 8_000_000 && metadata.height! <= 4096)
  }
  console.log(
    'NARRETE IMAGE OK: ordered contact sheet, screenshot colors, visible feedback, literal markup, up to 25 maximal notes, adaptive layout and bounded pixels/bytes'
  )
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
