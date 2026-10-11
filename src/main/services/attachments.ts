import {
  MAX_FORWARDED_IMAGES,
  MAX_IMAGE_BYTES,
  messageImages,
  redactImageData
} from '../../shared/attachments'
import type { ChatMessage } from '../../shared/api'
import type { QueueImage } from '../../shared/types'
import * as repo from '../db/repo'

/** Resolve only attachments already in the caller's transcript. Copy bytes now:
 * deleting a source chat/worktree later must not break a queued handoff. */
export function resolveImageRefs(
  source: string | undefined,
  refs: unknown
): QueueImage[] | undefined {
  if (refs === undefined) return undefined
  if (
    !Array.isArray(refs) ||
    refs.length > MAX_FORWARDED_IMAGES ||
    refs.some((ref) => typeof ref !== 'string')
  )
    throw new Error(
      `image_refs must be an array of at most ${MAX_FORWARDED_IMAGES} image references.`
    )
  if (!refs.length) return []
  if (!source || !repo.getChat(source))
    throw new Error('Image forwarding requires a source session.')
  const available = new Map(
    repo
      .listMessages(source)
      .flatMap(messageImages)
      .map((image) => [image.ref, image])
  )
  const images = [...new Set(refs)].map((ref) => {
    const image = available.get(ref)
    if (!image)
      throw new Error(
        'An image reference is unavailable in this chat. Read this session for current image refs; no request was queued.'
      )
    return {
      dataUrl: image.dataUrl,
      mediaType: image.mediaType,
      forwarded: true,
      ...(image.name ? { name: image.name } : {})
    }
  })
  validateForwardedImages(images)
  return images
}

export function validateForwardedImages(images: QueueImage[]): void {
  if (images.length > MAX_FORWARDED_IMAGES)
    throw new Error(`At most ${MAX_FORWARDED_IMAGES} images can be forwarded per request.`)
  for (const image of images) {
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType))
      throw new Error('Forwarded images must be PNG, JPEG, GIF, or WebP.')
    const prefix = `data:${image.mediaType};base64,`
    if (typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith(prefix))
      throw new Error('Invalid image data or mismatched MIME type.')
    const encoded = image.dataUrl.slice(prefix.length)
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      throw new Error(`A forwarded image exceeds the ${MAX_IMAGE_BYTES}-byte inline image limit.`)
    if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new Error('Invalid base64 image data.')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Forwarded image is too large.')
    const valid =
      image.mediaType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : image.mediaType === 'image/jpeg'
          ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          : image.mediaType === 'image/gif'
            ? /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))
            : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    if (!valid) throw new Error('Image bytes do not match the declared MIME type.')
  }
}

/** Tool output advertises refs/metadata, not megabytes of private image bytes. */
export function attachmentSafeJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry) => {
      if (typeof entry === 'string') return redactImageData(entry)
      if (!entry || typeof entry !== 'object') return entry
      if (
        Array.isArray(entry.parts) &&
        typeof entry.id === 'string' &&
        typeof entry.chatId === 'string'
      ) {
        return {
          ...entry,
          parts: entry.parts.map((part: { type: string }, index: number) =>
            part.type === 'image' ? { ...part, ref: `image:${entry.id}:${index}` } : part
          )
        }
      }
      if (
        'dataUrl' in entry ||
        (typeof entry.image === 'string' && entry.image.startsWith('data:'))
      ) {
        const { dataUrl: _dataUrl, image: _image, ...metadata } = entry
        return metadata
      }
      return entry
    },
    2
  )
}

/** Retain persisted images, but never claim that omitted model input was seen. */
export function omitMessageImages(message: ChatMessage): ChatMessage {
  if (!message.images?.length) return message
  const { images: _images, ...text } = message
  return {
    ...text,
    content:
      text.content +
      '\n[These historical images are not included in this model request. You have not seen them here; do not infer their contents. Use only the images explicitly attached to the current request.]'
  }
}
