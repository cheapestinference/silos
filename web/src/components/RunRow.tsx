// RunRow — one run of an automation, wherever runs are listed (the agent's
// automations facet, Board › automation › history). One component, one
// vocabulary: a run that opened a conversation is READABLE in place — the
// row opens its transcript as a window over everything (SessionModal), Esc
// and you are back — and OPENABLE as the real conversation ("Open
// conversation") when you mean to work in it (reply, console).
import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { relTime } from '../lib/rel-time'
import { runStatusLabel, resumesAtLabel, runOutcomeWord, explainRunError, commandRunLine, commandOutcome } from '../lib/automations'
import type { Run } from '../lib/types'

// the conversation a run opened — sessionKey is "folder/id"; the munged
// folder never contains '/'.
export function sessionOfRun(run: Run): { folder: string; id: string } | null {
  if (!run.sessionKey) return null
  const slash = run.sessionKey.indexOf('/')
  return slash > 0 ? { folder: run.sessionKey.slice(0, slash), id: run.sessionKey.slice(slash + 1) } : null
}

// A command run: «exit 0 ·
// 4 s · <its last line>», and its log opened in place under the row — the
// output itself, redacted of the Vault when it was written, fetched on ask.
// A failure handed to the agent says so and what that turn did, with its
// conversation one click away like any run's.
function CommandRunRow({ run, dense }: { run: Run & { command: NonNullable<Run['command']> }; dense: boolean }) {
  const readSession = useStore((s) => s.readSession)
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<{ text: string | null; error?: string } | null>(null)
  const conversation = sessionOfRun(run)
  const leg = run.command
  const line = run.handover
    ? `${commandOutcome(leg)} · handed over — ${run.status === 'failed' ? explainRunError({ error: run.error, resetsAt: run.resetsAt }).text.toLowerCase() : runOutcomeWord(run)}${run.summary ? ` · ${run.summary}` : ''}`
    : commandRunLine(leg)
  async function toggle(): Promise<void> {
    const next = !open
    setOpen(next)
    if (!next || log) return
    try {
      setLog({ text: await api.automations.runLog(run.automationId, run.id) })
    } catch (e) {
      setLog({ text: null, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <li data-testid="run-row" data-command-run="" className={dense ? 'px-2 py-1 text-xs' : 'border-b border-line px-3 py-2 text-sm'}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void toggle()}
          aria-expanded={open}
          title={open ? 'Hide its output' : 'Show its output'}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
        >
          <span
            data-testid="command-run-line"
            className={`min-w-0 truncate font-mono text-[12px] tabular-nums ${run.status === 'failed' ? 'text-terracotta' : 'text-ink'}`}
            title={line}
          >
            {line}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {conversation ? (
            <button
              type="button"
              onClick={() => readSession(conversation.folder, conversation.id)}
              className="rounded-md px-1.5 py-0.5 text-xs text-ink-2 hover:bg-canvas hover:text-terracotta"
            >
              Read the hand-over
            </button>
          ) : null}
          <button
            type="button"
            data-testid="command-run-log-toggle"
            onClick={() => void toggle()}
            aria-expanded={open}
            className="rounded-md px-1.5 py-0.5 text-xs text-ink-2 hover:bg-canvas hover:text-terracotta"
          >
            {open ? 'Hide log' : 'Log'}
          </button>
          <span className="text-xs text-ink-2">{relTime(Date.parse(run.at))}</span>
        </div>
      </div>
      {open ? (
        <div className="mt-1.5" data-testid="command-run-log">
          {log === null ? (
            <p className="text-xs text-ink-2">Reading the log…</p>
          ) : log.error ? (
            <p className="text-xs text-terracotta">Couldn’t read the log: {log.error}</p>
          ) : log.text === null || log.text === '' ? (
            <p className="text-xs text-ink-2">{log.text === '' ? 'It printed nothing.' : 'This run left no log.'}</p>
          ) : (
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-ink">
              {log.text}
            </pre>
          )}
        </div>
      ) : null}
    </li>
  )
}

export function RunRow({ run, dense = false }: { run: Run; dense?: boolean }) {
  if (run.command) return <CommandRunRow run={run as Run & { command: NonNullable<Run['command']> }} dense={dense} />
  return <AgentRunRow run={run} dense={dense} />
}

function AgentRunRow({ run, dense }: { run: Run; dense: boolean }) {
  const readSession = useStore((s) => s.readSession)
  const openSession = useStore((s) => s.openSession)
  const conversation = sessionOfRun(run)
  const dur = run.durationMs !== undefined ? `${Math.round(run.durationMs / 1000)}s` : null
  // the row leads with what the run DID — acted / no news / the failure in
  // plain words — then the agent's one sentence; the raw error rides the title.
  const failure = run.status === 'failed' ? explainRunError(run) : null
  const lead = failure ? (
    <span className="min-w-0 truncate text-terracotta md:shrink-0" title={run.error}>
      {failure.text}
      {failure.retry ? <span className="text-ink-2"> · {failure.retry}</span> : null}
    </span>
  ) : run.status === 'ok' && run.outcome === 'acted' ? (
    <span className="shrink-0 font-medium text-ink">acted</span>
  ) : run.status === 'ok' && run.outcome === 'nothing' ? (
    <span className="shrink-0 text-ink-2">no news</span>
  ) : (
    <span className="shrink-0 text-ink">{runStatusLabel(run.status)}</span>
  )
  const resumes = resumesAtLabel(run)
  const detail =
    run.status === 'waiting_reset' && resumes ? (
      <span className="shrink-0 text-xs text-ink-2">{resumes}</span>
    ) : run.status === 'skipped' && run.reason ? (
      <span className="min-w-0 truncate text-xs text-ink-2" title={run.reason}>
        · {run.reason}
      </span>
    ) : null
  // a failed run says its failure as the lead; the sentence is for runs
  // that got to say something.
  const sentence = run.summary && run.status !== 'failed' ? run.summary : null
  const body = (
    <div className="flex min-w-0 items-baseline gap-1.5">
      {lead}
      {detail}
      {sentence ? (
        <span className="min-w-0 truncate text-xs text-ink-2" title={sentence}>
          {sentence}
        </span>
      ) : null}
    </div>
  )
  return (
    <li
      data-testid="run-row"
      // a phone: what the run did on its own line, the door and the times
      // under it — one line had them drawn over each other
      className={`flex flex-col gap-0.5 md:flex-row md:items-center md:justify-between md:gap-2 ${dense ? 'px-2 py-1 text-xs' : 'border-b border-line px-3 py-2 text-sm'} ${conversation ? 'group/run rounded hover:bg-panel' : ''}`}
    >
      {conversation ? (
        <button
          type="button"
          onClick={() => readSession(conversation.folder, conversation.id)}
          aria-label={`Read the conversation of this run (${failure ? failure.text : runOutcomeWord(run)}, ${relTime(Date.parse(run.at))})`}
          title="Read the conversation"
          className="min-w-0 text-left md:flex-1"
        >
          {body}
        </button>
      ) : (
        <div className="min-w-0 md:flex-1">{body}</div>
      )}
      <div className="flex shrink-0 items-center gap-2">
        {conversation ? (
          <button
            type="button"
            onClick={() => void openSession(conversation.folder, conversation.id, { exact: true })}
            className="rounded-md px-1.5 py-0.5 text-xs text-ink-2 opacity-70 hover:bg-canvas hover:text-terracotta group-hover/run:opacity-100 max-md:-ml-1.5"
          >
            Open conversation
          </button>
        ) : null}
        {dur ? <span className="text-xs tabular-nums text-ink-2">{dur}</span> : null}
        <span className="text-xs text-ink-2">{relTime(Date.parse(run.at))}</span>
      </div>
    </li>
  )
}
