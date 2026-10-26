import { useEffect, useRef, useState } from 'react'
import type { BackgroundEffect } from '@shared/background'
import { backgroundMediaFailed, useBackground } from '../lib/background'

export function BackgroundMedia({ effect }: { effect: BackgroundEffect }): JSX.Element | null {
  const background = useBackground()
  const ref = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const source = background.rendered
  const video = source?.startsWith('data:video/') && failed !== source
  useEffect(() => {
    const element = ref.current
    if (!element || !video) return
    let visible = true
    const update = (): void => {
      if (
        !document.hidden &&
        visible &&
        element.checkVisibility({ checkVisibilityCSS: true }) &&
        !element.closest('[inert]') &&
        !matchMedia('(prefers-contrast: more)').matches
      ) {
        void element.play().catch((error: DOMException) => {
          if (error.name === 'AbortError' || ref.current !== element) return
          setFailed(source!)
          backgroundMediaFailed(source!)
        })
      } else element.pause()
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      update()
    })
    observer.observe(element)
    const mutations = new MutationObserver(update)
    for (
      let parent: Element | null = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      mutations.observe(parent, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'inert']
      })
    }
    const contrast = matchMedia('(prefers-contrast: more)')
    contrast.addEventListener('change', update)
    document.addEventListener('visibilitychange', update)
    element.addEventListener('loadeddata', update)
    update()
    return () => {
      element.pause()
      observer.disconnect()
      mutations.disconnect()
      contrast.removeEventListener('change', update)
      document.removeEventListener('visibilitychange', update)
      element.removeEventListener('loadeddata', update)
    }
  }, [source, video])
  if (!source) return null
  if (video)
    return (
      <video
        ref={ref}
        key={source}
        src={source}
        poster={background.poster}
        loop
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        disableRemotePlayback
        aria-hidden="true"
        data-effect={effect}
        onError={() => {
          setFailed(source)
          backgroundMediaFailed(source)
        }}
      />
    )
  return (
    <img
      src={source.startsWith('data:video/') ? background.poster : source}
      alt=""
      draggable={false}
      data-effect={effect}
      onError={() => backgroundMediaFailed(source)}
    />
  )
}
