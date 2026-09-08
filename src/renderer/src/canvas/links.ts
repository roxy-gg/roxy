/** The desktop bridge only opens HTTP(S); never send executable/file schemes to it. */
export function linkUrl(href: string): string | null {
  try {
    const url = new URL(href.startsWith('www.') ? `https://${href}` : href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function openLink(href: string): void {
  const url = linkUrl(href)
  if (!url) return
  if (window.roxy?.system) void window.roxy.system.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}
