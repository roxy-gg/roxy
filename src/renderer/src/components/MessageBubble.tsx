import { memo } from 'react'
import { User } from 'lucide-react'
import type { BotAuthor, BotMember, MessagePart, MessageRole } from '@shared/types'
import { MessageParts } from './MessageParts'
import { HOVERABLE_THUMB, ImagePreview } from './ImagePreview'
import { BotAvatar, accentOf } from './BotAvatar'
import { cn } from '../lib/cn'

/** Flatten a turn's text parts down to plain text (for user messages). */
function partsToText(parts: MessagePart[]): string {
  return parts.map((p) => (p.type === 'text' || p.type === 'reasoning' ? p.text : '')).join('')
}

/**
 * A user message with its `@mentions` tinted in their member's accent, so who
 * the message was addressed to is visible at a glance in a busy channel.
 *
 * Only names that are actually IN the channel are highlighted — a stray
 * `@something` stays plain text rather than implying a member that can't answer.
 */
function UserText({ text, members }: { text: string; members: BotMember[] }): JSX.Element {
  const byName = new Map(members.map((m) => [m.name.toLowerCase(), m]))
  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text">
      {text.split(/(@[\w-]+)/g).map((segment, i) => {
        const member = segment.startsWith('@') && byName.get(segment.slice(1).toLowerCase())
        if (!member) return segment
        return (
          <span
            key={i}
            className={cn(
              'rounded px-1 py-0.5 text-[13px] font-medium',
              accentOf(member.color).chip
            )}
          >
            {segment}
          </span>
        )
      })}
    </div>
  )
}

function MessageBubbleImpl({
  role,
  parts,
  author,
  members = [],
  streaming = false
}: {
  role: MessageRole
  parts: MessagePart[]
  /** Which member wrote this turn. Absent = Roxy (and every pre-channel turn). */
  author?: BotAuthor
  /** Current channel membership, for tinting mentions. */
  members?: BotMember[]
  streaming?: boolean
}): JSX.Element {
  // A channel notice is not something anyone SAID — it is a line in the room's
  // history — so it renders as a bare centered divider with no avatar, no name,
  // and no bubble. Handled here rather than in the transcript loop so a notice
  // stays a normal persisted message everywhere else.
  if (role === 'system') return <MessageParts parts={parts} />

  const isUser = role === 'user'
  const imageParts = parts.filter(
    (p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image'
  )
  const text = partsToText(parts)
  return (
    <div className="flex gap-3 px-1 py-3">
      <div className="mt-0.5 shrink-0">
        {isUser ? (
          <div className="flex h-7 w-7 items-center justify-center sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 text-text-muted">
            <User className="h-4 w-4" />
          </div>
        ) : (
          <BotAvatar author={author} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1.5 text-xs">
          <span
            className={cn(
              'font-medium',
              isUser || !author ? 'text-text-muted' : accentOf(author.color).text
            )}
          >
            {isUser ? 'You' : (author?.name ?? 'Roxy')}
          </span>
          {!isUser && author?.role && <span className="text-text-subtle">{author.role}</span>}
        </div>
        {isUser ? (
          <div className="flex flex-col gap-2">
            {imageParts.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {imageParts.map((img, i) => (
                  // These are object-cover, so a tall screenshot is shown cropped
                  // — hover floats the whole, uncropped image.
                  <ImagePreview key={i} src={img.dataUrl} name={img.name}>
                    <img
                      src={img.dataUrl}
                      alt={img.name ?? 'attachment'}
                      className={HOVERABLE_THUMB}
                    />
                  </ImagePreview>
                ))}
              </div>
            )}
            {text && <UserText text={text} members={members} />}
          </div>
        ) : (
          <MessageParts parts={parts} streaming={streaming} />
        )}
      </div>
    </div>
  )
}

/**
 * Memoized because the transcript re-renders on every streamed token.
 *
 * `streaming` writes a brand-new parts array into the store on each delta, which
 * re-renders ChatView, which previously re-rendered all 30 settled bubbles with
 * it — re-parsing every markdown block through Streamdown ~80 times a second for
 * messages whose content had not changed since they were written to SQLite.
 *
 * A settled message's `parts` array is a stable reference (it comes straight off
 * the loaded row and is never rebuilt), so the default shallow compare is both
 * correct and enough: only the live bubble, whose array genuinely changes,
 * re-renders.
 */
export const MessageBubble = memo(MessageBubbleImpl)
