// «Pair this browser»: nobody is the owner by
// default any more, so a browser with no credential is UNKNOWN — it may
// look, never write. The door says the two true gestures, in every phase:
// open the link the server prints at start (its ?token= is the pairing),
// or paste the token from ~/.silos/token here. Once per browser profile.
// The house's door language, as LoginView: the lockup, one sentence, one action.
import { useState, type FormEvent } from 'react'
import { storeToken } from '../lib/api'
import { fetchWho } from '../lib/auth'
import { Logo } from './Logo'

export function PairView({ onPaired }: { onPaired: () => void }) {
  const [value, setValue] = useState('')
  const [state, setState] = useState<'idle' | 'checking'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function pair(e: FormEvent): Promise<void> {
    e.preventDefault()
    const token = value.trim()
    if (token === '') return
    setState('checking')
    setError(null)
    try {
      const who = await fetchWho(token)
      if (who !== 'owner') {
        setError('That is not the token in ~/.silos/token of this Silos.')
        setState('idle')
        return
      }
      storeToken(token)
      onPaired()
    } catch {
      setError('Silos did not answer. Is the server running?')
      setState('idle')
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-canvas px-6 text-ink">
      <main className="flex w-full max-w-sm flex-col items-center text-center">
        <Logo size={44} />
        <h1 className="mt-4 font-display text-5xl font-semibold tracking-tight">Silos</h1>
        <h2 className="mt-8 text-base font-medium">Pair this browser</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          Open the link the server prints at start, or paste the token from <span className="font-mono text-[13px] text-ink">~/.silos/token</span>.
        </p>

        <form onSubmit={(e) => void pair(e)} className="mt-8 flex w-full flex-col gap-2.5">
          <label htmlFor="pair-token" className="sr-only">
            Token from ~/.silos/token
          </label>
          <input
            id="pair-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste the token"
            className="w-full rounded-xl border border-line bg-panel px-4 py-2.5 font-mono text-sm text-ink placeholder:font-sans placeholder:text-ink-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
          />
          <button
            type="submit"
            disabled={state === 'checking' || value.trim() === ''}
            className="w-full rounded-xl border border-line bg-panel px-4 py-2.5 text-sm text-ink transition-colors duration-150 hover:border-ink-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta disabled:opacity-60"
          >
            {state === 'checking' ? 'Pairing…' : 'Pair this browser'}
          </button>
        </form>

        {error !== null ? (
          <p role="alert" className="mt-4 text-xs text-terracotta">
            {error}
          </p>
        ) : null}
      </main>
    </div>
  )
}
