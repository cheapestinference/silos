// ProposalDetail.tsx — what an agent proposed, WHOLE, under its Needs you
// row: the owner reads all of it before the
// touch. An automation: its rhythm and brake (the server's words), its max
// runs a day, what it runs on, and the full prompt or command line — what
// will run with nobody in front is read entire. A skill: EVERY file of
// proposed/<name> with its size, each one opens here — what LOADS is
// reviewed, not only the SKILL.md. A mission: the change is drawn in
// the mission editor its «Review ›» opens; here, the new text.
import { useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import type { ProposalView } from '../../lib/types'

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-[12.5px] leading-snug">
      <dt className="w-[7.5rem] shrink-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  )
}

export function ProposalDetail({ view }: { view: ProposalView }) {
  return (
    <div className="mb-2 ml-9 max-w-[62ch] rounded-lg border border-line/70 bg-panel/50 px-3.5 py-2.5" data-testid={`proposal-detail-${view.id}`}>
      {view.automation ? <AutomationDetail view={view} /> : view.skill ? <SkillDetail view={view} /> : view.mission ? <MissionDetail view={view} /> : null}
    </div>
  )
}

function AutomationDetail({ view }: { view: ProposalView }) {
  const a = view.automation!
  return (
    <dl className="space-y-1">
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

function SkillDetail({ view }: { view: ProposalView }) {
  const files = view.skill!.files
  const [open, setOpen] = useState<{ path: string; text: string | null; error?: string } | null>(null)
  const read = (path: string): void => {
    if (open?.path === path) {
      setOpen(null)
      return
    }
    setOpen({ path, text: null })
    api.proposals
      .file(view.id, path)
      .then((text) => setOpen((o) => (o?.path === path ? { path, text } : o)))
      .catch((e: unknown) => setOpen((o) => (o?.path === path ? { path, text: null, error: e instanceof Error ? e.message : String(e) } : o)))
  }
  if (files === null) return <p className="text-[12.5px] text-ink-2">Its folder can't be read right now — accepting it checks it again.</p>
  return (
    <div>
      <p className="mb-1 text-[11.5px] text-ink-3">
        Everything that would load — {files.length} file{files.length === 1 ? '' : 's'}:
      </p>
      <ul className="space-y-0.5" data-testid="proposal-files">
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => read(f.path)}
              className="flex w-full items-baseline gap-3 text-left text-[12.5px] hover:text-terracotta"
              aria-expanded={open?.path === f.path}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-ink">{f.path}</span>
              <span className="shrink-0 font-mono text-[11px] text-ink-3">{size(f.size)}</span>
            </button>
            {open?.path === f.path ? (
              <pre
                className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1.5 font-mono text-[11.5px] leading-snug text-ink"
                data-testid="proposal-file-text"
              >
                {open.error ?? open.text ?? 'Reading…'}
              </pre>
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
