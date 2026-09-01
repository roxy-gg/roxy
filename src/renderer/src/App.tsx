import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useRoxyStore } from './lib/store'
import roxy from './assets/roxy.png'
import Onboarding from './routes/Onboarding'
import Chat from './routes/Chat'
import Integrations from './routes/Integrations'
import Skills from './routes/Skills'
import Mcp from './routes/Mcp'
import Themes from './routes/Themes'
import Settings from './routes/Settings'

function Splash(): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg">
      <img
        src={roxy}
        alt="Roxy"
        className="h-14 w-14 animate-pulse sq sq-2xl rounded-2xl object-cover inset-ring-1 inset-ring-border"
      />
    </div>
  )
}

function AppRoutes({ onboarded }: { onboarded: boolean }): JSX.Element {
  const { pathname } = useLocation()
  const chatVisible = onboarded && pathname === '/'

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      {/* Chat is the expensive screen: a cold mount rebuilds up to 30 markdown/tool
          messages, the whole sidebar, two ResizeObservers, and the transcript's
          scroll measurements before the first frame can paint. Settings used to
          replace this tree, so its Back button was synchronous but still looked
          frozen while all of that work ran again.

          Keep Chat mounted and laid out behind secondary routes instead.
          `visibility:hidden` suppresses paint, hit-testing, focus and accessibility
          exposure without `display:none`'s cold-layout penalty. Returning to `/`
          is now only a layer reveal, and component-local state such as transcript
          pagination and scroll position survives the trip. */}
      {onboarded && (
        <div
          className={
            chatVisible ? 'absolute inset-0' : 'pointer-events-none invisible absolute inset-0'
          }
        >
          <Chat />
        </div>
      )}

      {!chatVisible && (
        <div className="absolute inset-0 z-10 bg-bg">
          <Routes>
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/" element={onboarded ? null : <Navigate to="/onboarding" replace />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/mcp" element={<Mcp />} />
            <Route path="/themes" element={<Themes />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      )}
    </div>
  )
}

export default function App(): JSX.Element {
  const ready = useRoxyStore((s) => s.ready)
  const settings = useRoxyStore((s) => s.settings)
  const bootstrap = useRoxyStore((s) => s.bootstrap)

  useEffect(() => {
    bootstrap()
  }, [bootstrap])

  if (!ready) return <Splash />

  const onboarded = settings?.onboardingCompleted ?? false

  return (
    <HashRouter>
      <AppRoutes onboarded={onboarded} />
    </HashRouter>
  )
}
