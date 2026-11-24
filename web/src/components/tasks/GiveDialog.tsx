// GiveDialog — New task → «Give». It asks
// WHAT and WHO; the button says what will happen, by the agent's control:
//   On its own     «Give to X»                 — «Starts now, on its own»
//   Only when told «Give and open console ›»   — «Opens with you — nothing
//                  «Give and open chat ›»         starts without you»
//                  (on a phone: «Give» alone — no console to open)
//   you            «Add to my list»
// and beside it «Save for later» (the task without the gesture). Where it
// lands is derived and said folded — «in <project> · change»: an agent's
// task lives in its own folder, yours in the project you used last; the plan
// is ALWAYS the project's list (plans/tasks.plan.json, made by the kernel's
// ensure-record), a named plan only when picked or when New task opened from
// it. «Details» folds the description: it lands as your first note.
// The task is born through the kernel's own verb (append-item on plan/task),
// THEN the gesture: `assign` for an agent On its own (the owner's gesture —
// it skips the ceiling and the throttle, never the live caps); the task's
// door for one Only when told (its console briefed on the task when it has
// one, chat when not — useTaskOpen, the ONE way in). Creating is ONE request
// (POST /api/tasks/new): the server makes the list,
// assigns the id, writes the task with its details and the conversation it
// is born from, and gives it — nothing half-made to explain afterwards. After «Give to X» the
// dialog stays as the task's row with its live line (TaskLive): «Starting
// X…» → «X is on it …» → or «X couldn't start: …» — never «on it» at the
// click. ONE dialog for every door: /tasks, ⌘K «new task: … @agent» and the
// agent page's «Give it a task» only hand it a title and an owner.
import { useEffect, useMemo, useState } from 'react'
import { refreshTasks, refreshTasksBySession } from '../../hooks/useTasks'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { basename } from '../../lib/routes'
import { defaultPlan, defaultProject, giveFor, planChoices, planIdOf, projectsFor } from '../../lib/new-task'
import { STANDING_PLAN, type TaskView } from '../../lib/tasks'
import { controlOf, giveVoice, isPhone, surfaceOfAgent } from '../../lib/give'
import { OpeningLine, useTaskMode, useTaskOpen } from './TaskMode'
import { TaskLive } from './TaskLive'
import type { AgentView } from '../../lib/types'

// the project you put your last task in, and the agent you gave to last (a
// per-browser convenience)
const LAST_PROJECT = 'silos.newTask.project'
const LAST_FOR = 'silos.give.for'
function read(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function remember(k: string, v: string): void {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private window: nothing kept */
  }
}

const field = 'rounded-md border border-line bg-canvas px-2 py-1 text-[12.5px] outline-none focus:border-terracotta'

export function GiveDialog({
  all,
  agents,
  initialTitle = '',
  initialOwner = null,
  initialPlan = null,
  conversation = null,
  placeholder,
  onClose,
  onCreated,
}: {
  all: readonly TaskView[]
  agents: readonly AgentView[]
  initialTitle?: string
  // who the door named (an agent id, 'owner' for you); null: «the only one or
  // the last used» (giveFor)
  initialOwner?: string | null
  // opened from a named plan: it lands there unless changed
  initialPlan?: string | null
  // ⌘K «Make this a task»: the conversation it is born from — linked BEFORE the
  // note and the gesture, so the task is never «nobody on it» for a beat
  // and Silos never wakes a second conversation of the agent beside this one
  conversation?: { id: string; folder: string } | null
  // the box's question, when a door asks it its own way (an agent's first
  // minute: «What should <Name> do first?»)
  placeholder?: string
  onClose: () => void
  // `started`: the gesture opened a conversation on it (you are there now)
  onCreated: (t: { planKey: string; id: string; started?: boolean; linked?: boolean }) => void
}) {
  const inPlay = agents.filter((a) => !a.archived && a.folder)
  const [owner, setOwner] = useState(() => giveFor({ named: initialOwner, last: read(LAST_FOR), agents }))
  const ownerAgent = inPlay.find((a) => a.id === owner)
  const projects = useMemo(() => projectsFor(owner, inPlay), [owner, inPlay])
  // a hand-picked project / plan stays while it is still offered
  const [pickedProject, setPickedProject] = useState<string | null>(null)
  const [pickedPlan, setPickedPlan] = useState<string | null>(initialPlan)
  // an agent's task: its primary folder; yours: the project you used last
  const project =
    pickedProject && projects.includes(pickedProject)
      ? pickedProject
      : ownerAgent
        ? (projects[0] ?? '')
        : defaultProject(owner, projects, all, read(LAST_PROJECT))
  const choices = useMemo(() => (project ? planChoices(all, project, owner) : []), [all, project, owner])
  const plan = defaultPlan(choices, pickedPlan)
  const chosen = choices.find((c) => c.planKey === plan) ?? null
  const [placing, setPlacing] = useState(false)
  const [details, setDetails] = useState(false)
  const [title, setTitle] = useState(initialTitle)
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState<null | 'primary' | 'save'>(null)
  const [err, setErr] = useState<string | null>(null)
  // after «Give to X»: the task's row, alive
  const [given, setGiven] = useState<{ key: string; planKey: string; id: string; title: string; agent: AgentView; why?: string } | null>(null)
  const phone = isPhone()
  const voice = giveVoice({
    owner: ownerAgent ? { name: ownerAgent.name, control: controlOf(ownerAgent), surface: surfaceOfAgent(ownerAgent) } : null,
    mobile: phone,
  })
  const surface = surfaceOfAgent(ownerAgent)
  const opener = useTaskOpen({ taskKey: '', name: ownerAgent?.name ?? '', onDone: () => refreshTasks() })

  async function create(act: 'assign' | 'open' | 'add' | 'save'): Promise<void> {
    const text = title.trim()
    if (!text || !project || !chosen) return
    setBusy(act === 'save' ? 'save' : 'primary')
    setErr(null)
    try {
      // ONE request: the task, its details, the conversation it is born
      // from (not when you go in with it — that opens its own), and the Give
      const d = desc.trim()
      const session = conversation && act !== 'open' ? conversation.id : null
      const r = await api.tasksNew({
        folder: project,
        plan: chosen.standing ? STANDING_PLAN : planIdOf(chosen.planKey, project),
        title: text,
        owner,
        ...(d ? { details: d } : {}),
        ...(session ? { session } : {}),
        ...(ownerAgent && act === 'assign' ? { give: true } : {}),
      })
      if (r.warn) useStore.setState({ error: `Linked — but ${r.warn}.` })
      const planKey = r.key.slice(0, r.key.lastIndexOf('/tasks/'))
      const made = { planKey, id: r.id, ...(session ? { linked: true } : {}) }
      if (ownerAgent) remember(LAST_FOR, ownerAgent.id)
      else remember(LAST_PROJECT, project)
      refreshTasks()
      if (session) refreshTasksBySession()
      if (ownerAgent && act === 'open') {
        // Only when told: you go in — its console briefed on it, or chat
        if (await opener.go(surface, r.key)) onCreated({ ...made, started: true })
        return
      }
      if (ownerAgent && act === 'assign') {
        // nothing queued: the row says the server's why once no live fact
        // contradicts it
        const a = r.assign
        setGiven({ key: r.key, planKey, id: r.id, title: text, agent: ownerAgent, ...(a && !a.queued && a.why ? { why: a.why } : {}) })
        return
      }
      onCreated(made)
    } catch (e) {
      // refused: nothing was created — the dialog stays, the reason beside it
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (given)
    return (
      <GivenRow
        given={given}
        onOpen={() => onCreated({ planKey: given.planKey, id: given.id })}
        onAnother={() => {
          setGiven(null)
          setTitle('')
          setDesc('')
          setDetails(false)
        }}
        onClose={onClose}
      />
    )

  const where = project ? (
    <span data-testid="new-task-where" className="min-w-0 truncate text-[12px] text-ink-2">
      in <span className="text-ink">{basename(project)}</span>
      {chosen && !chosen.standing ? (
        <>
          {' '}
          · <span className="text-ink">{chosen.title}</span>
        </>
      ) : null}
    </span>
  ) : (
    <span data-testid="new-task-where" className="text-[12px] text-ink-3">
      no project to put it in — give an agent a folder first
    </span>
  )
  const own = voice.primary.act === 'assign'
  const disabled = busy !== null || opener.o.state === 'opening' || title.trim() === '' || !chosen

  return (
    <form
      data-testid="new-task-dialog"
      className="mt-3 flex max-w-[62ch] flex-col gap-2.5 rounded-lg border border-line bg-panel/60 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        void create(voice.primary.act)
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={300}
        placeholder={placeholder ?? (ownerAgent ? `What should ${ownerAgent.name} do?` : 'What needs doing?')}
        aria-label="What to do"
        className="w-full rounded-md border border-line bg-canvas px-2.5 py-2 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-terracotta"
      />
      {details ? (
        <textarea
          autoFocus
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={3}
          maxLength={8000}
          aria-label="Details"
          placeholder={ownerAgent ? `Details — they land as your first note for ${ownerAgent.name}` : 'Details — they land as your first note'}
          className="w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-ink-3 focus:border-terracotta"
        />
      ) : (
        <button
          type="button"
          data-testid="give-details"
          onClick={() => setDetails(true)}
          aria-expanded={false}
          className="self-start text-[12px] text-ink-3 hover:text-ink"
        >
          Details
        </button>
      )}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <label className="text-[12px] text-ink-2" htmlFor="nt-owner">
            For
          </label>
          <select
            id="nt-owner"
            data-testid="give-for"
            value={owner}
            onChange={(e) => {
              setOwner(e.target.value)
              setPickedPlan(initialPlan)
            }}
            className={field}
          >
            {inPlay.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
            <option value="owner">You</option>
          </select>
          {where}
          {project && !placing ? (
            <button
              type="button"
              data-testid="new-task-change"
              onClick={() => setPlacing(true)}
              aria-expanded={false}
              className="text-[12px] text-ink-3 underline decoration-line underline-offset-2 hover:text-terracotta"
            >
              change
            </button>
          ) : null}
        </div>
        {/* what will happen — said before the click, by how the agent moves */}
        {voice.line ? (
          <p data-testid="give-line" data-control={own ? 'own' : 'told'} className="flex items-baseline gap-2 pl-[2.1rem] text-[12px] text-ink-2">
            <span
              aria-hidden="true"
              className={`relative top-[-1px] inline-block h-1.5 w-1.5 shrink-0 self-center rounded-full ${own ? 'bg-terracotta' : 'border border-ink-3'}`}
            />
            {voice.line}
          </p>
        ) : null}
      </div>
      {placing && project ? (
        <div data-testid="new-task-place" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-l-2 border-line pl-3">
          {projects.length > 1 ? (
            <>
              <label className="text-[12px] text-ink-2" htmlFor="nt-project">
                Project
              </label>
              <select
                id="nt-project"
                value={project}
                onChange={(e) => {
                  setPickedProject(e.target.value)
                  setPickedPlan(null)
                }}
                className={field}
              >
                {projects.map((f) => (
                  <option key={f} value={f} title={f}>
                    {basename(f)}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <label className="text-[12px] text-ink-2" htmlFor="nt-plan">
            Plan
          </label>
          <select id="nt-plan" value={plan} onChange={(e) => setPickedPlan(e.target.value)} className={`${field} min-w-0 flex-1`}>
            {/* «No plan» is a VALUE (the facet says the same); the list itself is headed «Tasks of <project>» */}
            {choices.map((c) => (
              <option
                key={c.planKey}
                value={c.planKey}
                {...(c.standing ? { title: `Straight in the project's own list — Tasks of ${basename(project)}` } : {})}
              >
                {c.standing ? 'No plan' : c.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {err ? (
        <p role="alert" className="text-[12px] text-terracotta">
          {err}
        </p>
      ) : null}
      <span className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          data-testid="give-primary"
          data-act={voice.primary.act}
          disabled={disabled}
          className="rounded-full bg-terracotta px-3.5 py-1 text-[12.5px] font-medium text-on-terracotta shadow-[0_1px_0_var(--shadow-soft)] enabled:hover:brightness-105 disabled:opacity-50"
        >
          {busy === 'primary' && voice.primary.act === 'assign' ? `Giving to ${ownerAgent?.name ?? ''}…` : voice.primary.label}
        </button>
        {voice.secondary ? (
          <button
            type="button"
            data-testid="give-later"
            disabled={disabled}
            onClick={() => void create('save')}
            className="rounded-full border border-line px-3 py-1 text-[12px] text-ink-2 enabled:hover:border-ink-3 enabled:hover:text-ink disabled:opacity-50"
          >
            {voice.secondary.label}
          </button>
        ) : null}
        <button type="button" onClick={onClose} className="text-[12px] text-ink-3 hover:text-ink">
          Cancel
        </button>
      </span>
      <OpeningLine opener={opener} />
    </form>
  )
}

// the given task as a row that stays alive — its live line, its page one
// click away. The dialog closes on its own only when you close it.
function GivenRow({
  given,
  onOpen,
  onAnother,
  onClose,
}: {
  given: { key: string; title: string; agent: AgentView; why?: string }
  onOpen: () => void
  onAnother: () => void
  onClose: () => void
}) {
  const mode = useTaskMode(given.key)
  const [first, setFirst] = useState(true)
  // the first reading may predate the hand-over: until a live fact arrives,
  // the gesture is «Starting X…» — never a silent row
  useEffect(() => {
    if (mode.view?.live) setFirst(false)
  }, [mode.view?.live])
  // refused by the server and nothing live on its first reading: it did not
  // start — «Starting X…» would never end
  const refused = given.why !== undefined && first && mode.view != null && !mode.view.live
  const fact = mode.view?.live ?? (first && !refused ? { kind: 'starting' as const } : null)
  return (
    <div data-testid="give-given" className="mt-3 flex max-w-[62ch] flex-col gap-2 rounded-lg border border-line bg-panel/60 px-4 py-3">
      <p className="min-w-0 text-[13.5px] text-ink">
        <span className="text-ink-2">Given to {given.agent.name}:</span>{' '}
        <button
          type="button"
          data-testid="give-given-open"
          onClick={onOpen}
          className="font-medium underline decoration-line underline-offset-2 hover:text-terracotta hover:decoration-terracotta/50"
        >
          {given.title}
        </button>
      </p>
      <TaskLive name={given.agent.name} agentId={given.agent.id} fact={fact} reload={mode.reload} testId="give-live" />
      {!fact ? (
        <p data-testid="give-ended" className="text-[12px] text-ink-2">
          {refused ? `It did not start: ${given.why}.` : 'Its turn ended — see what it did on the task.'}
        </p>
      ) : null}
      <span className="flex flex-wrap items-center gap-3 pt-0.5">
        <button type="button" onClick={onOpen} className="text-[12px] font-medium text-ink underline decoration-line underline-offset-2 hover:text-terracotta">
          Open the task ›
        </button>
        <button type="button" data-testid="give-another" onClick={onAnother} className="text-[12px] text-ink-2 hover:text-ink">
          Give another
        </button>
        <button type="button" onClick={onClose} className="text-[12px] text-ink-3 hover:text-ink">
          Close
        </button>
      </span>
    </div>
  )
}
