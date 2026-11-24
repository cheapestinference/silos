// AutomationSheet.tsx — the composer's quick sheet: the caret ▾ → Once at…/
// Every… schedules the sentence being typed. A different moment from the
// automation editor (automation/AutomationEditor.tsx) — turning
// what you just wrote into an automation without leaving the conversation —
// but in the editor's own words and parts: «When it runs» is the
// editor's PeriodEditor (Every…) or its ScheduleBuilder (Once at…, or «a
// cron expression ›»), «How it runs» the same sentences, and «More options ›»
// opens the editor itself with all of it filled in. It only creates: the
// composer never hands it an automation (editing one is its page's).
// Never a modal — a panel that floats right above its trigger.
import { useEffect, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { X } from 'lucide-react'
import { api } from '../lib/api'
import { MASTER_ID, ANYWHERE_LABEL } from '../lib/constants'
import { autoName } from '../lib/automations'
import { defaultDraft, draftProblem, triggerOfDraft, type ScheduleDraft } from '../lib/schedule'
import { AUTOMATION_RULES, cadenceWords, capitalized, draftOfPeriod, periodOfDraft, periodProblem, stampedOfDraft, type PeriodDraft } from '../lib/period'
import { useStore } from '../store'
import { PeriodEditor } from './PeriodEditor'
import { ScheduleBuilder } from './automation/ScheduleBuilder'
import { NEW_PERIOD, SwitchRow, seedNextEditor, useStaggerMinute } from './automation/AutomationEditor'
import type { Automation, Thread } from '../lib/types'

export interface AutomationSheetContext {
  agentId: string
  defaultPrompt: string
  defaultKind: 'once' | 'every'
  defaultThread?: { folder?: string; sessionId?: string }
}

function Label({ children }: { children: ReactNode }) {
  return <h3 className="text-[13px] font-medium text-ink">{children}</h3>
}

export function AutomationSheet({ ctx, onClose, onSaved }: { ctx: AutomationSheetContext; onClose: () => void; onSaved: (a: Automation) => void }) {
  const isMaster = ctx.agentId === MASTER_ID
  const nowTick = useStore((s) => s.nowTick)
  const agentName = useStore((s) => (isMaster ? ANYWHERE_LABEL : (s.agents.find((a) => a.id === ctx.agentId)?.name ?? 'the agent')))
  const stagger = useStaggerMinute(ctx.agentId)

  const [prompt, setPrompt] = useState(ctx.defaultPrompt)
  const [name, setName] = useState(autoName(ctx.defaultPrompt))
  const [nameEdited, setNameEdited] = useState(false)

  // Every… opens on the editor's period; Once at… on its sentence of a date
  const [when, setWhen] = useState<'period' | 'cron'>(ctx.defaultKind === 'every' ? 'period' : 'cron')
  const [period, setPeriod] = useState<PeriodDraft>(() => draftOfPeriod(NEW_PERIOD))
  const [schedule, setSchedule] = useState<ScheduleDraft>(() => ({ ...defaultDraft(), ...(ctx.defaultKind === 'once' ? { kind: 'once' as const } : {}) }))

  const [threadMode, setThreadMode] = useState<'keep' | 'new'>(isMaster || ctx.defaultThread ? 'keep' : 'new')
  const [folder, setFolder] = useState(ctx.defaultThread?.folder ?? '')
  const [approval, setApproval] = useState(false)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // an automatic name as long as it hasn't been touched by hand
  useEffect(() => {
    if (!nameEdited) setName(autoName(prompt))
  }, [prompt, nameEdited])

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onFieldKeyDown(e: KeyboardEvent<HTMLElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const needsFolder = threadMode === 'keep' && isMaster
  const scheduleProblem = when === 'period' ? periodProblem(period, AUTOMATION_RULES, stagger) : draftProblem(schedule, nowTick || Date.now())
  const problem = !prompt.trim() ? null : needsFolder && folder.trim() === '' ? 'Anywhere needs a project to keep its conversation in.' : scheduleProblem
  const ready = prompt.trim() !== '' && problem === null

  const keep = (): { folder?: string; sessionId?: string } => ({
    ...(isMaster ? { folder: folder.trim() } : {}),
    ...(ctx.defaultThread?.sessionId ? { sessionId: ctx.defaultThread.sessionId } : {}),
  })

  async function save(): Promise<void> {
    setError(null)
    if (!ready) return
    setSaving(true)
    try {
      const p = when === 'period' ? periodOfDraft(period) : null
      const trigger = p ? ({ kind: 'period', period: p } as const) : triggerOfDraft(schedule)
      const thread: Thread = threadMode === 'new' ? { mode: 'new' } : { mode: 'keep', ...keep() }
      const saved = await api.automations.create({
        name: name.trim() || autoName(prompt) || 'Untitled automation',
        agentId: ctx.agentId,
        prompt,
        trigger,
        thread,
        approval,
      })
      onSaved(saved)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // the editor, with everything written here — the sheet closes behind it
  function moreOptions(): void {
    seedNextEditor({
      agentId: ctx.agentId,
      name: nameEdited ? name : '',
      prompt,
      when,
      period,
      schedule,
      threadMode,
      folder,
      approval,
      keep: threadMode === 'keep' ? keep() : null,
    })
    onClose()
    useStore.getState().changePage({ kind: 'automation', id: 'new', agent: ctx.agentId })
  }

  // «≈ what it means», over the period the server will stamp (the editor's words)
  const consequence = (() => {
    try {
      const p = stampedOfDraft(period, AUTOMATION_RULES, stagger)
      if (!p) return null
      const short = p.unit === 'minutes' || p.unit === 'hours'
      return `${capitalized(cadenceWords(p, 'run'))}${short && p.at ? `, from ${p.at}` : ''}.`
    } catch {
      return null
    }
  })()

  const switchLink = 'mt-2 rounded text-[12.5px] text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta'

  return (
    <div
      role="dialog"
      aria-label="Schedule automation"
      onKeyDown={onFieldKeyDown}
      // an in-flow sheet, not an overlay — border+panel like every other
      // dossier surface, no shadow (shadows are reserved for scrimmed
      // overlays elsewhere in the app).
      className="mx-auto mb-2 flex max-h-[min(36rem,70vh)] w-full max-w-[48rem] flex-col rounded-2xl border border-line bg-panel"
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <input
          type="text"
          aria-label="automation name"
          value={name}
          onChange={(e) => {
            setNameEdited(true)
            setName(e.target.value)
          }}
          placeholder="Automation name"
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-medium text-ink outline-none hover:border-line focus:border-terracotta"
        />
        <button type="button" aria-label="close" onClick={onClose} className="shrink-0 rounded p-1 text-ink-2 hover:bg-canvas hover:text-ink">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-1 pt-2">
        {/* what the agent should do — the composer's text, still editable */}
        <textarea
          aria-label="automation prompt"
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`What should ${agentName} do on each run?`}
          className="mb-3 w-full resize-none rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-sm text-ink outline-none focus:border-terracotta"
        />

        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
          <section className="min-w-0">
            <Label>When it runs</Label>
            <div className="mt-2">
              {when === 'period' ? (
                <>
                  <PeriodEditor
                    draft={period}
                    onChange={setPeriod}
                    problem={periodProblem(period, AUTOMATION_RULES, stagger)}
                    staggerMinute={stagger}
                    consequence={consequence}
                    testId="sheet-period"
                  />
                  <button type="button" onClick={() => setWhen('cron')} className={switchLink}>
                    or a date, or a cron expression ›
                  </button>
                </>
              ) : (
                <>
                  <ScheduleBuilder
                    draft={schedule}
                    onChange={setSchedule}
                    problem={draftProblem(schedule, nowTick || Date.now())}
                    nowMs={nowTick || Date.now()}
                  />
                  <button type="button" onClick={() => setWhen('period')} className={switchLink}>
                    or every so many minutes, hours, days or weeks ›
                  </button>
                </>
              )}
            </div>
          </section>

          <section className="min-w-0">
            <Label>How it runs</Label>
            <div role="radiogroup" aria-label="Conversation" className="mt-2 flex flex-col gap-1.5">
              {(['keep', 'new'] as const).map((mode) => {
                const disabled = mode === 'new' && isMaster
                return (
                  <label
                    key={mode}
                    className={`flex items-start gap-2 text-[13px] leading-5 ${disabled ? 'cursor-not-allowed text-ink-3' : threadMode === mode ? 'cursor-pointer text-ink' : 'cursor-pointer text-ink-2 hover:text-ink'}`}
                  >
                    <input
                      type="radio"
                      name="sheet-thread-mode"
                      className="mt-[3px] accent-terracotta"
                      checked={threadMode === mode}
                      disabled={disabled}
                      onChange={() => setThreadMode(mode)}
                    />
                    {mode === 'keep'
                      ? ctx.defaultThread?.sessionId
                        ? 'Keep this conversation across runs'
                        : 'Keep one conversation across runs'
                      : 'Start a new conversation each run'}
                  </label>
                )
              })}
              {isMaster ? <p className="text-[12px] text-ink-2">Anywhere has no folder of its own: it keeps one conversation in a project.</p> : null}
              {needsFolder ? (
                <input
                  type="text"
                  aria-label="project folder"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="/path/to/project"
                  className="w-full rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[12px] outline-none focus:border-terracotta"
                />
              ) : null}
            </div>
            <div className="mt-1 border-t border-line">
              <SwitchRow label="Ask me before each run" hint="Each run waits on Home until you approve or skip it." checked={approval} onChange={setApproval} />
            </div>
          </section>
        </div>
      </div>

      {error ? (
        <p role="alert" className="border-t border-line px-3 pt-2 text-xs text-terracotta">
          {error}
        </p>
      ) : null}
      <div className={`flex flex-wrap items-center gap-2 px-3 py-2.5 ${error ? '' : 'border-t border-line'}`}>
        <button type="button" data-testid="sheet-more-options" onClick={moreOptions} className="mr-auto text-[12.5px] text-ink-2 hover:text-terracotta">
          More options ›
        </button>
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-ink-2 hover:text-ink">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !ready}
          title={problem ?? undefined}
          className="rounded-lg bg-terracotta px-4 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Schedule'}
        </button>
      </div>
    </div>
  )
}
