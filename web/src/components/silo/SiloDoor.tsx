// SiloDoor — the quiet door where a RECOMMENDED silo's feature would be
// while that silo is not installed: «Tasks come with the Plans silo —
// Install ›». One line in the surrounding voice, never a banner: the place
// says what is missing and the one gesture that brings it back. The door
// lands on the silo's installer (/silo/<id>/review — the review dialog, the
// only place a silo is approved), or on its page when it is installed but
// turned off. An installed silo's feature is never labelled as a silo; only
// its absence names it.
//
// Reached from: Tasks (Plans), the New agent form's «also on its own»
// (Task mode), System's Processes and Worktrees tabs (System).
import { useState } from 'react'
import { useStore } from '../../store'
import { api, ApiError } from '../../lib/api'

// Whether a silo's feature is missing: the registry has been read (a list
// never read is no evidence) and the silo is not active. Callers that
// already know from the server (Tasks' «absent») show the door directly.
export function useSiloMissing(id: string): boolean {
  const silos = useStore((s) => s.silos)
  return silos.length > 0 && !silos.some((s) => s.id === id && s.state === 'active')
}

export function SiloDoor({ silo, says, className = '' }: { silo: string; says: string; className?: string }) {
  const descriptor = useStore((s) => s.silos.find((x) => x.id === silo))
  const changePage = useStore((s) => s.changePage)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // installed but not running (turned off, in error): its page has the switch
  const onPage = descriptor !== undefined && descriptor.state !== 'pending'
  const word = onPage ? 'Open' : 'Install'

  async function go(): Promise<void> {
    if (onPage) {
      changePage({ kind: 'silo', id: silo })
      return
    }
    const review = (): void => changePage({ kind: 'silo', id: silo, review: true })
    if (descriptor?.state === 'pending') {
      review()
      return
    }
    setBusy(true)
    setError(null)
    // the manifest Silos kept at the uninstall (Reinstall…), else the
    // catalog's copy; a submission already waiting is the dialog to open
    const waiting = (e: unknown): boolean =>
      e instanceof ApiError && e.status === 409 && typeof e.body === 'object' && e.body !== null && 'submission' in e.body
    try {
      await api.silos.resubmit(silo)
      review()
    } catch (e) {
      if (waiting(e)) {
        review()
        return
      }
      try {
        await api.silos.installAvailable(silo)
        review()
      } catch (e2) {
        if (waiting(e2)) review()
        else setError('Silos could not start the install here — Settings › Silos has it.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <p data-testid={`silo-door-${silo}`} className={`text-[12.5px] leading-relaxed text-ink-2 ${className}`}>
      {says} —{' '}
      <button type="button" disabled={busy} onClick={() => void go()} className="font-medium text-terracotta hover:underline disabled:opacity-60">
        {busy ? 'Opening…' : `${word} ›`}
      </button>
      {error ? (
        <span role="alert" className="mt-0.5 block text-terracotta">
          {error}{' '}
          <button type="button" onClick={() => changePage({ kind: 'settings', tab: 'silos' })} className="underline-offset-2 hover:underline">
            Open Settings › Silos
          </button>
        </span>
      ) : null}
    </p>
  )
}
