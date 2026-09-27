import type { ComposerImage } from './images'

export interface ComposerDraft {
  value: string
  images: ComposerImage[]
}

export type ComposerDrafts = Record<string, ComposerDraft>

type ChatRef = { id: string }

export function updateComposerDraft(
  drafts: ComposerDrafts,
  chats: ChatRef[],
  chatId: string,
  update: (current: ComposerDraft) => ComposerDraft
): ComposerDrafts {
  if (!chats.some((chat) => chat.id === chatId)) return drafts

  const next = update(drafts[chatId] ?? { value: '', images: [] })
  const updated = { ...drafts }
  if (!next.value && next.images.length === 0) delete updated[chatId]
  else updated[chatId] = next
  return updated
}

export function pruneComposerDrafts(drafts: ComposerDrafts, chats: ChatRef[]): ComposerDrafts {
  const liveChatIds = new Set(chats.map((chat) => chat.id))
  const entries = Object.entries(drafts).filter(([chatId]) => liveChatIds.has(chatId))
  return entries.length === Object.keys(drafts).length ? drafts : Object.fromEntries(entries)
}

export function restoreComposerDraft(
  drafts: ComposerDrafts,
  chats: ChatRef[],
  chatId: string,
  failedValue: string,
  failedImages: ComposerImage[]
): ComposerDrafts {
  return updateComposerDraft(drafts, chats, chatId, (current) => {
    const value = [failedValue, current.value].filter(Boolean).join('\n\n')
    const images = [...failedImages, ...current.images].filter(
      (image, index, all) => all.findIndex((candidate) => candidate.id === image.id) === index
    )
    return { value, images }
  })
}
