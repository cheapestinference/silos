// The login screen (only when the server says Silos ID is on and there's no
// valid local token — see AuthGate.tsx). The house's language: cream, a
// serif wordmark, ONE action. The mono footer note documents the local
// escape hatch (?token=) right on the screen: if Google fails, the owner is
// never locked out.
import { useState, type FormEvent } from 'react'
import { startSilosIdLogin } from '../lib/auth'
import { Logo } from './Logo'

// Google's official mark (colors from Google Sign-In's identity guidelines).
function GoogleMark() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 48 48">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

export function LoginView({ initialError = null }: { initialError?: string | null }) {
  const [state, setState] = useState<'idle' | 'working'>('idle')
  const [error, setError] = useState<string | null>(initialError)
  // Silos ID also signs in by an email link: the address is asked here
  const [emailOpen, setEmailOpen] = useState(false)
  const [email, setEmail] = useState('')

  function sendLink(e: FormEvent): void {
    e.preventDefault()
    if (email.trim() === '') return
    setState('working')
    setError(null)
    startSilosIdLogin({ method: 'email', email: email.trim() })
  }

  function signIn(): void {
    // Google runs on the broker's domain — this page only leaves for it
    // (and comes back signed in, see consumeSilosIdLanding)
    setState('working')
    setError(null)
    startSilosIdLogin({ method: 'google' })
  }

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-canvas px-6 text-ink">
      <main className="flex w-full max-w-xs flex-col items-center text-center">
        {/* the cover lockup: the mark (the interstitial tricorn) over the
            wordmark — the sidebar's same Source Serif, at cover scale */}
        <Logo size={44} />
        <h1 className="mt-4 font-display text-5xl font-semibold tracking-tight">Silos</h1>
        <p className="mt-2.5 text-sm text-ink-2">Your agents, behind one door.</p>

        <button
          type="button"
          onClick={signIn}
          disabled={state === 'working'}
          className="mt-10 flex w-full items-center justify-center gap-2.5 rounded-xl border border-line bg-panel px-4 py-2.5 text-sm text-ink transition-colors duration-150 hover:border-ink-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta disabled:opacity-60"
        >
          <GoogleMark />
          {state === 'working' ? 'Waiting for Google…' : 'Continue with Google'}
        </button>

        {emailOpen ? (
          <form onSubmit={sendLink} className="mt-4 flex w-full gap-2">
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              aria-label="Email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-terracotta"
            />
            <button
              type="submit"
              disabled={state === 'working'}
              className="shrink-0 rounded-lg bg-ink px-3.5 text-[13px] font-medium text-canvas hover:opacity-90 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
            >
              Send link
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setEmailOpen(true)}
            className="mt-4 text-[12.5px] text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink hover:decoration-ink-2"
          >
            Use email instead
          </button>
        )}

        {error !== null ? (
          <p role="alert" className="mt-4 text-xs text-terracotta">
            {error}
          </p>
        ) : null}

        {/* a local escape hatch, documented right where it's needed: at the door */}
        <p className="mt-14 border-t border-line pt-4 font-mono text-[11px] leading-relaxed text-ink-2">
          On this machine? Open the direct link the server prints on start — <span className="text-ink">?token=…</span> skips sign-in.
        </p>
      </main>
    </div>
  )
}
