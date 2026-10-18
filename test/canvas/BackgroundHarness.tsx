import { useState } from 'react'
import { BotsHarness } from './BotsHarness'
import { BackgroundSettings } from '../../src/renderer/src/components/BackgroundSettings'
import { startBackground } from '../../src/renderer/src/lib/background'
import { applyTheme } from '../../src/renderer/src/lib/theme'
import { installSquircle } from '../../src/renderer/src/lib/squircle'
import { useRoxyStore } from '../../src/renderer/src/lib/store'
import {
  DEFAULT_BACKGROUND,
  normalizeBackground,
  type BackgroundState
} from '../../src/shared/background'
import { BUILT_IN_THEMES, resolveTheme } from '../../src/shared/theme'
import mp4Url from '../fixtures/background.mp4?url'
import movUrl from '../fixtures/background.mov?url'
import gifUrl from '../fixtures/background.gif?url'

const canvas = document.createElement('canvas')
canvas.width = 1200
canvas.height = 800
const ctx = canvas.getContext('2d')!
const gradient = ctx.createLinearGradient(0, 0, 1200, 800)
gradient.addColorStop(0, '#131944')
gradient.addColorStop(0.4, '#325fba')
gradient.addColorStop(0.7, '#6ba6b7')
gradient.addColorStop(1, '#cb937e')
ctx.fillStyle = gradient
ctx.fillRect(0, 0, 1200, 800)
ctx.fillStyle = '#eeeecc'
ctx.beginPath()
ctx.arc(860, 180, 95, 0, Math.PI * 2)
ctx.fill()
const image = canvas.toDataURL()
const callbacks = new Set<(state: BackgroundState) => void>()
let state: BackgroundState = JSON.parse(localStorage.getItem('roxy.test.background') || 'null') ?? {
  image: null,
  settings: { ...DEFAULT_BACKGROUND }
}
const commit = (next: BackgroundState) => {
  if (location.hash === '#fail') return { ok: false as const, error: 'saveFailed' as const }
  state = next
  localStorage.setItem('roxy.test.background', JSON.stringify(state))
  for (const cb of callbacks) cb(state)
  return { ok: true as const, state }
}
let pending: Promise<unknown> = Promise.resolve()
const delayed = (
  operation: () => ReturnType<typeof commit>
): Promise<ReturnType<typeof commit>> => {
  const delay = location.hash === '#slow' ? 300 : 0
  const work = pending.then(async () => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    return operation()
  })
  pending = work
  return work
}
window.roxy.background = {
  search: async () => ({ ok: true, value: { entries: [], nextCursor: null } }),
  applyCatalog: async () => ({ ok: true, value: commit({ settings: state.settings, image }) }),
  submit: async () => ({ ok: true, value: { id: '00000000-0000-4000-8000-000000000001' } }),
  get: async () => {
    if (new URLSearchParams(location.search).has('motion-race'))
      await new Promise((resolve) => setTimeout(resolve, 200))
    return state
  },
  choose: async () => {
    if (location.hash === '#cancel') return null
    const mediaUrl = { '#mp4': mp4Url, '#mov': movUrl, '#gif': gifUrl }[location.hash]
    if (mediaUrl) {
      const blob = await (await fetch(mediaUrl)).blob()
      const media = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(
          new Blob([blob], { type: location.hash === '#gif' ? 'image/gif' : 'video/mp4' })
        )
      })
      return commit({ settings: state.settings, image: media, poster: image })
    }
    return commit({ settings: state.settings, image })
  },
  remove: async () => commit({ settings: state.settings, image: null }),
  update: (settings) =>
    delayed(() =>
      commit({ ...state, settings: normalizeBackground({ ...state.settings, ...settings }) })
    ),
  onChanged: (cb) => {
    callbacks.add(cb)
    return () => {
      callbacks.delete(cb)
    }
  }
}
const stop = startBackground()
if (new URLSearchParams(location.search).has('motion-race')) {
  setTimeout(() => {
    void window.roxy.settings.setMotion('reduced')
  }, 20)
}
import.meta.hot?.dispose(stop)
installSquircle()

export function BackgroundHarness(): JSX.Element {
  const [theme, setTheme] = useState(0)
  const [settings, setSettings] = useState(true)
  return (
    <>
      <div className="bar">
        <button
          id="background-theme"
          onClick={() => {
            const next = (theme + 1) % 3
            setTheme(next)
            applyTheme(
              resolveTheme(
                next === 2
                  ? {
                      id: 'plum',
                      name: 'Plum',
                      colors: { bg: '#201322', 'surface-2': '#3d2942', surface: '#291b2d' }
                    }
                  : BUILT_IN_THEMES[next]
              )
            )
          }}
        >
          Theme {theme}
        </button>
        <button id="background-settings" onClick={() => setSettings(!settings)}>
          Settings
        </button>
        <button
          id="background-messages"
          onClick={() => {
            const s = useRoxyStore.getState()
            const id = s.activeChatId!
            useRoxyStore.setState({
              messagesChatId: id,
              messages: [
                {
                  id: 'wallpaper-test',
                  chatId: id,
                  role: 'assistant',
                  content: 'The wallpaper stays behind the transcript.',
                  parts: [{ type: 'text', text: 'The wallpaper stays behind the transcript.' }],
                  createdAt: Date.now()
                }
              ]
            })
          }}
        >
          Messages
        </button>
        <button
          id="background-empty"
          onClick={() =>
            useRoxyStore.setState({
              messages: [],
              messagesError: null,
              messagesChatId: useRoxyStore.getState().activeChatId
            })
          }
        >
          Empty
        </button>
        <button
          id="background-loading"
          onClick={() =>
            useRoxyStore.setState({ messages: [], messagesError: null, messagesChatId: null })
          }
        >
          Loading
        </button>
        <button
          id="background-error"
          onClick={() => useRoxyStore.setState({ messages: [], messagesError: 'test' })}
        >
          Error
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {settings && (
          <div
            id="wallpaper-settings"
            className="w-full shrink-0 overflow-auto bg-bg p-4 md:w-[380px]"
          >
            <BackgroundSettings />
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <BotsHarness />
        </div>
      </div>
    </>
  )
}
