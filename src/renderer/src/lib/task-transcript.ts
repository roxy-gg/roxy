import type { Message, MessagePart } from '@shared/types'
import type { TaskUpdate } from '@shared/api'

const projectedParts = new WeakMap<MessagePart[], MessagePart[]>()

/** Display detached progress/results on their launch cards, without rewriting model history. */
export function taskTranscript(
  messages: Message[],
  streaming: MessagePart[] | null,
  previews: Record<string, MessagePart[]>,
  tasks: readonly TaskUpdate[] = []
): { messages: Message[]; streaming: MessagePart[] | null } {
  type Tool = Extract<MessagePart, { type: 'tool' }>
  const launches = new Map<string, string>()
  const results = new Map<string, Tool>()
  for (const parts of [...messages.map((message) => message.parts), streaming ?? []]) {
    for (const part of parts) {
      if (part.type !== 'tool' || part.tool !== 'task' || !part.subChatId) continue
      if (part.resultFor) results.set(part.subChatId, part)
      else if (part.callId) launches.set(part.subChatId, part.callId)
    }
  }
  const project = (parts: MessagePart[], chatId?: string): MessagePart[] => {
    let changed = false
    const next: MessagePart[] = []
    const previous = projectedParts.get(parts)
    for (const part of parts) {
      if (part.type !== 'tool' || part.tool !== 'task' || !part.subChatId) {
        next.push(part)
        continue
      }
      if (part.resultFor && launches.get(part.subChatId) === part.resultFor) {
        changed = true
        continue
      }
      const result = results.get(part.subChatId)
      const running = tasks.some(
        (task) =>
          task.state === 'running' &&
          task.subChatId === part.subChatId &&
          (!chatId || task.sessionId === chatId)
      )
      let updated = part
      if (result && result.resultFor === part.callId) {
        updated = {
          ...part,
          state: result.state,
          output: result.output,
          children: result.children
        }
      } else if (!part.resultFor && part.input?.background === true && running) {
        updated = {
          ...part,
          state: 'running',
          children: previews[part.subChatId] ?? part.children
        }
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
    const parts = project(message.parts, message.chatId)
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
