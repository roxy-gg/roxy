/** Visual mention candidates only. Never use these matches to route work. */
export const MENTION =
  /(?<![^\s,;:!?()[\]{}\u00bf\u00a1])@[a-z][a-z0-9_-]{1,31}(?![\w@/-]|\.[a-z0-9])/gi

export function isKnownMention(text: string, usernames: readonly string[]): boolean {
  const name = text.slice(1).toLowerCase()
  return name === 'roxy' || usernames.some((username) => username.toLowerCase() === name)
}
