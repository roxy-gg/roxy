import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '../assets/main.css'
// Its own i18n init: this window has a separate React root, so the main
// window's bootstrap never runs here.
import '../i18n'
import { applyLanguage } from '../i18n'
import { api } from '../lib/api'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserChrome } from './BrowserChrome'
import { AppContextMenu } from '../components/AppContextMenu'
import { installSquircle } from '../lib/squircle'
import { primeTheme, startTheme } from '../lib/theme'

// Reserve space for the native window-control overlay (same as the main window).
document.documentElement.dataset.platform = window.electron?.process?.platform ?? 'win32'

// Same visual upgrade as the main renderer: all `.sq*` classes in the browser
// chrome (tabs, menus) are inert until this flag is installed.
installSquircle()

// The browser toolbar is a second window of the same app, so it follows the
// same theme -- and stays in step, because startTheme subscribes to changes
// broadcast from main rather than reading a value once at launch.
primeTheme()
startTheme()

// Best-effort: paint in English if the settings read fails rather than blocking
// the toolbar on it.
void api.settings
  .getAll()
  .then((s) => applyLanguage(s.language))
  .catch(() => {})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {/* The chrome is our React app, so it gets the themed menu; the PAGES
        below it are BrowserViews and get a native one from main. */}
    <AppContextMenu />
    <BrowserChrome />
  </React.StrictMode>
)
