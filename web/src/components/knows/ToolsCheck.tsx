// ToolsCheck — «Check now» in the head of a project's Tools, and «See what
// it sends ›» on a Claude account that is off here with nothing to list
// (server loads-check.ts). The owner's click, and only that: the button
// names the login it starts Claude on and says what that costs; while it
// runs the seconds tick and the line says what it is doing (proof of
// life); after, when it last ran and what it found. The rows below read
// the new reading (the caller reloads them).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../../lib/api'
import type { FolderLoads, LoadsCheckAnswer, LoadsCheckStatus, LoadsCheckTarget } from '../../lib/types'
import { lastWords, loginName, runningWords, sendsOffers, sendsWords } from '../../lib/loads-check-view'
import { relTime } from '../../lib/rel-time'
import { OwnerLabel } from '../OwnerLabel'
import { ownerOriginText } from '../../lib/owners'

export interface LoadsCheckState {
  status: LoadsCheckStatus | null
  /** the check running now (this tab's or another's), with its seconds */
  running: { provider: string; withoutLocal: boolean; seconds: number } | null
  error: { provider: string; text: string } | null
  /** «See what it sends»'s answers, per login, this visit */
  sent: Record<string, LoadsCheckAnswer>
  run(t: LoadsCheckTarget, withoutLocal?: boolean): void
}

/** `agent`: an agent's page — its login only, and a check started as it. */
export function useLoadsCheck(folder: string | null, onDone: () => void, agent?: string): LoadsCheckState {
  const [status, setStatus] = useState<LoadsCheckStatus | null>(null)
  const [mine, setMine] = useState<{ provider: string; withoutLocal: boolean; startedAt: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<LoadsCheckState['error']>(null)
  const [sent, setSent] = useState<Record<string, LoadsCheckAnswer>>({})
  const done = useRef(onDone)
  done.current = onDone
  const refresh = useCallback(() => {
    if (!folder) return
    api.folders.loadsCheck(folder, agent).then(setStatus, () => setStatus(null))
  }, [folder, agent])
  useEffect(() => {
    refresh()
  }, [refresh])
  const active = mine ?? status?.running ?? null
  // the seconds tick while one runs; another tab's check is followed until it ends
  useEffect(() => {
    if (!active) return
    const tick = setInterval(() => setNow(Date.now()), 500)
    const follow = mine ? null : setInterval(refresh, 2000)
    return () => {
      clearInterval(tick)
      if (follow) clearInterval(follow)
    }
  }, [active, mine, refresh])
  const run = useCallback(
    (t: LoadsCheckTarget, withoutLocal = false) => {
      if (!folder || mine) return
      const startedAt = Date.now()
      setMine({ provider: t.provider, withoutLocal, startedAt })
      setNow(startedAt)
      setError(null)
      api.folders
        .runLoadsCheck(folder, t.provider, withoutLocal, agent)
        .then(
          (a) => {
            if (withoutLocal) setSent((s) => ({ ...s, [t.provider]: a }))
          },
          (err: unknown) => {
            setError({ provider: t.provider, text: err instanceof Error ? err.message : String(err) })
          },
        )
        .finally(() => {
          setMine(null)
          refresh()
          done.current()
        })
    },
    [folder, mine, refresh, agent],
  )
  return {
    status,
    error,
    sent,
    run,
    running: active
      ? { provider: active.provider, withoutLocal: active.withoutLocal, seconds: Math.max(0, Math.floor((now - active.startedAt) / 1000)) }
      : null,
  }
}

/** The tab's head: one line per login the folder's agents run on. */
// `agentName`: on an agent's page — the check starts as its conversations do
export function CheckHead({ check, agentName }: { check: LoadsCheckState; agentName?: string }) {
  const now = Date.now()
  const targets = check.status?.targets ?? []
  if (targets.length === 0) return null
  return (
    <div className="space-y-1.5 rounded-md border border-line/80 bg-canvas/50 px-2.5 py-2" data-testid="loads-check">
      {targets.map((t) => {
        const runningHere = check.running?.provider === t.provider && !check.running.withoutLocal
        const busy = check.running !== null
        const err = check.error?.provider === t.provider ? check.error.text : null
        return (
          <div key={t.provider} className="min-w-0">
            <div className="flex min-w-0 items-center gap-2.5">
              <button
                type="button"
                data-check-now
                disabled={busy}
                onClick={() => check.run(t)}
                aria-busy={runningHere}
                title={`Starts Claude in this folder on ${loginName(t)}${agentName ? ` as ${agentName}’s conversations start — with its own switches` : ''} with no prompt, reads every server once, then closes it`}
                className={`flex max-w-full shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11.5px] transition-colors ${runningHere ? 'border-terracotta/60 text-terracotta' : 'border-line text-ink hover:border-terracotta hover:text-terracotta disabled:text-ink-3 disabled:hover:border-line'}`}
              >
                <RefreshCw size={11} aria-hidden="true" className={`shrink-0 ${runningHere ? 'animate-spin motion-reduce:animate-none' : ''}`} />
                <span className="shrink-0">{runningHere ? 'Checking' : 'Check now'}</span>
                <span className={`truncate ${runningHere ? 'text-terracotta/80' : 'text-ink-3'}`}>· {loginName(t)}</span>
              </button>
              {t.cost ? (
                <span className="ml-auto min-w-0 truncate text-right text-[10.5px] text-ink-3" title={t.cost}>
                  {t.cost}
                </span>
              ) : null}
            </div>
            <p className="mt-1 min-w-0 pl-1 text-[11px] leading-snug" role="status" aria-live="polite">
              {runningHere ? (
                <span className="text-ink-2">
                  <span className="font-mono tabular-nums text-terracotta">{check.running!.seconds} s</span> · {runningWords(check.running!.seconds, false)}
                </span>
              ) : err ? (
                <span className="text-[var(--health-red)]">{err}</span>
              ) : (
                <span className={t.last?.counts?.failed ? 'text-ink-2' : 'text-ink-3'}>{lastWords(t, now)}</span>
              )}
            </p>
          </div>
        )
      })}
    </div>
  )
}

/** An account group that is off here with nothing to list: its header, in
 *  the owner groups' own grammar, with the connectors' head (`head`), and
 *  «See what it sends ›». */
export function SendsOffers({ check, loads, head }: { check: LoadsCheckState; loads: FolderLoads | null; head?: ReactNode }) {
  const offers = sendsOffers(check.status?.targets ?? [], loads)
  if (offers.length === 0) return null
  return (
    <>
      {offers.map((t) => (
        <section key={t.provider} aria-label={ownerOriginText('account', { accountName: loginName(t) })} data-testid="sends-offer">
          <div className="flex items-baseline gap-1.5 px-4 pb-1.5 pt-3">
            <OwnerLabel owner="account" ctx={{ accountName: loginName(t) }} size="sm" className="min-w-0 shrink font-medium" from />
            <span className="min-w-0 truncate text-[11px] text-ink-3">· connectors off in this project</span>
            {head}
          </div>
          <SendsLine check={check} target={t} />
        </section>
      ))}
    </>
  )
}

/** The target of «See what it sends» for a login whose connectors are off
 *  here (its account sends; this folder doesn't fetch). */
export function sendsTargetOf(check: LoadsCheckState, login: string | null): LoadsCheckTarget | undefined {
  return (check.status?.targets ?? []).find((t) => t.account && !t.sendsHere && (t.login === null || t.login === login))
}

/** What a login whose connectors are off here sends, as far as it is known
 *  — and «See what it sends ›»: the check without the local layer. */
export function SendsLine({ check, target: t }: { check: LoadsCheckState; target: LoadsCheckTarget }) {
  const now = Date.now()
  const runningHere = check.running?.provider === t.provider && check.running.withoutLocal
  const answer = check.sent[t.provider]
  const list = answer?.connectors ?? t.sends?.connectors ?? null
  const at = answer?.at ?? t.sends?.at
  const err = check.error?.provider === t.provider ? check.error.text : null
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-4 pb-1 pl-[34px] text-[11.5px] leading-snug" data-testid="sends-line">
        {runningHere ? (
          <span className="text-ink-2" role="status" aria-live="polite">
            <span className="font-mono tabular-nums text-terracotta">{check.running!.seconds} s</span> · {runningWords(check.running!.seconds, true)}
          </span>
        ) : err ? (
          <span className="text-[var(--health-red)]">{err}</span>
        ) : answer && answer.connectors === null ? (
          <span className="text-ink-2">Its connectors are off for this login everywhere — nothing to list.</span>
        ) : list ? (
          <span className="text-ink-2">
            {sendsWords(list)}
            {at ? <span className="text-ink-3"> · read {relTime(at, now)}</span> : null}
          </span>
        ) : (
          <span className="text-ink-2">Nothing listed — this project doesn’t fetch what your Claude account sends.</span>
        )}
        {!runningHere ? (
          <button
            type="button"
            disabled={check.running !== null}
            onClick={() => check.run(t, true)}
            title={`Starts Claude on ${loginName(t)} without this project’s local settings, lists what the account sends, then closes it — nothing is written to the folder`}
            className="shrink-0 text-[11px] text-ink-2 hover:text-terracotta disabled:text-ink-3"
          >
            {list ? 'See again ›' : 'See what it sends ›'}
          </button>
        ) : null}
      </div>
      {!runningHere && !list && t.cost ? <p className="px-4 pl-[34px] text-[11px] text-ink-3">{t.cost} · nothing is written to the folder</p> : null}
    </>
  )
}
