import '@fontsource-variable/geist/index.css'
import '../assets/main.css'
import '../i18n'
import ReactDOM from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { NarreteOverlay } from './NarreteOverlay'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <NarreteOverlay />
  </MemoryRouter>
)
