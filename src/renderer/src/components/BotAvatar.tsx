import { Facehash, FACES, stringHash } from 'facehash'
import { renderToStaticMarkup } from 'react-dom/server'

const COLORS = ['#b5a1e8', '#e6ae96', '#94cbbb', '#9dbde4', '#d9c783']

/** One identity across the sidebar, mentions, and canvas transcript. */
export function BotAvatar({
  username,
  size = 32
}: {
  username: string
  size?: number
}): JSX.Element {
  return (
    <Facehash
      name={username}
      size={size}
      colors={COLORS}
      variant="solid"
      intensity3d="none"
      interactive={false}
      showInitial={false}
      className="shrink-0 rounded-full text-black"
      aria-hidden
    />
  )
}

const avatarUrls = new Map<string, string>()

/** Use Facehash's actual SVG face on canvas, not a DOM-only alternate transcript. */
export function botAvatarUrl(username: string): string {
  const cached = avatarUrls.get(username)
  if (cached) return cached
  const hash = stringHash(username)
  const Face = FACES[hash % FACES.length]
  const eyes = renderToStaticMarkup(<Face />).replace(
    '<svg ',
    '<svg x="20" y="30" width="60" height="40" '
  )
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" color="black"><circle cx="50" cy="50" r="50" fill="${COLORS[hash % COLORS.length]}"/>${eyes}</svg>`
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`
  avatarUrls.set(username, url)
  return url
}
