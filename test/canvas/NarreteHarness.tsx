import { useState } from 'react'
import { HashRouter } from 'react-router-dom'
import { Composer } from '../../src/renderer/src/components/Composer'
import { NarreteSettings } from '../../src/renderer/src/components/NarreteSettings'
import { NarreteOverlay } from '../../src/renderer/src/narrete/NarreteOverlay'
import { useRoxyStore } from '../../src/renderer/src/lib/store'
import { normalizeVoice, VOICE_MODELS, type VoiceEvent } from '../../src/shared/voice'
import {
  narreteDrag,
  type NarreteCaptureResult,
  type NarreteSelection,
  type NarreteSurface,
  type NarreteRegion
} from '../../src/shared/narrete'

const listeners = new Set<(event: VoiceEvent) => void>()
const resetListeners = new Set<(surface: NarreteSurface) => void>()
let recordingId = ''
let sequence = 0
let finishSession: ((result: NarreteCaptureResult) => void) | null = null
let setOpen: (open: boolean) => void = () => {}
let setChat: (chatId: string) => void = () => {}
let lateResult: ((result: NarreteCaptureResult) => void) | null = null
const image = (region?: NarreteSelection): string => {
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 800
  const context = canvas.getContext('2d')!
  context.fillStyle = '#172d40'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#fff'
  context.font = '26px sans-serif'
  context.fillText('A screen, not a screenshot editor', 80, 120)
  context.fillStyle = '#3478f6'
  context.fillRect(80, 180, 240, 56)
  if (!region) return canvas.toDataURL()
  const cropped = document.createElement('canvas')
  cropped.width = Math.ceil(region.width * canvas.width)
  cropped.height = Math.ceil(region.height * canvas.height)
  cropped
    .getContext('2d')!
    .drawImage(
      canvas,
      region.x * canvas.width,
      region.y * canvas.height,
      cropped.width,
      cropped.height,
      0,
      0,
      cropped.width,
      cropped.height
    )
  return cropped.toDataURL()
}
let note = ''
let regions: NarreteRegion[] = []
let selection: NarreteSelection | null = null
let previewDataUrl: string | null = null
let snapshots = 0
let revision = 0
const dragListeners = new Set<(selection: NarreteSelection | null) => void>()
const state = (): NarreteSurface => ({
  chatId: 'narrete-test',
  language: 'en',
  note,
  selection,
  previewDataUrl,
  revision: ++revision,
  regions: [...regions]
})
const test = {
  sends: [] as { chatId: string; text: string; images: unknown[] }[],
  failure: false,
  captureFailure: false,
  refreshes: 0,
  get snapshots() {
    return snapshots
  },
  drag: (x1: number, y1: number, x2: number, y2: number, ctrl = false) => {
    if (selection || !ctrl) return
    const region = narreteDrag(
      { x: x1, y: y1 },
      { x: x2, y: y2 },
      { x: 0, y: 0, width: innerWidth, height: innerHeight }
    )
    for (const listener of dragListeners) listener(region)
    if (!region) return
    if (test.captureFailure) {
      for (const listener of resetListeners) listener({ ...state(), error: 'captureFailed' })
      return
    }
    snapshots++
    selection = region
    previewDataUrl = image(region)
    for (const listener of resetListeners) listener(state())
  },
  editDraft: (value: string) =>
    useRoxyStore.setState((current) => ({
      composerDrafts: {
        ...current.composerDrafts,
        'narrete-test': { value, images: current.composerDrafts['narrete-test'].images }
      }
    })),
  switchChat: () => {
    lateResult = finishSession
    finishSession = null
    setOpen(false)
    useRoxyStore.setState({ activeChatId: 'other' })
    setChat('other')
  },
  lateResult: () =>
    lateResult?.({
      ok: true,
      text: 'STALE RESULT',
      image: { dataUrl: image(), mediaType: 'image/png', name: 'Stale.png' }
    }),
  partial: () => {
    for (const listener of listeners)
      listener({ type: 'transcript', recordingId, sequence: ++sequence, text: 'Make this button' })
  },
  late: () => {
    for (const listener of listeners)
      listener({ type: 'transcript', recordingId, sequence: ++sequence, text: 'STALE' })
  },
  draft: () => useRoxyStore.getState().composerDrafts['narrete-test']
}
Object.assign(window, { __narreteTest: test })
const close = (result: NarreteCaptureResult): void => {
  setOpen(false)
  finishSession?.(result)
  finishSession = null
}
window.roxy.narrete = {
  start: async () => {
    note = ''
    regions = []
    selection = null
    previewDataUrl = null
    setOpen(true)
    return new Promise((resolve) => {
      finishSession = resolve
    })
  },
  cancel: async () => close({ ok: false, error: 'cancelled' })
}
window.narrete = {
  state: async () => state(),
  ready: async () => {},
  layout: async () => {},
  onDrag: (callback) => {
    dragListeners.add(callback)
    return () => {
      dragListeners.delete(callback)
    }
  },
  refresh: async (draft, region) => {
    if (test.captureFailure) return { ok: false, error: 'captureFailed' }
    if (region && previewDataUrl) regions.push({ dataUrl: previewDataUrl, note: draft })
    note = region ? '' : draft
    selection = null
    previewDataUrl = null
    test.refreshes++
    for (const listener of resetListeners) listener(state())
    return { ok: true }
  },
  submit: async (selection, note) => {
    if (test.failure) return { ok: false, error: 'sendFailed' }
    const all = selection ? [...regions, { dataUrl: image(), note }] : regions
    close({
      ok: true,
      text: all.map((region, index) => `${index + 1}. ${region.note}`).join('\n\n'),
      image: { dataUrl: image(), mediaType: 'image/png', name: 'Narrete.png' }
    })
    return { ok: true }
  },
  cancel: async () => close({ ok: false, error: 'cancelled' }),
  onReset: (callback) => {
    resetListeners.add(callback)
    return () => {
      resetListeners.delete(callback)
    }
  }
}
window.roxy.voice = {
  state: async () => ({
    settings: normalizeVoice({ enabled: true, modelId: VOICE_MODELS[0].id }),
    supported: true,
    permission: 'granted',
    installed: [VOICE_MODELS[0].id],
    download: null,
    error: null
  }),
  start: async (id) => {
    recordingId = id
    sequence = 0
    for (const listener of listeners)
      listener({ type: 'recording', recordingId, phase: 'recording' })
    return { ok: true, value: undefined }
  },
  stop: async (id, finalize) => {
    if (finalize) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      for (const listener of listeners)
        listener({
          type: 'transcript',
          recordingId: id,
          sequence: ++sequence,
          text: 'Make this button red.'
        })
    }
    for (const listener of listeners)
      listener({ type: 'recording', recordingId: id, phase: 'stopped' })
  },
  onEvent: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
} as typeof window.roxy.voice
window.roxy.settings.setNarreteEnabled = async (enabled) => ({
  ...useRoxyStore.getState().settings!,
  narreteEnabled: enabled
})
Object.assign(window.roxy, {
  models: { recent: async () => [], hidden: async () => [], list: async () => ({ models: [] }) }
})
useRoxyStore.setState({
  chats: [
    { id: 'narrete-test', tasks: [] },
    { id: 'other', tasks: [] }
  ] as never,
  activeChatId: 'narrete-test',
  settings: { activeProviderId: null, activeModel: null, narreteEnabled: false } as never,
  providers: [],
  bots: [],
  queue: [],
  composerDrafts: {
    'narrete-test': {
      value: 'Keep my draft',
      images: [{ id: 'existing', name: 'Existing.png', mediaType: 'image/png', dataUrl: image() }]
    }
  }
})

export function NarreteHarness(): JSX.Element {
  const [open, updateOpen] = useState(false)
  const [chatId, updateChat] = useState('narrete-test')
  setOpen = updateOpen
  setChat = updateChat
  return (
    <HashRouter>
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-xl">
          <NarreteSettings />
        </div>
      </div>
      <Composer
        key={chatId}
        chatId={chatId}
        onSend={(text, images) => {
          test.sends.push({ chatId: 'narrete-test', text, images: images ?? [] })
        }}
      />
      {open && <NarreteOverlay />}
    </HashRouter>
  )
}
