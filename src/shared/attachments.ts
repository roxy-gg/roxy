import type { Message, QueueImage } from './types'

// Match the inline image reader's byte limit. Also bound delegated batches.
export const MAX_IMAGE_BYTES = 3_000_000
export const MAX_FORWARDED_IMAGES = 8

/** References are local to a persisted transcript, never filesystem paths. */
export function messageImages(message: Message): (QueueImage & { ref: string })[] {
  return message.parts.flatMap((part, index) =>
    part.type === 'image'
      ? [
          {
            dataUrl: part.dataUrl,
            mediaType: part.mediaType,
            name: part.name,
            ...(part.forwarded ? { forwarded: true } : {}),
            ref: `image:${message.id}:${index}`
          }
        ]
      : []
  )
}

export function redactImageData(text: string): string {
  return text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[image data omitted]')
}

export function imageReferenceText(message: Message): string {
  const images = messageImages(message)
  return images.length
    ? `\n\nAttached image refs (for image_refs when delegating from this chat):\n${images
        .map(({ ref, name, mediaType }) => JSON.stringify({ ref, name, mediaType }))
        .join('\n')}`
    : ''
}
