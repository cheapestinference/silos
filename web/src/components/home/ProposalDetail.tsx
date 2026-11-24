// ProposalDetail.tsx — what an agent proposed, WHOLE, under its Needs you
// row: the owner reads all of it before the
// touch. An automation: its rhythm and brake (the server's words), its max
// runs a day, what it runs on, and the full prompt or command line — what
// will run with nobody in front is read entire. A skill: EVERY file of
// proposed/<name> with its size, each one opens here — what LOADS is
// reviewed, not only the SKILL.md. A change to a skill the project has:
// the same list, each file marked against the project's copy, a changed one
// opening as its diff. A mission: the change is drawn in
// the mission editor its «Review ›» opens; here, the new text.
import { useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import type { ProposalDiffLine, ProposalView } from '../../lib/types'

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-[12.5px] leading-snug">
      <dt className="w-[7.5rem] shrink-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  )
}

// `flush`: inside a narrow column (the conversation's) — no row indent, and
// the caller's box is the frame
export function ProposalDetail({ view, flush = false }: { view: ProposalView; flush?: boolean }) {
  return (
    <div
      className={flush ? 'mt-1.5 border-t border-line/70 pt-1.5' : 'mb-2 ml-9 max-w-[62ch] rounded-lg border border-line/70 bg-panel/50 px-3.5 py-2.5'}
      data-testid={`proposal-detail-${view.id}`}
    >
      {view.automation ? <AutomationDetail view={view} /> : view.skill ? <SkillDetail view={view} /> : view.mission ? <MissionDetail view={view} /> : null}
    </div>
  )
}

function AutomationDetail({ view }: { view: ProposalView }) {
  const a = view.automation!
  return (
    <dl className="space-y-1">
      {view.words.crosses ? <Fact label="Crosses">{view.words.crosses}</Fact> : null}
      <Fact label="Name">{a.name}</Fact>
      <Fact label="When">{view.words.brake ?? a.when}</Fact>
      {view.words.pace ? <Fact label="Its period">{view.words.pace}</Fact> : null}
      <Fact label="At most">
        {a.maxRunsPerDay} run{a.maxRunsPerDay === 1 ? '' : 's'} a day
      </Fact>
      {a.runsOn?.provider || a.runsOn?.model ? <Fact label="Runs on">{[a.runsOn.provider, a.runsOn.model].filter(Boolean).join(' · ')}</Fact> : null}
      {view.words.territoryOff ? <Fact label="Starts">{view.words.territoryOff}</Fact> : null}
      {a.command ? (
        <>
          <Fact label="Runs">
            <code className="block whitespace-pre-wrap break-all rounded bg-canvas px-1.5 py-1 font-mono text-[12px]" data-testid="proposal-command">
              {a.command}
            </code>
          </Fact>
          {a.cwd ? <Fact label="In">{a.cwd}</Fact> : null}
          {a.prompt ? <Fact label="If it fails">{a.prompt}</Fact> : null}
        </>
      ) : (
        <Fact label="Each run">
          <span className="block max-h-56 overflow-y-auto whitespace-pre-wrap" data-testid="proposal-prompt">
            {a.prompt ?? ''}
          </span>
        </Fact>
      )}
    </dl>
  )
}

// the diff with its unchanged stretches folded: CONTEXT lines around each
// change, a gap mark where lines were left out
const CONTEXT = 2
function foldDiff(diff: ProposalDiffLine[]): (ProposalDiffLine | null)[] {
  const keep = diff.map(() => false)
  diff.forEach(([t], i) => {
    if (t === ' ') return
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(diff.length - 1, i + CONTEXT); k++) keep[k] = true
  })
  const out: (ProposalDiffLine | null)[] = []
  diff.forEach((l, i) => {
    if (keep[i]) out.push(l)
    else if (out.length === 0 || out[out.length - 1] !== null) out.push(null)
  })
  return out
}

function Diff({ diff }: { diff: ProposalDiffLine[] }) {
  return (
    <div className="mt-1 max-h-72 overflow-auto rounded bg-canvas py-1.5 font-mono text-[11.5px] leading-snug" data-testid="proposal-file-diff">
      {foldDiff(diff).map((l, i) =>
        l === null ? (
          <div key={i} className="px-2 text-ink-3">
            ···
          </div>
        ) : (
          <div key={i} className={`flex gap-2 px-2 ${l[0] === '+' ? 'bg-terracotta/10 text-ink' : l[0] === '-' ? 'text-ink-3' : 'text-ink-2'}`}>
            <span className="w-2 shrink-0 select-none">{l[0] === '-' ? '−' : l[0]}</span>
            <span className={`min-w-0 whitespace-pre-wrap break-words ${l[0] === '-' ? 'line-through decoration-ink-3/60' : ''}`}>{l[1]}</span>
          </div>
        ),
      )}
    </div>
  )
}

const CHANGE_WORD = { new: 'new', changed: 'changed', same: 'unchanged' } as const

function SkillDetail({ view }: { view: ProposalView }) {
  const { files, folder, removed = [] } = view.skill!
  const [open, setOpen] = useState<{ path: string; text: string | null; diff?: ProposalDiffLine[]; loading?: true; error?: string } | null>(null)
  const read = (path: string): void => {
    if (open?.path === path) {
      setOpen(null)
      return
    }
    setOpen({ path, text: null, loading: true })
    api.proposals
      .file(view.id, path)
      .then((f) => setOpen((o) => (o?.path === path ? { path, text: f.text, ...(f.diff ? { diff: f.diff } : {}) } : o)))
      .catch((e: unknown) => setOpen((o) => (o?.path === path ? { path, text: null, error: e instanceof Error ? e.message : String(e) } : o)))
  }
  if (files === null) return <p className="text-[12.5px] text-ink-2">Its folder can't be read right now — accepting it checks it again.</p>
  const rows = [
    ...files.map((f) => ({ path: f.path, mark: f.change ? CHANGE_WORD[f.change] : null, size: f.size as number | null, gone: false })),
    ...removed.map((path) => ({ path, mark: 'removed', size: null, gone: true })),
  ]
  const touched = files.filter((f) => f.change && f.change !== 'same').length + removed.length
  return (
    <div>
      <p className="mb-1 text-[11.5px] text-ink-3">
        {folder ? (
          <>
            Replaces the skill in <span className="font-mono">{folder}</span> — {touched} of {rows.length} file{rows.length === 1 ? '' : 's'} differ
            {touched === 1 ? 's' : ''}; the copy it replaces is kept in the trash:
          </>
        ) : (
          <>
            Everything that would load — {files.length} file{files.length === 1 ? '' : 's'}:
          </>
        )}
      </p>
      <ul className="space-y-0.5" data-testid="proposal-files">
        {rows.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => read(f.path)}
              className="flex w-full items-baseline gap-3 text-left text-[12.5px] hover:text-terracotta"
              aria-expanded={open?.path === f.path}
            >
              <span
                className={`min-w-0 flex-1 truncate font-mono ${f.gone ? 'text-ink-3 line-through decoration-ink-3/60' : f.mark === 'unchanged' ? 'text-ink-2' : 'text-ink'}`}
              >
                {f.path}
              </span>
              {f.mark ? (
                <span
                  className={`shrink-0 text-[11px] ${f.mark === 'unchanged' ? 'text-ink-3' : 'text-terracotta'}`}
                  data-testid={`proposal-file-change-${f.path}`}
                >
                  {f.mark}
                </span>
              ) : null}
              {f.size !== null ? <span className="w-14 shrink-0 text-right font-mono text-[11px] text-ink-3">{size(f.size)}</span> : null}
            </button>
            {open?.path === f.path ? (
              open.diff ? (
                <Diff diff={open.diff} />
              ) : (
                <pre
                  className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1.5 font-mono text-[11.5px] leading-snug text-ink"
                  data-testid="proposal-file-text"
                >
                  {open.error ?? (open.loading ? 'Reading…' : (open.text ?? ''))}
                </pre>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function MissionDetail({ view }: { view: ProposalView }) {
  const m = view.mission!
  return (
    <div className="text-[12.5px] leading-snug">
      <p className="whitespace-pre-wrap font-display text-[14px] text-ink">{m.after.text}</p>
      {m.after.never.length > 0 ? (
        <ul className="mt-1 text-ink-2">
          {m.after.never.map((l) => (
            <li key={l}>Never: {l}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1 text-[11.5px] text-ink-3">Review opens your mission editor with the whole change.</p>
    </div>
  )
}
