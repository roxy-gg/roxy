import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Message, MessagePart } from '@shared/types'
import { getTool } from '@shared/tools'
import { CanvasSurface, type CanvasLayoutContext } from './CanvasSurface'
import { transcriptCache, layoutTranscript } from './transcript'
import type { HitAction } from './scene'
import { promptEntries } from './prompt-history'
import roxyLogo from '../assets/roxy.png'
import { useRoxyStore } from '../lib/store'
import { botAvatarUrl } from '../components/BotAvatar'

export type { CanvasProbe } from './CanvasSurface'

let decodedLogo: HTMLImageElement | null = null
let loadingLogo: Promise<HTMLImageElement> | null = null

function loadLogo(): Promise<HTMLImageElement> {
  if (decodedLogo) return Promise.resolve(decodedLogo)
  if (!loadingLogo) {
    const image = new Image()
    image.src = roxyLogo
    loadingLogo = image
      .decode()
      .then(() => {
        decodedLogo = image
        return image
      })
      .catch((error: unknown) => {
        loadingLogo = null
        throw error
      })
  }
  return loadingLogo
}

export interface CanvasTranscriptProps {
  messages: Message[]
  streaming: MessagePart[] | null
  onCancelSubagent: (subChatId: string) => void
  onCancelTool: (callId: string) => void
  onScrollStateChange?: (atBottom: boolean) => void
  pinSignal?: number
  chatId: string | null
}

export function CanvasTranscript({
  messages,
  streaming,
  chatId,
  pinSignal,
  onCancelSubagent,
  onCancelTool,
  onScrollStateChange
}: CanvasTranscriptProps): JSX.Element {
  const cache = useMemo(() => transcriptCache(chatId ?? ''), [chatId])
  const mounted = useRef(false)
  const [logo, setLogo] = useState(() => decodedLogo)
  const [clock, setClock] = useState(0)
  const prompts = useMemo(() => promptEntries(messages), [messages])
  const bots = useRoxyStore((s) => s.bots)
  const ownBot = bots.find((bot) => bot.chatId === chatId)
  // Preserve message references where possible. A rename changes only the
  // identity cache key, not every part in a long transcript.
  const identities = bots.map((bot) => `${bot.id}:${bot.username}`).join('|')
  const identityRef = useRef('')

  useEffect(() => () => cache.detach(), [cache])

  useEffect(() => {
    mounted.current = true
    // A shared decode survives StrictMode and chat remounts; message updates cannot replace its listener.
    void loadLogo()
      .then((image) => {
        if (mounted.current) setLogo(image)
      })
      .catch(() => {
        /* Keep the brand fallback; a future mount can retry the asset. */
      })
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!streaming) return
    // Reveal cancellation for a long-running tool even if no new tokens arrive.
    const timer = setTimeout(() => setClock((n) => n + 1), 1250)
    return () => clearTimeout(timer)
  }, [streaming])

  const buildScene = useCallback(
    (context: CanvasLayoutContext) => {
      void clock
      const identityKey = `${chatId}:${identities}`
      if (identityRef.current !== identityKey) {
        cache.clear()
        identityRef.current = identityKey
      }
      cache.prune(messages)
      if (logo) context.view.images.set('__roxy__', logo)
      return layoutTranscript(
        {
          ...context,
          messages,
          streaming,
          botUsername: ownBot?.username,
          bots,
          botAvatar: botAvatarUrl,
          canCancel: (part) => {
            if (part.tool === 'task') return Boolean(part.subChatId)
            return (
              Boolean(part.callId) &&
              (part.cancellable ?? Boolean(getTool(part.tool)?.interruptible))
            )
          }
        },
        cache
      )
    },
    [messages, streaming, clock, logo, cache, bots, ownBot?.username, chatId, identities]
  )

  const onAction = (action: HitAction): void => {
    if (action.type === 'cancel') {
      const [messageId, ...indices] = action.id.split('/')
      const parts =
        messageId === '__streaming__' ? streaming : messages.find((m) => m.id === messageId)?.parts
      let part = parts?.[Number(indices[0])]
      for (const index of indices.slice(1))
        part = part?.type === 'tool' ? part.children?.[Number(index)] : undefined
      if (part?.type !== 'tool') return
      if (part.tool === 'task' && part.subChatId) onCancelSubagent(part.subChatId)
      else if (part.callId) onCancelTool(part.callId)
    }
  }

  return (
    <CanvasSurface
      key={chatId ?? ''}
      sceneKey={chatId ?? ''}
      buildScene={buildScene}
      pinSignal={pinSignal}
      onAction={onAction}
      onScrollStateChange={onScrollStateChange}
      prompts={prompts}
    />
  )
}
