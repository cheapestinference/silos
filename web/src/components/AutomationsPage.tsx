// AutomationsPage.tsx — an automation's ONE home: every
// click on an automation (the Automations list, the column, the agent
// page's list, the Map) lands here.
//
// Read top to bottom it answers, in order:
//   whose and where — the belonging sentence under the name, the same form
//                     as a conversation's subtitle ("with 🛠 Builder, role · in
//                     folder"), then one mono line of cadence/next/last;
//   what it does    — the prompt's first sentence, the whole of it on ask;
//   what waits      — a run of THIS automation waiting for your go;
//   what it did     — the runs, which ARE the body (no Runs | Edit tabs).
// Editing is a MODE of the page: "Edit" swaps the runs for
// the editor at full width (automation/AutomationEditor.tsx) under the same
// header; /automation/new is that editor creating one. The destructive
// action sits apart, in the ⋯.
// It is the automation's page, not the agent's: its seal is the ⚡ (ringed
// while a run waits for your go), never the agent's emoji, no agent counts.
// The band is the common one (PageHeader): Automations › as
// the place, the name, one line of cadence, the belonging sentence under it.
import { TemplateFill } from './automation/Templates'
import { ProposalReview } from './automation/ProposalReview'
import { useEffect, useRef, useState } from 'react'
import { Pause, Pencil, Play, Zap } from 'lucide-react'
import { AutomationIcon, CommandIcon, RowMenuIcon } from '../lib/icons'
import { useStore } from '../store'
import { api } from '../lib/api'
import { argvLine, commandOf, earlierKeptThread, foldRangeLabel, foldRoutine, foldWords, isDone, promptGist } from '../lib/automations'
import { isBeatAutomation } from '../lib/automations-signal'
import { MASTER_ID, ANYWHERE_LABEL } from '../lib/constants'
import type { CommandRun } from '../lib/types'
import { RunRow } from './RunRow'
import { HeaderButton, PageHeader, Seal } from './PageHeader'
import { AutomationFacts, BelongingSentence } from './automation/HeaderBits'
import { AutomationEditor } from './automation/AutomationEditor'
import { UsageBlock, useFreshUsage } from './automation/AutomationUsage'
import { beatHomeOpen, PAUSED_BEAT_WORDS } from '../lib/beat-home'
import { openAgentControl } from './agent/doors'

// The history reads as results: consecutive "no news" runs fold into one
// quiet row (click to unfold them in place); acted, failed, waiting and
// unclassified runs are always their own row. Which folds are open is local
// to the automation being shown — another automation starts folded.
function RunsTab() {
  const runs = useStore((s) => s.automationRuns)
  const automationId = useStore((s) => (s.page?.kind === 'automation' ? s.page.id : null))
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    setOpen(new Set())
  }, [automationId])
  const items = foldRoutine(runs)
  return (
    <div className="h-full overflow-y-auto">
      {runs.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-2">No runs yet.</p>
      ) : (
        <ul>
          {items.map((item) => {
            if (item.kind === 'run') return <RunRow key={item.run.id} run={item.run} />
            const key = item.runs[0]!.id
            if (open.has(key)) return item.runs.map((r) => <RunRow key={r.id} run={r} />)
            return (
              <li key={`fold-${key}`} className="border-b border-line">
                <button
                  type="button"
                  data-testid="runs-no-news-fold"
                  onClick={() => setOpen((prev) => new Set(prev).add(key))}
                  title="Show these runs"
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-ink-2 hover:bg-panel"
                >
                  <span>{foldWords(item.runs.length, item.key)}</span>
                  <span>· {foldRangeLabel(item.runs)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// what it does — the prompt's first sentence; the whole prompt on ask
function WhatItDoes({ prompt, label = 'What it asks' }: { prompt: string; label?: string }) {
  const [open, setOpen] = useState(false)
  const gist = promptGist(prompt)
  if (!gist) return null
  const more = gist !== prompt.trim().replace(/\s+/g, ' ')
  const toggle = more ? (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      className="ml-1.5 rounded text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta hover:decoration-terracotta"
    >
      {open ? 'less' : 'show all'}
    </button>
  ) : null
  return (
    <div className="shrink-0 border-b border-line px-4 py-2.5" data-testid="automation-prompt">
      {open ? (
        <>
          <p className="text-[13px] text-ink-2">
            {label}
            {toggle}
          </p>
          <p
            data-testid="automation-prompt-full"
            className="mt-1.5 max-h-[40vh] max-w-[72ch] overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed text-ink"
          >
            {prompt}
          </p>
        </>
      ) : (
        <p className="max-w-[72ch] text-[13px] leading-relaxed">
          <span className="text-ink-2">{label}: </span>
          <span className="text-ink">{gist}</span>
          {toggle}
        </p>
      )}
    </div>
  )
}

// what a command automation runs — the argv literal and whole, never cut
// (the owner reads exactly what will exec), where, and what happens
// when it fails
function WhatItRuns({ command, agentName }: { command: CommandRun; agentName: string }) {
  const ok = command.okCodes && command.okCodes.length > 0 ? command.okCodes : null
  return (
    <div className="shrink-0 border-b border-line px-4 py-2.5" data-testid="automation-command">
      <div className="flex max-w-[80ch] items-start gap-2">
        <CommandIcon size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-ink-3" />
        <code data-testid="automation-argv" className="min-w-0 whitespace-pre-wrap break-all font-mono text-[12.5px] leading-relaxed text-ink">
          {argvLine(command.argv)}
        </code>
      </div>
      <p className="mt-1 pl-[22px] text-[13px] text-ink-2" data-testid="automation-on-failure">
        {command.cwd ? (
          <>
            in <span className="font-mono text-[12px] text-ink">{command.cwd}</span> ·{' '}
          </>
        ) : null}
        If it fails: <span className="text-ink">{command.onFailure === 'agent' ? `hands it to ${agentName}` : 'tells you'}</span>
        {ok ? (
          <>
            {' '}
            · exit {ok.join(', ')} {ok.length === 1 ? 'counts' : 'count'} as done
          </>
        ) : null}
      </p>
    </div>
  )
}

// the ⋯ at the header's right end — where the destructive action
// lives, apart from Run now / Pause / Edit. Two steps, like the topic and
// session rows: the first click arms "sure?", the second removes it
// (deleteAutomation navigates away). Closes on an outside click or Esc.
// on a phone the band keeps the name and the page's one verb (Run now):
// Pause and Edit come in here, first, in the header's order (md:hidden —
// on desktop they are the band's own buttons)
interface PhoneItem {
  label: string
  onSelect: () => void
  testId: string
}

function MoreMenu({ automationId, templatable, phoneItems = [] }: { automationId: string; templatable: boolean; phoneItems?: readonly PhoneItem[] }) {
  const [open, setOpen] = useState(false)
  const [sure, setSure] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  function close(): void {
    setOpen(false)
    setSure(false)
    setSaveError(null)
  }

  useEffect(() => {
    if (!open) return
    function onDocClick(e: globalThis.MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      {/* a header action like the rest — the icon held to a text line's
          height, so the ⋯ sits level with Run now */}
      <HeaderButton label="More actions" popup="menu" expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <span aria-hidden="true" className="flex h-[1.5em] items-center">
          <RowMenuIcon size={14} />
        </span>
      </HeaderButton>
      {open ? (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-lg">
          {phoneItems.length > 0 ? (
            <div className="border-b border-line pb-1 mb-1 md:hidden">
              {phoneItems.map((it) => (
                <button
                  key={it.testId}
                  type="button"
                  role="menuitem"
                  data-testid={it.testId}
                  onClick={() => {
                    close()
                    it.onSelect()
                  }}
                  className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-canvas"
                >
                  {it.label}
                </button>
              ))}
            </div>
          ) : null}
          {/* «Save as template»: this automation with its agent left blank —
              how a role's automations travel to another Silos (a webhook
              can't: its secret is its auth) */}
          {templatable ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSaveError(null)
                api.automationTemplates.fromAutomation(automationId).then(
                  (t) => {
                    close()
                    useStore.getState().changePage({ kind: 'automation', id: 'new', template: t.id })
                  },
                  (e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)),
                )
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-canvas"
            >
              Save as template
            </button>
          ) : null}
          {saveError ? (
            <p className="px-3 pb-1.5 text-xs leading-snug text-terracotta" data-testid="save-template-problem">
              {saveError}
            </p>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (!sure) {
                setSure(true)
                return
              }
              close()
              void useStore.getState().deleteAutomation(automationId)
            }}
            className={`block w-full px-3 py-1.5 text-left text-sm ${sure ? 'bg-terracotta-soft text-terracotta' : 'text-ink hover:bg-canvas hover:text-terracotta'}`}
          >
            {sure ? 'Delete — sure?' : 'Delete'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function AutomationsPage() {
  const page = useStore((s) => s.page)
  const automations = useStore((s) => s.automations)
  const agents = useStore((s) => s.agents)
  const openSession = useStore((s) => s.openSession)
  // a run of THIS automation waiting for the owner's go — the page is where
  // it is answered too (Home's inbox and the column carry the same buttons).
  const pending = useStore((s) => s.automationsPending)
  const approveRun = useStore((s) => s.approveRun)
  const skipRun = useStore((s) => s.skipRun)
  const runs = useStore((s) => s.automationRuns)
  const [editing, setEditing] = useState(false)

  const id = page?.kind === 'automation' ? page.id : null
  const automation = automations.find((a) => a.id === id) ?? null
  const automationsLoaded = useStore((s) => s.automationsLoaded)

  useEffect(() => {
    setEditing(false)
  }, [id])
  // its month's spend, read fresh on arrival
  useFreshUsage(id)

  if (!id) return null

  // /automation/new — the editor creating one (key: a new agent in the URL
  // starts a fresh editor)
  if (id === 'new') {
    const agentId = page?.kind === 'automation' ? page.agent : undefined
    const templateId = page?.kind === 'automation' ? page.template : undefined
    const proposalId = page?.kind === 'automation' ? page.proposal : undefined
    // a proposal under review: the editor starts from it (ProposalReview.tsx)
    if (proposalId) return <ProposalReview key={proposalId} proposalId={proposalId} />
    // a template being filled in: its sentence is the form (Templates.tsx)
    if (templateId) return <TemplateFill key={`${templateId}:${agentId ?? ''}`} templateId={templateId} agentId={agentId} />
    return <AutomationEditor key={agentId ?? ''} mode="create" agentId={agentId} />
  }

  if (!automation) {
    // before the list has answered, an unknown id is UNKNOWN — «not found»
    // here sent a valid deep link to a false dead end when the first
    // loadAutomations failed or had not landed yet
    if (!automationsLoaded) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
          <p className="text-sm text-ink-2">Reading automations…</p>
          <button
            type="button"
            className="text-sm text-ink underline underline-offset-2 hover:text-terracotta"
            onClick={() => void useStore.getState().loadAutomations()}
          >
            Retry
          </button>
        </div>
      )
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
        <p className="font-display text-lg text-ink">Automation not found</p>
        <p className="text-sm text-ink-2">It may have been deleted.</p>
      </div>
    )
  }

  const agent = agents.find((a) => a.id === automation.agentId)
  const command = commandOf(automation)
  const agentName = automation.agentId === MASTER_ID ? ANYWHERE_LABEL : (agent?.name ?? automation.agentId)

  if (editing) {
    return <AutomationEditor key={automation.id} mode="edit" automation={automation} onDone={() => setEditing(false)} />
  }
  const done = isDone(automation)
  const stateWord = done ? 'done' : automation.paused ? 'paused' : automation.approval ? 'asks first' : null
  const thread = automation.thread
  const keepInfo = thread.mode === 'keep' && thread.folder && thread.sessionId ? { folder: thread.folder, sessionId: thread.sessionId } : null
  const waiting = pending.filter((r) => r.automationId === automation.id)
  // a standing duty's beat: its earlier beats may have run in one kept
  // thread; that history is one click away, never lost from sight
  const earlier = isBeatAutomation(automation)
    ? earlierKeptThread(
        runs.filter((r) => r.automationId === automation.id),
        keepInfo ? `${keepInfo.folder}/${keepInfo.sessionId}` : null,
      )
    : null

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <PageHeader
        testId="automation-header"
        // where it lives: the Automations — never the agent (whose it is
        // is the belonging sentence below, with its door)
        crumbs={[{ label: 'Automations', onClick: () => useStore.getState().changePage({ kind: 'automations' }) }]}
        seal={
          <Seal testId="automation-seal" signal={waiting.length > 0 ? 'attention' : null}>
            <AutomationIcon size={17} strokeWidth={2} aria-hidden="true" className="text-terracotta" />
          </Seal>
        }
        title={automation.name}
        facts={<AutomationFacts automation={automation} stateWord={stateWord} />}
        notes={
          <>
            <BelongingSentence agentId={automation.agentId} thread={automation.thread} agent={agent} command={command} oneLine />
            {isBeatAutomation(automation) ? (
              // a heartbeat's rhythm is not edited here (the server refuses
              // it); this page IS its home — its runs and Run now
              // — while its agent is in play: an archived agent's beat is
              // paused and has no home to open (beat-home.ts), said plainly
              beatHomeOpen(automation.agentId, agents) ? (
                <p className="mt-0.5 truncate text-[12.5px] text-ink-2">
                  {agentName}&rsquo;s heartbeat ·{' '}
                  <button
                    type="button"
                    data-testid="beat-schedule-door"
                    onClick={() => openAgentControl(automation.agentId)}
                    className="text-ink-2 hover:text-terracotta"
                  >
                    Set its rhythm on {agentName}&rsquo;s page ›
                  </button>
                </p>
              ) : (
                <p data-testid="beat-paused" className="mt-0.5 truncate text-[12.5px] text-ink-2">
                  {agentName}&rsquo;s heartbeat — {PAUSED_BEAT_WORDS}
                </p>
              )
            ) : null}
          </>
        }
        // on a phone the actions are their icons (AgentPage's idiom), so
        // the name keeps its room. Secondary first, the primary (Run now — the page's one verb) last;
        // the destructive action apart, in the ⋯ at the far end. A heartbeat
        // has no Delete, no Pause and no Edit: its rhythm lives on its agent's
        // Now (the door above), and a heartbeat doesn't pause
        actions={
          <>
            {done || isBeatAutomation(automation) ? null : (
              <div className="hidden md:contents">
                <HeaderButton
                  testId="automation-pause"
                  label={automation.paused ? 'Resume' : 'Pause'}
                  onClick={() =>
                    void (automation.paused ? useStore.getState().resumeAutomation(automation.id) : useStore.getState().pauseAutomation(automation.id))
                  }
                >
                  {automation.paused ? (
                    <Play size={15} aria-hidden="true" className="sm:hidden" />
                  ) : (
                    <Pause size={15} aria-hidden="true" className="sm:hidden" />
                  )}
                  <span className="hidden sm:inline">{automation.paused ? 'Resume' : 'Pause'}</span>
                </HeaderButton>
              </div>
            )}
            {isBeatAutomation(automation) ? null : (
              <div className="hidden md:contents">
                <HeaderButton testId="automation-edit" label="Edit" onClick={() => setEditing(true)}>
                  <Pencil size={15} aria-hidden="true" className="sm:hidden" />
                  <span className="hidden sm:inline">Edit</span>
                </HeaderButton>
              </div>
            )}
            <HeaderButton
              primary
              testId="automation-run-now"
              label={done ? 'Run again' : 'Run now'}
              onClick={() => void api.automations.runNow(automation.id).then(() => useStore.getState().loadAutomationRuns(automation.id))}
            >
              <Zap size={15} aria-hidden="true" className="sm:hidden" />
              <span className="hidden sm:inline">{done ? 'Run again' : 'Run now'}</span>
            </HeaderButton>
            {isBeatAutomation(automation) ? null : (
              <MoreMenu
                automationId={automation.id}
                templatable={automation.trigger.kind !== 'webhook'}
                phoneItems={[
                  ...(done
                    ? []
                    : [
                        {
                          testId: 'automation-pause-menu',
                          label: automation.paused ? 'Resume' : 'Pause',
                          onSelect: () =>
                            void (automation.paused ? useStore.getState().resumeAutomation(automation.id) : useStore.getState().pauseAutomation(automation.id)),
                        },
                      ]),
                  { testId: 'automation-edit-menu', label: 'Edit', onSelect: () => setEditing(true) },
                ]}
              />
            )}
          </>
        }
      />
      {command ? (
        <>
          <WhatItRuns command={command} agentName={agentName} />
          {command.onFailure === 'agent' ? <WhatItDoes prompt={automation.prompt} label={`What it asks ${agentName} when it fails`} /> : null}
        </>
      ) : (
        <WhatItDoes prompt={automation.prompt} />
      )}
      {/* what it spent: its 30 days, Usage's summary line */}
      <UsageBlock automation={automation} runs={runs} />
      {waiting.map((r) => (
        <div
          key={r.id}
          data-testid="automation-approval"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-terracotta-soft/40 px-4 py-2 text-xs"
        >
          <span className="min-w-0 flex-1 text-ink">
            Waiting for your go{r.promptOverride ? <span className="text-ink-2"> — {r.promptOverride}</span> : null}
          </span>
          <button
            type="button"
            onClick={() => void approveRun(r.id)}
            className="rounded-md bg-terracotta px-2.5 py-1 font-medium text-on-terracotta hover:opacity-90"
          >
            Approve
          </button>
          <button type="button" onClick={() => void skipRun(r.id)} className="rounded-md px-2 py-1 text-ink-2 hover:text-ink">
            Skip
          </button>
        </div>
      ))}
      {keepInfo ? (
        <button
          type="button"
          onClick={() => {
            void openSession(keepInfo.folder, keepInfo.sessionId)
          }}
          className="shrink-0 border-b border-line px-4 py-1.5 text-left text-xs font-medium text-terracotta hover:underline"
        >
          Open its conversation →
        </button>
      ) : null}
      {earlier ? (
        <button
          type="button"
          data-testid="earlier-beats-thread"
          onClick={() => {
            void openSession(earlier.folder, earlier.id)
          }}
          className="shrink-0 border-b border-line px-4 py-1.5 text-left text-xs text-ink-2 hover:text-terracotta"
        >
          Earlier heartbeats ran in one thread — open it ›
        </button>
      ) : null}
      {/* the runs are the body */}
      <div className="flex-1 overflow-hidden">
        <RunsTab />
      </div>
    </div>
  )
}
