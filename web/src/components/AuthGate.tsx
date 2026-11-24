// The entry gate: decides between the app, the login screen and «Pair this
// browser». Nobody is the owner by default: the app
// opens only for the owner's credential. Rules, in order:
//   1. getToken() consumes ?token= from the URL BEFORE anything else — the
//      link the server prints at start always wins, with or without
//      Silos ID: that click IS the pairing, and Google being down never
//      locks the owner out on their own machine.
//   2. GET /api/auth/me (public) says who this browser's credential is:
//      'owner' → the app.
//   3. Anything else: with Silos ID login on (GET /api/auth/config) →
//      LoginView, the remote flow unchanged; without it → PairView (open
//      the printed link, or paste the token from ~/.silos/token).
// If the server doesn't answer (it went down mid-load), it enters the app:
// it already has its own error surface (ErrorStrip).
import { useEffect, useState, type ReactNode } from 'react'
import { getToken } from '../lib/api'
import { consumeSilosIdLanding, fetchAuthConfig, fetchWho, type AuthConfig } from '../lib/auth'
import { LoginView } from './LoginView'
import { PairView } from './PairView'

type State = 'checking' | 'login' | 'pair' | 'app'

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('checking')
  const [landingError, setLandingError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // a Silos ID landing (#silos-id=… / #silos-id-error=…) first: its
      // session is then the token getToken() returns
      const landed = consumeSilosIdLanding()
      if (!cancelled && landed !== null) setLandingError(landed)
      const token = getToken() // consumes ?token= from the URL and persists it, as always
      let who: string
      let cfg: AuthConfig
      try {
        who = await fetchWho(token)
        if (who === 'owner') {
          if (!cancelled) setState('app')
          return
        }
        cfg = await fetchAuthConfig()
      } catch {
        if (!cancelled) setState('app')
        return
      }
      if (cancelled) return
      setState(cfg.enabled ? 'login' : 'pair')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // no flash: an empty cream background while it decides (a local roundtrip)
  if (state === 'checking') return <div className="h-screen w-screen bg-canvas" />
  if (state === 'login') return <LoginView initialError={landingError} />
  if (state === 'pair') return <PairView onPaired={() => setState('app')} />
  return <>{children}</>
}
