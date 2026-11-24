// ClaudeSignIn.tsx — signing in to an extra Claude account without leaving
// Silos. It is Claude's OWN sign-in: the server runs the
// unmodified `claude auth login` under the account's CLAUDE_CONFIG_DIR in a
// PTY (TerminalService.openAccountLogin) and this block is a calm face on
// that process, in two steps:
//   1. open Claude's page — the link Claude printed (Open, or Copy link to
//      take it to another browser);
//   2. paste the code Claude's page shows — the field types it at Claude's
//      own prompt (the binary does not echo, so a raw terminal showed
//      nothing) and the block says what Claude answered: checking, its
//      refusal in its own words, or signed in.
// Claude's raw output stays one click away ("Show Claude's output"). Silos
// keeps nothing: the code goes to Claude's stdin and is cleared, the token
// only ever lives where Claude keeps it; verify asks Claude (`claude auth
// status`) until it says the account is in.
//
// Reached from the Run on panel (a "not logged in" account, "Add a Claude
// account") and Settings › Accounts & providers — the moment is Direct: the
// conversation must be able to run — and from the first run's «Runs on»
// step for the machine's own account ('default'), only while it is signed
// out.
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { api, getToken } from '../lib/api'
import { claudeReply, isRejection, plainText, signInLink } from '../lib/claude-sign-in'
import type { ClaudeAccountView } from '../lib/types'

type Phase = { kind: 'starting' } | { kind: 'open'; id: string } | { kind: 'ended' } | { kind: 'error'; message: string }
// what happened to the pasted code
// `stalled`: Claude said nothing for CHECK_MS after the code — never a
// «Checking…» that waits forever
type Code = { kind: 'idle' } | { kind: 'checking'; from: number } | { kind: 'rejected'; reply: string } | { kind: 'stalled' }
const CHECK_MS = 30_000

const POLL_MS = 1500

export function ClaudeSignIn({ account, onSignedIn, onCancel }: { account: string; onSignedIn: (view: ClaudeAccountView) => void; onCancel: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
  const [attempt, setAttempt] = useState(0)
  const [raw, setRaw] = useState('')
  const [code, setCode] = useState('')
  const [codeState, setCodeState] = useState<Code>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const [showOutput, setShowOutput] = useState(false)
  const [signedIn, setSignedIn] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const done = useRef(false)
  const doneCb = useRef(onSignedIn)
  doneCb.current = onSignedIn

  // open (or rejoin — one per account) Claude's sign-in and read what it prints
  useEffect(() => {
    let cancelled = false
    let id: string | null = null
    setPhase({ kind: 'starting' })
    setRaw('')
    setCodeState({ kind: 'idle' })
    api.accounts
      .login(account)
      .then(({ terminal }) => {
        id = terminal.id
        if (cancelled) {
          void api.terminals.kill(terminal.id).catch(() => undefined)
          return
        }
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const ws = new WebSocket(`${proto}://${window.location.host}/ws/terminal/${terminal.id}?${new URLSearchParams({ token: getToken() }).toString()}`)
        wsRef.current = ws
        ws.addEventListener('message', (ev: MessageEvent) => setRaw((r) => (r + String(ev.data)).slice(-64 * 1024)))
        // Claude exited (signed in, or quit): the last look below decides
        ws.addEventListener('close', () => {
          if (!cancelled) setPhase({ kind: 'ended' })
        })
        setPhase({ kind: 'open', id: terminal.id })
      })
      .catch((e: unknown) => {
        if (!cancelled) setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
      wsRef.current?.close()
      wsRef.current = null
      // leaving before Claude finished: end its sign-in
      if (id !== null && !done.current) void api.terminals.kill(id).catch(() => undefined)
    }
  }, [account, attempt])

  // the login is there when Claude says so (verify → `claude auth status`)
  useEffect(() => {
    if (phase.kind !== 'open' && phase.kind !== 'ended') return
    let stopped = false
    const check = async (): Promise<void> => {
      try {
        const view = await api.accounts.verify(account)
        if (view.loggedIn && !stopped && !done.current) {
          done.current = true
          setSignedIn(view.email ?? account)
          // a beat on the confirmation before the host moves on
          window.setTimeout(() => doneCb.current(view), 900)
        }
      } catch {
        /* a blip: the next tick asks again */
      }
    }
    if (phase.kind === 'ended') {
      void check()
      return () => {
        stopped = true
      }
    }
    const t = window.setInterval(() => void check(), POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(t)
    }
  }, [account, phase])

  // Claude's answer to the pasted code
  useEffect(() => {
    if (codeState.kind !== 'checking') return
    const reply = claudeReply(raw, codeState.from)
    if (isRejection(reply)) setCodeState({ kind: 'rejected', reply: reply! })
  }, [raw, codeState])

  // no answer in time: said, with the way out
  useEffect(() => {
    if (codeState.kind !== 'checking') return
    const t = window.setTimeout(() => setCodeState((c) => (c.kind === 'checking' ? { kind: 'stalled' } : c)), CHECK_MS)
    return () => window.clearTimeout(t)
  }, [codeState])

  const link = signInLink(raw)
  const ended = phase.kind === 'ended' && signedIn === null
  // Claude ends its sign-in after a code it refuses (one process, one try):
  // its own words stay on screen, never replaced by «closed»
  const answer = codeState.kind === 'rejected' ? codeState.reply : codeState.kind === 'checking' ? claudeReply(raw, codeState.from) : null

  function submit(): void {
    const ws = wsRef.current
    const value = code.trim()
    if (!ws || ws.readyState !== WebSocket.OPEN || value === '') return
    setCodeState({ kind: 'checking', from: raw.length })
    // as typed keys, then Enter on its own (a trailing \r inside a paste is
    // not a submit for an Ink prompt)
    ws.send(JSON.stringify({ op: 'write', data: value }))
    window.setTimeout(() => ws.send(JSON.stringify({ op: 'write', data: '\r' })), 120)
    setCode('')
  }

  async function copyLink(): Promise<void> {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      // no clipboard (an http origin): the link is selectable below
      setShowOutput(true)
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  if (signedIn !== null) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-panel px-3 py-2.5 text-sm text-ink" role="status" data-testid="claude-sign-in">
        <Check size={14} aria-hidden="true" className="shrink-0 text-terracotta" />
        <span className="min-w-0 truncate">
          Signed in as <span className="font-medium">{signedIn}</span>
        </span>
      </div>
    )
  }

  const step = 'flex gap-3'
  const dot = (on: boolean) =>
    `mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${on ? 'bg-ink text-canvas' : 'border border-line text-ink-3'}`

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-panel p-3.5" data-testid="claude-sign-in">
      {phase.kind === 'error' ? (
        <p className="text-xs text-terracotta">{phase.message}</p>
      ) : ended ? (
        answer ? (
          <div role="alert">
            <p className="text-xs text-terracotta">Claude says: {answer}</p>
            <p className="mt-1 text-xs text-ink-2">That code can&rsquo;t be used again — start again for a new sign-in link.</p>
          </div>
        ) : (
          <p className="text-xs text-ink-2">Claude&rsquo;s sign-in closed before the login landed — start again for a new link.</p>
        )
      ) : (
        <>
          <div className={step}>
            <span className={dot(true)} aria-hidden="true">
              1
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">Open Claude&rsquo;s sign-in page</p>
              <p className="mt-0.5 text-xs text-ink-2">
                {account === 'default' ? (
                  'Sign in with the Claude subscription your agents will use.'
                ) : (
                  <>
                    Sign in with the subscription you want for <span className="font-medium text-ink">{account}</span>.
                  </>
                )}
              </p>
              <div className="mt-2 flex items-center gap-2">
                {link ? (
                  <>
                    <a
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90"
                    >
                      Open sign-in page
                      <ExternalLink size={11} aria-hidden="true" />
                    </a>
                    <button
                      type="button"
                      onClick={() => void copyLink()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-3 py-1.5 text-xs font-medium text-ink hover:border-ink-2"
                    >
                      {copied ? <Check size={11} aria-hidden="true" className="text-terracotta" /> : <Copy size={11} aria-hidden="true" />}
                      {copied ? 'Copied' : 'Copy link'}
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-ink-3">Waiting for Claude&rsquo;s link…</span>
                )}
              </div>
            </div>
          </div>

          <div className={step}>
            <span className={dot(link !== null)} aria-hidden="true">
              2
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-sm ${link ? 'text-ink' : 'text-ink-3'}`}>Paste the code Claude shows you</p>
              <form
                className="mt-2 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  submit()
                }}
              >
                <input
                  type="text"
                  aria-label="code from Claude"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={link === null || codeState.kind === 'checking'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="code from Claude’s page"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-xs text-ink outline-none focus:border-terracotta disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={link === null || code.trim() === '' || codeState.kind === 'checking'}
                  className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-40"
                >
                  Sign in
                </button>
              </form>
              {codeState.kind === 'checking' ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-2" role="status">
                  <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-terracotta motion-reduce:animate-none" />
                  Checking the code with Claude…
                </p>
              ) : codeState.kind === 'rejected' ? (
                <p className="mt-1.5 text-xs text-terracotta" role="alert">
                  Claude says: {codeState.reply}
                </p>
              ) : codeState.kind === 'stalled' ? (
                <p className="mt-1.5 text-xs text-terracotta" role="alert">
                  Claude hasn&rsquo;t answered — start again for a new sign-in link.
                </p>
              ) : null}
            </div>
          </div>
        </>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-line pt-2.5">
        {ended || phase.kind === 'error' || codeState.kind === 'stalled' ? (
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="text-xs font-medium text-terracotta hover:opacity-80">
            Start again
          </button>
        ) : (
          <button type="button" onClick={() => setShowOutput((v) => !v)} aria-expanded={showOutput} className="text-[11px] text-ink-3 hover:text-ink-2">
            {showOutput ? 'Hide Claude’s output' : 'Show Claude’s output'}
          </button>
        )}
        <button type="button" onClick={onCancel} className="text-xs text-ink-2 hover:text-ink">
          Cancel
        </button>
      </div>
      {showOutput ? (
        <pre className="-mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-md bg-canvas p-2 font-mono text-[10.5px] leading-relaxed text-ink-2 select-text">
          {plainText(raw).trim() || '…'}
        </pre>
      ) : null}
    </div>
  )
}
