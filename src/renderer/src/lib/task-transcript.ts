import type { Message, MessagePart } from '@shared/types'
const projectedParts = new WeakMap<MessagePart[], MessagePart[]>()

/** Project live child previews and historical detached results onto their cards. */
export function taskTranscript(
  messages: Message[],
  streaming: MessagePart[] | null,
  previews: Record<string, MessagePart[]>
): { messages: Message[]; streaming: MessagePart[] | null } {
  type Tool = Extract<MessagePart, { type: 'tool' }>
  const launches = new Map<string, string>()
  const results = new Map<string, Tool>()
  for (const parts of [...messages.map((message) => message.parts), streaming ?? []]) {
    const visit = (entries: MessagePart[]): void => {
      for (const part of entries) {
        if (part.type !== 'tool') continue
        if (part.tool === 'task' && part.subChatId) {
          if (part.resultFor) results.set(part.subChatId, part)
          else if (part.callId) launches.set(part.subChatId, part.callId)
        }
        if (part.children) visit(part.children)
      }
    }
    visit(parts)
  }
  const project = (parts: MessagePart[]): MessagePart[] => {
    let changed = false
    const next: MessagePart[] = []
    const previous = projectedParts.get(parts)
    for (const part of parts) {
      if (part.type === 'tool' && part.tool === 'task' && part.children?.length) {
        const children = project(part.children)
        if (children !== part.children) {
          next.push({ ...part, children })
          changed = true
          continue
        }
      }
      if (part.type !== 'tool' || part.tool !== 'task' || !part.subChatId) {
        next.push(part)
        continue
      }
      if (part.resultFor && launches.get(part.subChatId) === part.resultFor) {
        changed = true
        continue
      }
      const result = results.get(part.subChatId)
      let updated = part
      if (result && result.resultFor === part.callId) {
        updated = {
          ...part,
          state: result.state,
          output: result.output,
          children: result.children
        }
      } else if (!part.resultFor && previews[part.subChatId]) {
        updated = { ...part, children: previews[part.subChatId] }
      }
      if (updated !== part) {
        changed = true
        const cached = previous?.[next.length]
        if (
          cached?.type === 'tool' &&
          cached.callId === updated.callId &&
          cached.state === updated.state &&
          cached.output === updated.output &&
          cached.children === updated.children
        )
          updated = cached
      }
      next.push(updated)
    }
    if (!changed) return parts
    if (previous?.length === next.length && next.every((part, i) => part === previous[i]))
      return previous
    projectedParts.set(parts, next)
    return next
  }
  let changed = false
  const visible: Message[] = []
  for (const message of messages) {
    const parts = project(message.parts)
    if (parts === message.parts) visible.push(message)
    else {
      changed = true
      if (parts.length) visible.push({ ...message, parts })
    }
  }
  return {
    messages: changed ? visible : messages,
    streaming: streaming === null ? null : project(streaming)
  }
}
