/** Text safe to speak from a streamed assistant turn; reasoning and tools stay silent. */
export function assistantSpeechText(
  parts: { type: string; text?: string }[] | null | undefined
): string {
  return (parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

/** Split complete sentences from a streaming suffix, retaining the unfinished tail. */
export function takeSpeakableSentences(text: string): { chunks: string[]; rest: string } {
  const chunks: string[] = []
  let consumed = 0
  const pattern = /(.+?[.!?])(?:\s+|$)/gs
  for (const match of text.matchAll(pattern)) {
    const end = (match.index ?? 0) + match[0].length
    const chunk = match[1].trim()
    if (chunk) chunks.push(chunk)
    consumed = end
  }
  return { chunks, rest: text.slice(consumed) }
}
