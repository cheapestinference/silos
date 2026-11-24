// MissionHeader.tsx — the head of the agent's page: why it acts, in the owner's words, read first and edited in place.
// The mission text in the display face (it is the sentence the agent is),
// its «Never» rules under it with the honest gloss — a rule it follows, not
// a lock — and the locks themselves as doors. One editor, two fields,
// the ONE split rule (lib/mission.ts); «New conversations will use it» says
// when a save takes effect. The agent never writes here: it proposes.
// Mounted on the page's Now and in the conversation's Knows drawer.
// A mission the agent PROPOSED arrives here through its row's «Review ›»
// (lib/mission-review.ts): the editor opens preloaded with
// it, the whole change drawn above, and its Save resolves the proposal.
import { useEffect, useRef, useState } from 'react'
import { endMissionReview, neverDiff, useMissionReview, type MissionReview } from '../../lib/mission-review'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import { openAgentSettings } from './doors'
import { missionFromFields, missionProblem } from '../../lib/mission'
import type { AgentView } from '../../lib/types'
import { Section, SectionAction } from './Section'

export function MissionHeader({ agent, focus = false, bare = false }: { agent: AgentView; focus?: boolean; bare?: boolean }) {
  const mission = agent.mission ?? null
  const [editingOwn, setEditing] = useState(false)
  const review = useMissionReview(agent.id)
  const editing = editingOwn || review !== null
  const ref = useRef<HTMLDivElement>(null)

  // another agent in the same page instance starts read-first
  useEffect(() => {
    setEditing(false)
  }, [agent.id])
  // a link aimed here (/agent/<id>/mission) brings it into view
  useEffect(() => {
    if (focus || review) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [focus, agent.id, review])

  const body = editing ? (
    <MissionEditor
      key={review?.proposalId ?? 'own'}
      agent={agent}
      review={review}
      onDone={() => {
        setEditing(false)
        endMissionReview()
      }}
    />
  ) : mission ? (
    <div className="max-w-[62ch]" data-testid="mission-read">
      <p className="whitespace-pre-wrap font-display text-[16.5px] leading-snug text-ink">{mission.text}</p>
      {mission.never.length > 0 ? <NeverRules agentId={agent.id} rules={mission.never} /> : null}
    </div>
  ) : (
    <p className="max-w-[62ch] text-[13.5px] leading-relaxed text-ink-2" data-testid="mission-empty">
      No mission yet — {agent.name} does only what you give it.{' '}
      <button type="button" onClick={() => setEditing(true)} className="text-terracotta underline-offset-2 hover:underline">
        Write what {agent.name} takes care of ›
      </button>
    </p>
  )

  return (
    <div ref={ref} data-testid="mission-header">
      {bare ? (
        body
      ) : (
        <Section id="mission" label="Mission" action={editing || !mission ? null : <SectionAction onClick={() => setEditing(true)}>Edit</SectionAction>}>
          {body}
        </Section>
      )}
      {bare && !editing && mission ? (
        <button type="button" onClick={() => setEditing(true)} className="mt-2 text-[12px] text-ink-2 hover:text-terracotta">
          Edit
        </button>
      ) : null}
    </div>
  )
}

// The rules, each on its line, and what they are: an instruction the agent
// follows. What it truly can't touch is its territory and the Vault — named
// as doors to where they are set (a rule is never mistaken for a lock).
function NeverRules({ agentId, rules }: { agentId: string; rules: string[] }) {
  const toSecrets = (): void => {
    useStore.getState().changePage({ kind: 'agent', id: agentId })
    useStore.getState().changeTab('vault')
  }
  return (
    <div className="mt-2.5 border-l-2 border-line pl-3" data-testid="mission-never">
      <ul className="space-y-0.5 text-[13px] leading-snug text-ink-2">
        {rules.map((r, i) => (
          <li key={i}>
            <span className="text-ink">Never:</span> {r}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11.5px] text-ink-3">
        — a rule it follows; the locks are its{' '}
        <button type="button" onClick={() => openAgentSettings(agentId)} className="underline-offset-2 hover:text-terracotta hover:underline">
          territory
        </button>{' '}
        and its{' '}
        <button type="button" onClick={toSecrets} className="underline-offset-2 hover:text-terracotta hover:underline">
          secrets
        </button>
      </p>
    </div>
  )
}

// The owner's editor: the text, then one rule per line. Empty both = no
// mission (cleared). Problems are said in the field, before sending.
function MissionEditor({ agent, review, onDone }: { agent: AgentView; review: MissionReview | null; onDone: () => void }) {
  const loadOverview = useStore((s) => s.loadOverview)
  const [text, setText] = useState(review ? review.after.text : (agent.mission?.text ?? ''))
  const [never, setNever] = useState((review ? review.after.never : (agent.mission?.never ?? [])).join('\n'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draft = missionFromFields(text, never)
  const problem = missionProblem(draft, agent.name)
  const clearing = draft.text === '' && draft.never.length === 0

  async function save(): Promise<void> {
    if (problem) return
    setSaving(true)
    setError(null)
    try {
      await api.agents.update(agent.id, { mission: clearing ? null : draft, ...(review && !clearing ? { proposal: review.proposalId } : {}) })
      await loadOverview()
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="flex max-w-[62ch] flex-col gap-3"
      data-testid="mission-editor"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {review ? <ProposedChange agentName={agent.name} review={review} /> : null}
      <div>
        <label htmlFor={`mission-text-${agent.id}`} className="mb-1 block text-xs text-ink-2">
          What {agent.name} takes care of
        </label>
        <textarea
          id={`mission-text-${agent.id}`}
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="One or two sentences."
          className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 font-display text-[15px] leading-snug text-ink outline-none focus:border-terracotta"
        />
      </div>
      <div>
        <label htmlFor={`mission-never-${agent.id}`} className="mb-1 block text-xs text-ink-2">
          Never, without asking you first — one per line
        </label>
        <textarea
          id={`mission-never-${agent.id}`}
          rows={2}
          value={never}
          onChange={(e) => setNever(e.target.value)}
          placeholder="file or pay anything"
          className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-1.5 text-[13px] text-ink outline-none focus:border-terracotta"
        />
      </div>
      {problem ? (
        <p className="text-xs text-terracotta" role="alert">
          {problem}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-terracotta" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-ink-3">
          {clearing && agent.mission ? `Saving empty removes it — ${agent.name} does only what you give it.` : 'New conversations will use it.'}
        </p>
        {/* writing a mission never changes the control by itself */}
        {agent.control !== 'own' && !clearing ? (
          <p className="text-[12px] text-ink-3" data-testid="mission-told-note">
            It stays Only when told — switch Control above to let it go on its own
          </p>
        ) : null}
        <div className="flex shrink-0 items-center gap-3">
          <button type="button" onClick={onDone} className="text-sm text-ink-2 hover:text-ink">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || problem !== null || (clearing && !agent.mission)}
            className="rounded-lg bg-terracotta px-4 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
          >
            Save
          </button>
        </div>
      </div>
    </form>
  )
}

// What the agent proposed, whole (the text is 90% of the mandate — the
// diff shows the text AND the «Never» lines, added and removed), above the
// editor that is preloaded with it. Saving accepts it as edited; Cancel
// leaves the suggestion waiting.
function ProposedChange({ agentName, review }: { agentName: string; review: MissionReview }) {
  const before = review.before
  const textChanged = (before?.text ?? '') !== review.after.text
  const lines = neverDiff(before?.never ?? [], review.after.never)
  return (
    <div className="rounded-lg border border-line bg-panel/60 px-3.5 py-3" data-testid="mission-proposed">
      <p className="font-mono text-[11px] text-ink-2">
        {agentName} suggests a new mission — “{review.reason}”
      </p>
      {textChanged ? (
        <div className="mt-2 space-y-1.5 text-[13.5px] leading-snug">
          {before?.text ? (
            <p className="whitespace-pre-wrap text-ink-3 line-through decoration-ink-3/60" data-testid="mission-proposed-was">
              {before.text}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap font-display text-[15px] text-ink" data-testid="mission-proposed-text">
            {review.after.text}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[12.5px] text-ink-2">The text stays as it is.</p>
      )}
      {lines.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[13px] leading-snug" data-testid="mission-proposed-never">
          {lines.map((l) => (
            <li key={`${l.change}:${l.line}`} className={l.change === 'removed' ? 'text-ink-3 line-through' : l.change === 'added' ? 'text-ink' : 'text-ink-2'}>
              <span className="font-mono text-[11px]">{l.change === 'added' ? '+ ' : l.change === 'removed' ? '− ' : '  '}</span>Never: {l.line}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-[11.5px] text-ink-3">Edit it below if you like — Save accepts it; Cancel leaves the suggestion waiting.</p>
    </div>
  )
}
