// EngineSignIn.tsx — an engine's OWN sign-in by link, from Silos (descriptor
// ui.signIn — a ChatGPT Plus/Pro subscription on OpenCode today). What can
// be signed in to is the engine's answer; one gesture per option, then two
// calm steps in the house's sign-in look (ClaudeSignIn's): open the
// provider's page, enter the one-time code there — and Silos waits, saying
// so, until the engine says it landed (or why not). The engine writes its
// own login; Silos only shows its link and its code.
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { api } from '../lib/api'
import type { EngineSignInOption, HarnessDescriptor } from '../lib/types'

const POLL_MS = 2000
// «Enter code: ABCD-1234» → the code itself, shown large; else the line as is
const codeOf = (instructions: string): string | null => /code:\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(instructions)?.[1] ?? null

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting'; option: EngineSignInOption }
  | { kind: 'waiting'; option: EngineSignInOption; id: string; url: string; instructions: string }
  | { kind: 'done'; option: EngineSignInOption }
  | { kind: 'failed'; option: EngineSignInOption; error: string }

export function EngineSignIn({ d, onSignedIn }: { d: HarnessDescriptor; onSignedIn: (provider: string | null) => void }) {
  const [options, setOptions] = useState<EngineSignInOption[] | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [copied, setCopied] = useState<'link' | 'code' | null>(null)
  const done = useRef(onSignedIn)
  done.current = onSignedIn

  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(() => api.providers.signInOptions(d))
      .then((o) => {
        if (alive) setOptions(o ?? [])
      })
      .catch(() => {
        if (alive) setOptions([])
      })
    return () => {
      alive = false
    }
  }, [d])

  // waiting: ask the engine until it says the sign-in landed, or why not
  useEffect(() => {
    if (phase.kind !== 'waiting') return
    let stopped = false
    const t = window.setInterval(() => {
      void api.providers
        .signInStatus(d, phase.id)
        .then((st) => {
          if (stopped) return
          if (st.state === 'done') {
            setPhase({ kind: 'done', option: phase.option })
            done.current(st.provider ?? null)
          } else if (st.state === 'failed') setPhase({ kind: 'failed', option: phase.option, error: st.error })
        })
        .catch((e: unknown) => {
          if (!stopped) setPhase({ kind: 'failed', option: phase.option, error: e instanceof Error ? e.message : String(e) })
        })
    }, POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(t)
    }
  }, [d, phase])

  // leaving mid-way ends the engine's attempt
  useEffect(
    () => () => {
      if (phase.kind === 'waiting') void api.providers.signInCancel(d, phase.id).catch(() => undefined)
    },
    [d, phase],
  )

  async function start(option: EngineSignInOption): Promise<void> {
    setPhase({ kind: 'starting', option })
    try {
      const a = await api.providers.signInStart(d, option.providerId)
      setPhase({ kind: 'waiting', option, id: a.id, url: a.url, instructions: a.instructions })
    } catch (e) {
      setPhase({ kind: 'failed', option, error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function copy(what: 'link' | 'code', text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      /* the text is on screen */
    }
  }

  // the engine is asked first (a fresh install's first ask can take a while)
  if (options === null)
    return (
      <p className="text-xs text-ink-3" data-testid="engine-sign-in" role="status">
        Asking {d.label} what it can sign in to…
      </p>
    )
  if (options.length === 0) return null

  if (phase.kind === 'idle' || phase.kind === 'starting') {
    return (
      <div className="flex flex-col gap-2" data-testid="engine-sign-in">
        {options.map((o) => (
          <button
            key={o.providerId}
            type="button"
            disabled={phase.kind === 'starting'}
            onClick={() => void start(o)}
            className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-left hover:border-ink-2 disabled:opacity-60"
          >
            <span className="min-w-0">
              <span className="block text-[13.5px] text-ink">Sign in with {o.label}</span>
              <span className="block text-xs text-ink-2">
                {o.name} — your subscription, through {d.label}’s own sign-in
              </span>
            </span>
            <span className="shrink-0 text-xs text-ink-2">
              {phase.kind === 'starting' && phase.option.providerId === o.providerId ? 'Starting…' : 'Sign in ›'}
            </span>
          </button>
        ))}
      </div>
    )
  }

  if (phase.kind === 'done') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-panel px-3 py-2.5 text-sm text-ink" role="status" data-testid="engine-sign-in">
        <Check size={14} aria-hidden="true" className="shrink-0 text-terracotta" />
        Signed in to {phase.option.name} — {phase.option.label}
      </div>
    )
  }

  const step = 'flex gap-3'
  const dot = 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-medium text-canvas'
  return (
    <div className="flex flex-col gap-4 rounded-lg bg-panel p-3.5" data-testid="engine-sign-in">
      {phase.kind === 'failed' ? (
        <p role="alert" className="text-xs text-terracotta">
          {phase.error}
        </p>
      ) : (
        <>
          <div className={step}>
            <span className={dot} aria-hidden="true">
              1
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">Open {phase.option.name}’s sign-in page</p>
              <p className="mt-0.5 text-xs text-ink-2">Sign in with the {phase.option.label} subscription your agents will use.</p>
              <div className="mt-2 flex items-center gap-2">
                <a
                  href={phase.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90"
                >
                  Open sign-in page <ExternalLink size={11} aria-hidden="true" />
                </a>
                <button
                  type="button"
                  onClick={() => void copy('link', phase.url)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-3 py-1.5 text-xs font-medium text-ink hover:border-ink-2"
                >
                  {copied === 'link' ? <Check size={11} aria-hidden="true" className="text-terracotta" /> : <Copy size={11} aria-hidden="true" />}
                  {copied === 'link' ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </div>
          </div>
          <div className={step}>
            <span className={dot} aria-hidden="true">
              2
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">Enter this code there</p>
              {codeOf(phase.instructions) ? (
                <div className="mt-2 flex items-center gap-2">
                  <code className="rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-[15px] tracking-wider text-ink select-all">
                    {codeOf(phase.instructions)}
                  </code>
                  <button
                    type="button"
                    aria-label="copy the code"
                    onClick={() => void copy('code', codeOf(phase.instructions)!)}
                    className="rounded p-1 text-ink-2 hover:text-ink"
                  >
                    {copied === 'code' ? <Check size={13} aria-hidden="true" className="text-terracotta" /> : <Copy size={13} aria-hidden="true" />}
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-xs text-ink-2">{phase.instructions}</p>
              )}
              <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-2" role="status">
                <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-terracotta motion-reduce:animate-none" />
                Waiting for you to finish at {phase.option.name}…
              </p>
            </div>
          </div>
        </>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-line pt-2.5">
        {phase.kind === 'failed' ? (
          <button type="button" onClick={() => void start(phase.option)} className="text-xs font-medium text-terracotta hover:opacity-80">
            Start again
          </button>
        ) : (
          <span />
        )}
        <button type="button" onClick={() => setPhase({ kind: 'idle' })} className="text-xs text-ink-2 hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  )
}
