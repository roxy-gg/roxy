// Unlike BotsHarness, this fixture uses the real Electron preload and main IPC.
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '../../src/renderer/src/assets/main.css'
import '../../src/renderer/src/i18n'
import { ChatView } from '../../src/renderer/src/components/ChatView'
import { useRoxyStore } from '../../src/renderer/src/lib/store'
import type { ComposerImage } from '../../src/renderer/src/lib/images'
import type { CanvasProbe } from '../../src/renderer/src/canvas/CanvasTranscript'

const ready = useRoxyStore.getState().bootstrap()
let waitingPaints = 0
let observer: MutationObserver | undefined
let expectedPrompt: string | null = null
let promptBeforeThinking = true
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
async function waitFor(test: () => boolean): Promise<boolean> {
  for (let i = 0; i < 300; i++) {
    if (test()) return true
    await frame()
  }
  throw new Error('Delivery fixture did not settle')
}
const delivery = {
  async recoverMissedCompletion(): Promise<boolean> {
    const id = useRoxyStore.getState().activeChatId!
    useRoxyStore.setState((s) => ({
      runningAutomation: { ...s.runningAutomation, [id]: true },
      startingAutomation: { ...s.startingAutomation, [id]: true },
      streamingChats: { ...s.streamingChats, [id]: [] }
    }))
    await useRoxyStore.getState().refreshLiveState()
    const state = useRoxyStore.getState()
    return (
      !state.runningAutomation[id] &&
      !state.startingAutomation[id] &&
      !state.streamingChats[id] &&
      state.messages.some((message) => message.role === 'assistant')
    )
  },
  get promptBeforeThinking() {
    return expectedPrompt === null && promptBeforeThinking
  },
  get waitingPaints() {
    return waitingPaints
  },
  async select(id: string) {
    await ready
    await useRoxyStore.getState().selectChat(id)
    await frame()
  },
  observe() {
    waitingPaints = 0
    promptBeforeThinking = true
    observer?.disconnect()
    observer = new MutationObserver(() => {
      if (document.querySelector('[data-waiting-queue]')) waitingPaints++
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  },
  async send(text: string, images?: ComposerImage[]) {
    const id = useRoxyStore.getState().activeChatId!
    useRoxyStore.setState((s) => ({
      composerDrafts: {
        ...s.composerDrafts,
        [id]: {
          value: text,
          images: images?.map((image) => ({ ...image, id: crypto.randomUUID() })) ?? []
        }
      }
    }))
    const selector = 'button[aria-label="Send"], button[aria-label="Add to queue"]'
    await frame()
    await waitFor(() => document.querySelector<HTMLButtonElement>(selector)?.disabled === false)
    const button = document.querySelector<HTMLButtonElement>(selector)!
    if (button.getAttribute('aria-label') === 'Send') {
      expectedPrompt = text
      const inspect = (): void => {
        if (expectedPrompt !== text) return
        const probe = (window as unknown as { __canvasTranscript?: CanvasProbe }).__canvasTranscript
        const blocks = probe?.scene().blocks
        if (blocks?.some((block) => block.id === '__streaming__')) {
          promptBeforeThinking &&= blocks.some(
            (block) => block.copyText?.() === text || block.copyText?.().startsWith(text + '\n')
          )
          expectedPrompt = null
        } else requestAnimationFrame(inspect)
      }
      requestAnimationFrame(inspect)
    }
    button.click()
    await frame()
  },
  async waitForQueue(text: string) {
    return waitFor(
      () => !!document.querySelector('[data-waiting-queue]')?.textContent?.includes(text)
    )
  },
  async waitForEmptyQueue() {
    return waitFor(() => !document.querySelector('[data-waiting-queue]'))
  }
}
Object.assign(window, { delivery })
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <ChatView />
  </HashRouter>
)
