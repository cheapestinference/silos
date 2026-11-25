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
import { Logo } from './Logo'
import { PairView } from './PairView'

// The gate's face while it decides. A local roundtrip resolves within the
// first second and keeps the bare canvas — no flash. Past 1s (a wake-up
// network, a cold tunnel) the mark pulses: without it the wait is an
// anonymous dark canvas that reads as a dead screen.
function CheckingVeil() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-canvas">
      {slow ? <Logo size={32} className="text-terracotta motion-safe:animate-pulse" /> : null}
    </div>
  )
}

type State = 'checking' | 'login' | 'pair' | 'app'

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('checking')
  const [landingError, setLandingError] = useState<string | null>(null)
  const [claim, setClaim] = useState(false)

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
      setClaim(cfg.claim === true)
      setState(cfg.enabled ? 'login' : 'pair')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'checking') return <CheckingVeil />
  if (state === 'login') return <LoginView initialError={landingError} claim={claim} />
  if (state === 'pair') return <PairView onPaired={() => setState('app')} />
  return <>{children}</>
}
