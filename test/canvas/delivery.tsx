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

const ready = useRoxyStore.getState().bootstrap()
let waitingPaints = 0
let observer: MutationObserver | undefined
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
async function waitFor(test: () => boolean): Promise<boolean> {
  for (let i = 0; i < 300; i++) {
    if (test()) return true
    await frame()
  }
  throw new Error('Delivery fixture did not settle')
}
const delivery = {
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
    observer?.disconnect()
    observer = new MutationObserver(() => {
      if (document.querySelector('[data-waiting-queue]')) waitingPaints++
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  },
  async send(text: string, images?: ComposerImage[]) {
    const id = useRoxyStore.getState().activeChatId!
    useRoxyStore.setState((s) => ({
      composerDrafts: { ...s.composerDrafts, [id]: { value: text, images: images ?? [] } }
    }))
    await frame()
    const button = document.querySelector<HTMLButtonElement>(
      'button[title="Send"], button[title="Add to queue"]'
    )
    if (!button) throw new Error('No composer send button')
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
