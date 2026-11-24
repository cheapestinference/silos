// WriteInstructions — «+ Write instructions» on Project › Memory and Agent ›
// Memory (spec memory-places §5, T3): the first half of the owner's ask —
// what you WRITE for a place. A picker of the fixed places the server lists
// (GET /api/memory `places`), each naming its file and whom it reaches; an
// existing file opens in its row's editor instead. Nothing else is written
// by the click, with the one exception the option itself says: the ignore
// line for CLAUDE.local.md, offered only where `<folder>/.git` is a
// directory (the server sends `ignoreLine` only then; `ignoreElsewhere`
// says to keep it out of commits by hand). The machine's files say their
// reach on Save and ask first (MachineSaveConfirm). One conversation has no
// file: it is told in its composer.
import { useState } from 'react'
import { api } from '../../lib/api'
import type { MemoryPlace } from '../../lib/types'
import { saveWords } from '../../lib/memory-rows'
import { MachineSaveConfirm, needsMachineConfirm } from './MachineSaveConfirm'

const RULE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/** A place's label (one label per thing, the scope review's) and what it writes. */
export function placeWords(p: MemoryPlace, names: { agent: string; project: string | null }): { label: string; file: string; reach: string } {
  const project = names.project ? `Project · ${names.project}` : 'This project'
  const base = p.path.split('/').pop() ?? p.path
  switch (p.kind) {
    case 'agent':
      return { label: `Agent · ${names.agent}`, file: 'its own memory, kept by Silos', reach: `only ${names.agent}` }
    case 'private':
      return { label: `${project} · only you`, file: 'CLAUDE.local.md', reach: 'every agent here · the conversations you open — not wakes or isolated runs' }
    case 'project-rule':
      return { label: `${project} · a rule`, file: `.claude/rules/<name>.md`, reach: 'every agent here — always, or only for files matching …' }
    case 'personal':
      return { label: 'This machine', file: '~/.claude/CLAUDE.md', reach: 'every project on this machine' }
    case 'personal-rule':
      return {
        label: 'This machine · a rule',
        file: '~/.claude/rules/<name>.md',
        reach: 'every project on this machine — always, or only for files matching …',
      }
    default:
      return { label: project, file: base, reach: 'every agent here' }
  }
}

export function WriteInstructions({
  places,
  agentName,
  projectName,
  folder,
  onBack,
  onWritten,
  onOpen,
}: {
  places: MemoryPlace[]
  agentName: string
  projectName: string | null
  folder: string | null
  onBack: () => void
  /** a file was created: the list reads again and opens it */
  onWritten: (path: string) => void
  /** an existing file: its row's editor */
  onOpen: (path: string) => void
}) {
  // the fixed places only — auto memory's notes have their own «Write a note»
  const offered = places.filter((p) => p.kind !== 'auto-note' && p.kind !== 'auto-index')
  const [pick, setPick] = useState<MemoryPlace | null>(offered.find((p) => !p.exists) ?? offered[0] ?? null)
  const [name, setName] = useState('')
  const [paths, setPaths] = useState('')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dir = pick?.shape === 'dir'
  const target = pick ? (dir ? `${pick.path}/${name}.md` : pick.path) : null
  const ready = pick !== null && text.trim() !== '' && (!dir || RULE_NAME.test(name))

  async function save(confirmed = false): Promise<void> {
    if (!pick || !target || !ready) return
    setSaving(true)
    setError(null)
    const body = dir && paths.trim() ? `---\npaths: ${paths.trim()}\n---\n\n${text.trim()}\n` : `${text.trim()}\n`
    try {
      await api.memory.write(target, body, {
        ...(folder ? { folder } : {}),
        ...(confirmed ? { confirmed: true } : {}),
        ...(pick.ignoreLine ? { ignoreLine: true } : {}),
      })
      onWritten(target)
    } catch (e) {
      if (!confirmed && needsMachineConfirm(e)) setConfirming(true)
      else setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="px-4 pb-4 pt-3" data-testid="write-instructions">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-serif text-[15px] text-ink">Write instructions</h3>
        <button type="button" onClick={onBack} className="text-[12px] text-ink-2 hover:text-ink">
          ‹ Back
        </button>
      </div>
      <p className="mt-1 text-[12px] leading-snug text-ink-3">
        Where it is written decides whom it reaches. One conversation has no file — tell it in its composer.
      </p>
      <ul role="radiogroup" aria-label="Where to write" className="mt-2.5 divide-y divide-line/70 border-y border-line/70">
        {offered.map((p) => {
          const w = placeWords(p, { agent: agentName, project: projectName })
          const on = pick?.path === p.path
          return (
            <li key={p.path}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                data-kind={p.kind}
                onClick={() => {
                  if (p.exists && p.shape === 'file') {
                    onOpen(p.path)
                    return
                  }
                  setPick(p)
                  setConfirming(false)
                  setError(null)
                }}
                className={`flex w-full items-baseline gap-2 py-1.5 text-left ${on ? 'text-ink' : 'text-ink-2 hover:text-ink'}`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-px inline-block h-[7px] w-[7px] shrink-0 rounded-full border ${on ? 'border-terracotta bg-terracotta' : 'border-ink-3'}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">
                    {w.label} <span className="font-mono text-[11px] text-ink-3">{w.file}</span>
                  </span>
                  <span className="block truncate text-[11.5px] text-ink-3">{w.reach}</span>
                </span>
                {p.exists && p.shape === 'file' ? <span className="shrink-0 text-[11px] text-ink-2">Open ›</span> : null}
              </button>
            </li>
          )
        })}
      </ul>
      {pick ? (
        <div className="mt-3">
          {dir ? (
            <div className="mb-2 flex flex-wrap items-baseline gap-2 text-[12px] text-ink-2">
              <label className="flex items-baseline gap-1.5">
                name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Rule name"
                  placeholder="style"
                  className="w-32 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none focus:border-terracotta"
                />
                .md
              </label>
              <label className="flex min-w-0 flex-1 items-baseline gap-1.5">
                only for files matching
                <input
                  value={paths}
                  onChange={(e) => setPaths(e.target.value)}
                  aria-label="Only for files matching"
                  placeholder="always"
                  className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none focus:border-terracotta"
                />
              </label>
            </div>
          ) : null}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Instructions"
            spellCheck={false}
            className="min-h-[12rem] w-full resize-y rounded-lg border border-line bg-panel p-3 font-mono text-xs leading-relaxed text-ink outline-none focus:border-terracotta"
          />
          {pick.ignoreLine ? (
            <p data-testid="ignore-line" className="mt-1.5 text-[11.5px] text-ink-3">
              Also adds {pick.ignoreLine.line} to {pick.ignoreLine.file}
            </p>
          ) : pick.ignoreElsewhere ? (
            <p className="mt-1.5 text-[11.5px] text-ink-3">This folder’s git is elsewhere — keep CLAUDE.local.md out of your commits yourself.</p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-1.5 text-[12px] text-ink-2">
              {error}
            </p>
          ) : null}
          {confirming ? (
            <MachineSaveConfirm saving={saving} onConfirm={() => void save(true)} onKeepEditing={() => setConfirming(false)} />
          ) : (
            <div className="mt-3 flex items-center justify-end gap-3">
              <button type="button" onClick={onBack} className="text-sm text-ink-2 hover:text-ink">
                Cancel
              </button>
              <button
                type="button"
                disabled={!ready || saving}
                onClick={() => void save()}
                className="rounded-lg bg-terracotta px-3 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-60"
              >
                {saving ? 'Saving…' : saveWords(pick, agentName)}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
