import { useState } from 'react'
import { HashRouter, useNavigate } from 'react-router-dom'
import {
  VOICE_MODELS,
  normalizeVoice,
  type VoiceEvent,
  type VoiceState
} from '../../src/shared/voice'
import { VoiceSettings } from '../../src/renderer/src/components/VoiceSettings'
import { Composer } from '../../src/renderer/src/components/Composer'
import { useRoxyStore } from '../../src/renderer/src/lib/store'

const listeners = new Set<(event: VoiceEvent) => void>()
let state: VoiceState = {
  settings: normalizeVoice(null),
  supported: true,
  permission: 'granted',
  installed: [],
  download: null,
  error: null
}
let recordingId = ''
let sequence = 0
let slow = false
const emit = (event: VoiceEvent): void => {
  for (const listener of listeners) listener(event)
}
const publish = (): void => emit({ type: 'state', state: structuredClone(state) })
window.roxy.voice = {
  state: async () => structuredClone(state),
  update: async (patch) => {
    state.settings = normalizeVoice({ ...state.settings, ...patch })
    publish()
    return { ok: true, value: state.settings }
  },
  devices: async () => ({
    ok: true,
    value: [
      { id: 'usb', name: 'USB Microphone', occurrence: 0, isDefault: true },
      { id: 'headset', name: 'Bluetooth Headset', occurrence: 0, isDefault: false }
    ]
  }),
  privacy: async () => {},
  download: async (id) => {
    state.installed.push(id)
    publish()
    return { ok: true, value: undefined }
  },
  cancelDownload: async () => {},
  remove: async (id) => {
    state.installed = state.installed.filter((model) => model !== id)
    if (state.settings.modelId === id) state.settings.modelId = null
    publish()
    return { ok: true, value: undefined }
  },
  start: async (id) => {
    recordingId = id
    sequence = 0
    if (!slow) emit({ type: 'recording', recordingId: id, phase: 'recording' })
    return { ok: true, value: undefined }
  },
  stop: async (id, finalize) => {
    if (finalize && slow) await new Promise((resolve) => setTimeout(resolve, 2300))
    if (finalize)
      emit({
        type: 'transcript',
        recordingId: id,
        sequence: ++sequence,
        text: 'Hello streaming world.'
      })
    emit({ type: 'recording', recordingId: id, phase: 'stopped' })
  },
  onEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}
Object.assign(window.roxy, {
  models: { recent: async () => [], hidden: async () => [], list: async () => ({ models: [] }) },
  bots: { list: async () => [] },
  queue: { add: async () => {} }
})
useRoxyStore.setState({
  activeChatId: 'voice-test',
  chats: [{ id: 'voice-test', tasks: [] } as never],
  settings: { activeProviderId: null, activeModel: null } as never,
  providers: [],
  bots: [],
  queue: [],
  composerDrafts: {}
})

export function VoiceHarness(): JSX.Element {
  return (
    <HashRouter>
      <VoicePages />
    </HashRouter>
  )
}

function VoicePages(): JSX.Element {
  const [settings, setSettings] = useState(true)
  const [mounted, setMounted] = useState(true)
  const [hidden, setHidden] = useState(false)
  const navigate = useNavigate()
  return (
    <>
      <div className="bar">
        <button id="voice-page" onClick={() => setSettings(!settings)}>
          Settings / Composer
        </button>
        <button
          id="voice-partial"
          onClick={() =>
            emit({
              type: 'transcript',
              recordingId,
              sequence: ++sequence,
              text: sequence === 1 ? 'Hello' : 'Hello streaming world'
            })
          }
        >
          Partial
        </button>
        <button id="voice-hotkey" onClick={() => emit({ type: 'toggle' })}>
          Hotkey
        </button>
        <button
          id="voice-slow"
          onClick={() => {
            slow = !slow
          }}
        >
          Slow
        </button>
        <button
          id="voice-started"
          onClick={() => emit({ type: 'recording', recordingId, phase: 'recording' })}
        >
          Started
        </button>
        <button
          id="voice-route"
          onClick={() => {
            setHidden(!hidden)
            navigate(hidden ? '/' : '/settings/voice')
          }}
        >
          Route
        </button>
        <button
          id="voice-late"
          onClick={() =>
            emit({ type: 'transcript', recordingId, sequence: ++sequence, text: 'STALE TEXT' })
          }
        >
          Late event
        </button>
        <button id="voice-remount" onClick={() => setMounted(!mounted)}>
          Remount
        </button>
        <button
          id="voice-ready"
          onClick={() => {
            state = {
              ...state,
              settings: { ...state.settings, enabled: true, modelId: VOICE_MODELS[0].id },
              installed: [VOICE_MODELS[0].id]
            }
            publish()
          }}
        >
          Ready
        </button>
      </div>
      {settings ? (
        <div className="min-h-0 flex-1 overflow-auto p-6">
          <div className="mx-auto max-w-2xl">
            <VoiceSettings />
          </div>
        </div>
      ) : (
        <div className={'flex min-h-0 flex-1 flex-col justify-end' + (hidden ? ' invisible' : '')}>
          {mounted && <Composer chatId="voice-test" onSend={async () => {}} />}
        </div>
      )}
    </>
  )
}
