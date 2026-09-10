import type { Message } from '@shared/types'

export interface PromptEntry {
  id: string
  text: string
  createdAt: number
  images: number
}

export interface PromptAnchor {
  id: string
  y: number
}

export const PROMPT_GUTTER = 32
export const PROMPT_OFFSET = 16

/** Only authored prompts belong in the index, never reasoning, tool output, or agent replies. */
export function promptEntries(messages: Message[]): PromptEntry[] {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => {
      const text = message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()
      return {
        id: message.id,
        text: (text || message.content.trim()).slice(0, 400),
        createdAt: message.createdAt,
        images: message.parts.filter((part) => part.type === 'image').length
      }
    })
}

export function activePrompt(
  anchors: PromptAnchor[],
  scrollTop: number,
  atTail: boolean
): string | null {
  if (!anchors.length) return null
  if (atTail) return anchors[anchors.length - 1].id
  let low = 0
  let high = anchors.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (anchors[mid].y <= scrollTop + PROMPT_OFFSET + 1) low = mid + 1
    else high = mid
  }
  return anchors[Math.max(0, low - 1)].id
}
