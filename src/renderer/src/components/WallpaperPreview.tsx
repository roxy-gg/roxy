import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useMotion } from '../lib/motion'

/** Mounted with a selection key so late responses cannot replace another card's preview. */
export function WallpaperPreview({
  id,
  custom = false,
  enabled,
  thumbnail,
  title
}: {
  id: string
  custom?: boolean
  enabled: boolean
  thumbnail?: string
  title: string
}): JSX.Element {
  const { reduced } = useMotion()
  const host = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [source, setSource] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(!document.hidden)
  useEffect(() => {
    if (!enabled || reduced || source) return
    let disposed = false
    void (custom ? api.background.previewCustom(id) : api.background.preview(id))
      .then((result) => {
        if (!disposed && result.ok) setSource(result.value)
      })
      .catch(() => {}) // A failed preview leaves the thumbnail and apply action usable.
    return () => {
      disposed = true
    }
  }, [id, custom, enabled, reduced, source])
  useEffect(() => {
    const element = host.current!
    let intersecting = true
    const update = (): void =>
      setVisible(
        !document.hidden &&
          intersecting &&
          element.checkVisibility({ checkVisibilityCSS: true }) &&
          !element.closest('[inert]')
      )
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting
      update()
    })
    observer.observe(element)
    const mutations = new MutationObserver(update)
    for (let parent: Element | null = element; parent; parent = parent.parentElement)
      mutations.observe(parent, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'inert']
      })
    document.addEventListener('visibilitychange', update)
    update()
    return () => {
      observer.disconnect()
      mutations.disconnect()
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  const playing = enabled && !reduced && visible && !failed && !!source
  const isVideo = source?.startsWith('data:video/')
  useEffect(() => {
    const element = video.current
    if (!element || !playing) return
    let disposed = false
    void element.play().catch((error: DOMException) => {
      if (!disposed && error.name !== 'AbortError') setFailed(true)
    })
    return () => {
      disposed = true
      element.pause()
    }
  }, [playing, source])
  const className = 'aspect-video max-h-72 w-full object-contain'
  return (
    <div ref={host} data-wallpaper-preview className="overflow-hidden rounded-md bg-surface">
      {playing && isVideo ? (
        <video
          ref={video}
          src={source!}
          poster={thumbnail}
          loop
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          disableRemotePlayback
          aria-label={title}
          onError={() => setFailed(true)}
          className={className}
        />
      ) : playing || thumbnail ? (
        <img
          src={playing ? source! : thumbnail}
          alt={title}
          className={className}
          onError={() => {
            if (playing) setFailed(true)
          }}
        />
      ) : (
        <div className={className} />
      )}
    </div>
  )
}
