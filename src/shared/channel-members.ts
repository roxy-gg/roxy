/**
 * Channel members — the bots that sit in one session's conversation.
 *
 * A session is a CHANNEL, not a one-on-one chat. Roxy is always in it (see
 * `ROXY_HOST`) and specialists are attached alongside her, WhatsApp-style, at
 * any point in the conversation. Addressing is by `@Name`; an unaddressed
 * message goes to Roxy, so the channel can never end up with nobody listening.
 */
import type { BotMember, Message } from './types'

/** Id of the built-in host. Reserved — a user-added bot can never claim it. */
export const ROXY_HOST_ID = 'roxy'

/**
 * The host. Present in every channel, cannot be removed, and answers anything
 * that isn't addressed to somebody else.
 *
 * This is the identity the app itself has, which is why it carries no
 * `systemPrompt`: Roxy's instructions are the base system prompt the harness
 * already assembles (see main/harness/agent.ts). A specialist's prompt is
 * appended to that base, so every bot is Roxy-with-a-brief rather than a blank
 * model that has to be told who it is first.
 */
export const ROXY_HOST: BotMember = {
  id: ROXY_HOST_ID,
  name: 'Roxy',
  role: 'Host · full workspace access',
  icon: 'roxy',
  color: 'accent',
  builtIn: true
}

/**
 * Specialists offered when attaching a member. Not defaults: a new channel has
 * only Roxy in it, and these are picked from a list the way you pick a contact.
 *
 * Each prompt ends by naming who to hand back to, because that hand-off is what
 * makes the channel a conversation instead of a queue of monologues.
 */
export const SUGGESTED_MEMBERS: BotMember[] = [
  {
    id: 'builder',
    name: 'Builder',
    role: 'Implementation',
    icon: 'builder',
    color: 'blue',
    systemPrompt:
      'You are Builder, this channel\'s implementer. You write and change code, fix bugs, and run tests. Scope discipline: implement exactly what was asked, nothing more. When your change is done, state what you changed as file:line and hand off with "@Reviewer ready for review" if a Reviewer is in the channel; otherwise hand back to @Roxy.'
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'Code review',
    icon: 'reviewer',
    color: 'purple',
    systemPrompt:
      'You are Reviewer, this channel\'s critical code reviewer. Read the actual diff before commenting — never review code you have not read. Every finding cites file:line and proposes the concrete fix in a code block. Separate blocking bugs from nits, and say which is which. If it is clean, approve it plainly. If it is not, hand back with "@Builder" and the specific list.'
  },
  {
    id: 'security',
    name: 'Security',
    role: 'Audit & secrets',
    icon: 'security',
    color: 'emerald',
    systemPrompt:
      "You are Security, this channel's auditor. You look for injection, XSS, path traversal, leaked secrets and keys, unsafe permissions, and missing validation at system boundaries. Report only findings you can point at with file:line, ranked by real exploitability — no speculative checklists. Hand fixes to @Builder."
  },
  {
    id: 'architect',
    name: 'Architect',
    role: 'Design & tradeoffs',
    icon: 'architect',
    color: 'amber',
    systemPrompt:
      "You are Architect, this channel's designer. You map how a change fits the existing codebase, name the tradeoffs, and pick one option with a reason. Read the relevant code before proposing structure. Prefer the smallest design that solves the actual problem; say plainly when a simpler approach beats the one being discussed. Hand the chosen plan to @Builder."
  },
  {
    id: 'tester',
    name: 'Tester',
    role: 'Tests & repro',
    icon: 'tester',
    color: 'cyan',
    systemPrompt:
      "You are Tester, this channel's verifier. You reproduce bugs before anyone fixes them, write tests that fail for the stated reason, and run the suite. Report the exact command and its real output — never claim a test passed without running it. Hand failures to @Builder with the failing case."
  }
]

/** Every channel starts with just the host in it. */
export function defaultMembers(): BotMember[] {
  return [ROXY_HOST]
}

/**
 * Normalize a stored member list: host first, always present, deduped by id.
 *
 * Called on every read rather than trusting what was persisted, so a list
 * written by an older build (or hand-edited) can't leave a channel hostless.
 */
export function withHost(members: BotMember[] | null | undefined): BotMember[] {
  const rest: BotMember[] = []
  const seen = new Set<string>([ROXY_HOST_ID])
  for (const m of members ?? []) {
    if (m.id === ROXY_HOST_ID) continue
    if (seen.has(m.id)) continue
    seen.add(m.id)
    rest.push(m)
  }
  return [ROXY_HOST, ...rest]
}

/** Normalize a name for matching: strip a leading `@`, casefold, trim. */
function norm(name: string): string {
  return name.trim().replace(/^@/, '').toLowerCase()
}

/**
 * Members addressed by `@Name` in `text`, in the order they appear.
 *
 * Order is the mention's position in the text, not the member list's, because
 * "@Builder then @Reviewer" means Builder goes first. Matching is on a word
 * boundary so `@Builder,` and `@Builder.` both land, while an email address or
 * a `user@example.com` in a log line does not.
 */
export function parseBotMentions(text: string, members: BotMember[]): BotMember[] {
  if (!text) return []
  const byName = new Map(members.map((m) => [norm(m.name), m]))
  const found: BotMember[] = []
  const seen = new Set<string>()
  // Require the `@` to start a word, so `user@example.com` isn't a mention.
  for (const match of text.matchAll(/(?:^|[^\w@])@([\w-]+)/g)) {
    const member = byName.get(norm(match[1]))
    if (member && !seen.has(member.id)) {
      seen.add(member.id)
      found.push(member)
    }
  }
  return found
}

/** Find a member by `@Name`, plain name, or id. */
export function findMember(name: string, members: BotMember[]): BotMember | undefined {
  const target = norm(name)
  return members.find((m) => norm(m.name) === target || m.id.toLowerCase() === target)
}

/**
 * Who should answer `text` — the first member it addresses, or the host.
 *
 * The host fallback is what makes an unaddressed message always land somewhere.
 * Grok Bot's equivalent has no host, so a message with no mention in it reaches
 * nobody and the user has to name a bot before any work can start.
 */
export function resolveRecipient(text: string, members: BotMember[]): BotMember {
  const host = withHost(members)[0]
  // Addressed means the message OPENS with the mention ("@Reviewer look at
  // this"). A mention later in the sentence is the user talking ABOUT a member,
  // not to them: "create the PR and then call @Reviewer" is work for the host
  // that ENDS in a hand-off, and routing it to Reviewer instead made Reviewer
  // do the whole job - the opposite of what was asked. So a non-leading mention
  // leaves the turn with the host, who works and then hands off by @mentioning
  // them (see resolveHandoff).
  const leading = text.trimStart().match(/^@([\w-]+)/)
  if (!leading) return host
  return findMember(leading[1], withHost(members)) ?? host
}

/**
 * The channel block for the system prompt: who is in the room, who is speaking,
 * and how to reach the others.
 *
 * Without this the model has no idea the channel exists. Asked to "call
 * @Reviewer" it would search GitHub for a user by that name, find nothing, and
 * fall back to spawning a `task` subagent - precisely the wrong shape. A
 * subagent starts blank, inherits the caller's misreading of the job, reports
 * only back into the caller's own context, and never appears in the channel as
 * a peer. Naming the roster in the prompt is what turns "call @Reviewer" into a
 * hand-off to a real member with its own brief and its own scoped transcript.
 *
 * The member's brief is framed as a standing ROLE rather than pasted in raw,
 * because a model handed a bare job description treats it as a work order and
 * executes it the moment it is addressed - see the note on the brief below.
 *
 * Returns undefined for a briefless solo channel, where there is nothing to say
 * that the base prompt doesn't already cover.
 */
export function channelPrompt(members: BotMember[], speaker: BotMember): string | undefined {
  const roster = withHost(members)
  const others = roster.filter((m) => m.id !== speaker.id)
  const brief = speaker.systemPrompt?.trim()
  if (others.length === 0 && !brief) return undefined
  const lines = [
    '<channel>',
    `This session is a CHANNEL, not a one-on-one chat. You are @${speaker.name}${speaker.role ? ` - ${speaker.role}` : ''}.`
  ]
  if (others.length) {
    lines.push(
      '',
      'Who else is here:',
      ...others.map((m) => `  @${m.name} - ${m.role}`),
      '',
      'To bring another member in, END your reply by @mentioning them with what you need ("@Reviewer the PR is up, please review it"). That hands the turn over: they answer next, in this channel, as themselves.',
      `Do NOT use the \`task\` tool to reach a member. A subagent is a blank child of YOUR context that inherits your mistakes and reports only back to you, whereas @${others[0].name} is a peer with their own brief and their own view of this conversation. Members are also not GitHub users - never look one up, or assign it an issue or a PR.`,
      'Only @mention a member when you want them to act now; a reply that mentions nobody returns the turn to the user.'
    )
  }
  if (brief) {
    // The brief describes WHO the member is - a standing role, not a work
    // order. Without this the model reads its own job description as the task
    // and starts executing it on contact: "@Reviewer hi" made a review bot
    // clone repos and diff branches instead of saying hello. The newest
    // message in the conversation is what decides what to do, and the reply
    // has to be sized to it.
    lines.push(
      '',
      'Your role below is your standing identity, NOT an instruction to carry out right now. What to do is decided by the latest message in this channel; match your reply to it. Being greeted or asked a question means answering as yourself - conversationally, with no tools - and waiting. Only start the work your role describes when someone actually asks for it.',
      '',
      'Your role:',
      brief
    )
  }
  lines.push('</channel>')
  return lines.join('\n')
}

/**
 * Who a bot handed off to, given what it just said.
 *
 * `speaker` is excluded so a bot that refers to itself in the third person
 * ("@Reviewer already checked this") doesn't hand the turn back to itself and
 * spin. Returns undefined when the reply addresses nobody, which ends the
 * relay chain and returns control to the user.
 */
export function resolveHandoff(
  reply: string,
  speaker: BotMember,
  members: BotMember[]
): BotMember | undefined {
  return parseBotMentions(reply, members).find((m) => m.id !== speaker.id)
}

/**
 * How many bot-to-bot hand-offs may fire from one user message.
 *
 * A chain costs a full model turn per hop and each hop is invisible work the
 * user didn't ask for, so it is capped rather than trusted to terminate. Four
 * covers the shapes people actually use (Roxy → Builder → Reviewer → Builder →
 * Reviewer); anything longer wants a human in it.
 */
export const MAX_HANDOFF_HOPS = 4

/**
 * The transcript ONE member should see, from the channel's full history.
 *
 * This is the point of having separate bots at all. A single agent carrying a
 * whole project's context degrades: it re-reads its own earlier conclusions as
 * fresh evidence, and unrelated work crowds the window. So each specialist gets
 * a deliberately narrow view:
 *
 *   - every user message — the user is talking to the room
 *   - its own past turns — its memory of what it already did
 *   - turns that ADDRESS it by name — the hand-off it is answering
 *   - system/join notices — who else is in the room
 *
 * What it does NOT see is unrelated cross-talk between other members. Reviewer
 * reviewing a diff has no use for Security's audit of a different file, and
 * including it measurably makes the review worse.
 *
 * The HOST is exempt: Roxy is the one identity that must follow the whole
 * conversation, since she's who the user talks to when they don't name anyone
 * and who has to make sense of the room's state.
 */
export function visibleMessages(messages: Message[], member: BotMember): Message[] {
  if (member.id === ROXY_HOST_ID) return messages
  const mention = new RegExp(`(?:^|[^\\w@])@${escapeRegex(member.name)}\\b`, 'i')
  return messages.filter((m) => {
    if (m.role !== 'assistant') return true
    // Legacy rows predate authorship and could have come from anyone; showing
    // them is the safe direction (they are this session's own history).
    if (!m.author) return true
    if (norm(m.author.name) === norm(member.name)) return true
    return mention.test(m.content)
  })
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
