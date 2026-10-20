import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import '@fontsource-variable/geist/index.css'
import '../../src/renderer/src/assets/main.css'
import { applyLanguage } from '../../src/renderer/src/i18n'
import { NotificationSettings } from '../../src/renderer/src/components/NotificationSettings'
import { useRoxyStore } from '../../src/renderer/src/lib/store'
import { api } from '../../src/renderer/src/lib/api'

document.documentElement.dataset.platform = 'win32'
await applyLanguage('en')
useRoxyStore.setState({ settings: await api.settings.getAll() })
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="mx-auto max-w-3xl p-4">
      <NotificationSettings />
    </main>
  </StrictMode>
)
