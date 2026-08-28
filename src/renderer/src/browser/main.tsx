import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '../assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserChrome } from './BrowserChrome'
import { AppContextMenu } from '../components/AppContextMenu'
import { installSquircle } from '../lib/squircle'

// Reserve space for the native window-control overlay (same as the main window).
document.documentElement.dataset.platform = window.electron?.process?.platform ?? 'win32'

// Same visual upgrade as the main renderer: all `.sq*` classes in the browser
// chrome (tabs, menus, review pane) are inert until this flag is installed.
installSquircle()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {/* The chrome is our React app, so it gets the themed menu; the PAGES
        below it are BrowserViews and get a native one from main. */}
    <AppContextMenu />
    <BrowserChrome />
  </React.StrictMode>
)
