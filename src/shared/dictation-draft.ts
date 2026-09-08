function separator(prefix: string, text: string): string {
  return prefix && text && !/\s$/.test(prefix) && !/^\s/.test(text) ? ' ' : ''
}

/** Replace only the live suffix owned by dictation, preserving every user edit before it. */
export function replaceDictationSuffix(
  draft: string,
  previousSuffix: string,
  nextSuffix: string
): string {
  const base =
    previousSuffix && draft.endsWith(previousSuffix)
      ? draft.slice(0, draft.length - previousSuffix.length)
      : draft
  return `${base}${separator(base, nextSuffix)}${nextSuffix}`
}

/** User edits that touch the live suffix take ownership of it; dictation must not overwrite them. */
export function retainedDictationSuffix(draft: string, suffix: string): string {
  return suffix && draft.endsWith(suffix) ? suffix : ''
}
