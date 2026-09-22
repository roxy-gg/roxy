/** Mention highlighting helpers. Default Enter never routes from these matches. */
export const MENTION =
  /(?<![^\s,;:!?()[\]{}\u00bf\u00a1])@[a-z][a-z0-9_-]{1,31}(?![\w@/-]|\.[a-z0-9])/gi

export function isKnownMention(text: string, usernames: readonly string[]): boolean {
  const name = text.slice(1).toLowerCase()
  return name === 'roxy' || usernames.some((username) => username.toLowerCase() === name)
}

/**
 * Distinct known bots mentioned in `text`, in first-seen order.
 * Skips @roxy — the host is the default Enter target, not a guest send.
 */
export function mentionedBots<T extends { username: string }>(
  text: string,
  bots: readonly T[]
): T[] {
  const byName = new Map(bots.map((bot) => [bot.username.toLowerCase(), bot]))
  const seen = new Set<string>()
  const out: T[] = []
  for (const match of text.matchAll(MENTION)) {
    const name = match[0].slice(1).toLowerCase()
    if (name === 'roxy' || seen.has(name)) continue
    const bot = byName.get(name)
    if (!bot) continue
    seen.add(name)
    out.push(bot)
  }
  return out
}
