// SiloRecordPage.tsx — the derived `record` surface of every kind (Task 8):
// one record's whole envelope in the standard's voice. Identity as the title,
// the state always as its plain-word label, anchors as links to their hubs,
// typed fields as the server already said them (money as money), preserved
// extras folded, children with their own envelopes, the owner's overlay with
// its conflict gesture, the needs-you entries this record fires with their
// dispatchable actions (set-field with an honest CAS 409, ack, message with
// the filled template shown before sending — Send it to the inbox, or make
// it a task for the producer), and the STORY: the journal's
// observed transitions («arrived paid» ≠ «was paid here») plus the kernel's
// action events, in one timeline. Nothing here knows a silo by name.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import { Fact, PageHeader } from '../PageHeader'
import { ConfirmButton } from '../ConfirmButton'
import { siloCrumb, SiloSeal, silosCrumb } from './SiloPage'
import { api, ApiError } from '../../lib/api'
import { FileViewer } from '../FileViewer'
import {
  agentWord,
  anchorLinks,
  editorFor,
  siloName,
  fillTemplate,
  parseEdit,
  momentWord,
  producerAgent,
  overlayRows,
  proposalWords,
  stateWord,
  storyOf,
  valueWord,
} from '../../lib/silo-view'
import { refreshTasks } from '../../hooks/useTasks'
import { useDarkMode } from '../Sidebar'
import { waitForSession } from '../tasks/TaskMode'
import { surfaceOfAgent } from '../../lib/give'
import { taskPageOfKey } from '../../lib/task-origin'
import { PLANS_SILO } from '../../lib/plan-record'
import { identityWords, labelOfKey, type TaskView } from '../../lib/tasks'
import { useTasks } from '../../hooks/useTasks'
import type { SiloProposalView, SiloRecordDetail } from '../../lib/types'

// A writable field the manifest gives no value list: edited in place, the
// same set-field the state select dispatches (CAS version riding along, a
// 409 said and re-read by the page). Text-shaped types as text, money as its
// amount with the record's currency kept, yes/no as a choice; what can't be
// typed honestly stays read-only and says why (lib/silo-view.ts editorFor).
function InlineEdit({
  field,
  clearable,
  onSave,
}: {
  field: { name: string; type: string; value: unknown; text: string }
  clearable: boolean
  onSave: (value: unknown) => Promise<void>
}) {
  const editor = editorFor(field)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [why, setWhy] = useState<string | null>(null)
  const label = field.name.split('.').pop() ?? field.name
  if (editor.kind === 'none') {
    return (
      <span className="break-words" title={editor.why}>
        {field.text}
      </span>
    )
  }
  if (editor.kind === 'boolean') {
    return (
      <select
        aria-label={`Set ${field.name}`}
        value={editor.initial ? 'true' : 'false'}
        onChange={(e) => void onSave(e.target.value === 'true')}
        className="rounded border border-line bg-panel px-1 py-0.5 text-[12.5px]"
      >
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    )
  }
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(editor.initial)
          setWhy(null)
          setEditing(true)
        }}
        className="group/e inline-flex max-w-full items-baseline gap-2 text-left"
        aria-label={`Edit ${field.name}`}
      >
        <span className="break-words">{field.text}</span>
        <span className="font-mono text-[10px] text-ink-3 group-hover/e:text-terracotta">edit</span>
      </button>
    )
  }
  const save = async (): Promise<void> => {
    const r = parseEdit(editor, draft, clearable)
    if (!r.ok) {
      setWhy(r.reason)
      return
    }
    setEditing(false)
    await onSave(r.value)
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <input
        autoFocus
        aria-label={`New ${label}`}
        value={draft}
        inputMode={editor.kind === 'money' ? 'decimal' : undefined}
        placeholder={editor.kind === 'text' ? editor.placeholder : ''}
        onChange={(e) => {
          setDraft(e.target.value)
          setWhy(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false)
        }}
        className={`min-w-0 rounded border border-line bg-panel px-1.5 py-0.5 text-[12.5px] outline-none focus:border-terracotta/60 ${editor.kind === 'money' ? 'w-28 text-right tabular-nums' : 'w-full max-w-[32ch]'}`}
      />
      {editor.kind === 'money' ? <span className="font-mono text-[11px] text-ink-2">{editor.currency}</span> : null}
      <button type="submit" className="text-[11px] font-medium text-terracotta hover:underline">
        Save
      </button>
      <button type="button" onClick={() => setEditing(false)} className="text-[11px] text-ink-2 hover:text-ink">
        Cancel
      </button>
      {why ? (
        <span role="alert" className="w-full text-[11.5px] text-terracotta">
          {why}
        </span>
      ) : null}
    </form>
  )
}

// The add form of a sub-kind the owner may append to (append-item): one input
// per text field the sub-kind declares — a note's text. The draft is cleared
// only once the write lands: a note lost to a failed write is the owner's
// typing gone (the page says why).
function AppendForm({
  collection,
  fields,
  onAdd,
  says,
}: {
  collection: string
  fields: Array<{ name: string; required: boolean; max: number | null }>
  onAdd: (values: Record<string, string>) => Promise<boolean>
  // what the box says instead of «Add a note» — a closed task of an agent in
  // play: «Write to X — reopens it» (the owner's note reopens it —
  // the same words as the task page)
  says?: string
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const one = collection.replace(/s$/, '')
  if (fields.length === 0) return null
  const ready = fields.every((f) => !f.required || (draft[f.name] ?? '').trim() !== '')
  return (
    <form
      className="mt-2 flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready) return
        void onAdd(draft).then((ok) => {
          if (ok) setDraft({})
        })
      }}
    >
      {fields.map((f) => (
        <input
          key={f.name}
          aria-label={fields.length === 1 ? (says ?? `Add a ${one}`) : `${one} ${f.name}`}
          value={draft[f.name] ?? ''}
          maxLength={f.max ?? undefined}
          placeholder={fields.length === 1 ? (says ?? `Add a ${one}`) : f.name}
          onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
          className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-[13px] outline-none focus:border-terracotta/60"
        />
      ))}
      <button
        type="submit"
        disabled={!ready}
        className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-[11px] text-ink-2 hover:border-terracotta hover:text-terracotta disabled:opacity-50"
      >
        Add {one}
      </button>
    </form>
  )
}

function Act({ onClick, children, primary = false }: { onClick: () => void; children: string; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? 'shrink-0 rounded-full border border-terracotta/40 bg-terracotta-soft px-2.5 py-0.5 text-[11px] font-medium text-terracotta hover:border-terracotta'
          : 'shrink-0 text-[11px] text-ink-2 underline-offset-2 hover:text-terracotta hover:underline'
      }
    >
      {children}
    </button>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-3">
      <h3 className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-3">{children}</h3>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  )
}

// a task's record key (<plan key>/tasks/<id>) as people say it: its label
// in the reading (`<project>#t3` on the project's list), else plan#id
function taskRefOf(key: string, tasks: readonly TaskView[]): string {
  return key.lastIndexOf('/tasks/') <= 0 ? key : labelOfKey(tasks, key)
}

export function SiloRecordPage({ siloId, recordKey }: { siloId: string; recordKey: string }) {
  const changePage = useStore((s) => s.changePage)
  const taskReading = useTasks()
  // the silo's name before the record has answered — the crumb never jumps
  const siloLabel = useStore((s) => {
    const d = s.silos.find((x) => x.id === siloId)
    return d ? siloName(d) : siloId
  })
  // the list view of this record's kind, when it is not the silo's first (its crumb goes back there)
  const lists = useStore((s) => s.silos.find((x) => x.id === siloId)?.lists)
  const selectAgent = useStore((s) => s.selectAgent)
  const agents = useStore((s) => s.agents)
  const openSession = useStore((s) => s.openSession)
  const [dark] = useDarkMode()
  // who «Make it a task for X ›» names (the server picks the same one)
  const descriptor = useStore((s) => s.silos.find((x) => x.id === siloId))
  const producer = useMemo(() => producerAgent(descriptor, agents), [descriptor, agents])
  const siloTick = useStore((s) => s.siloTick)
  const [detail, setDetail] = useState<SiloRecordDetail | null>(null)
  const [proposals, setProposals] = useState<SiloProposalView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [extraOpen, setExtraOpen] = useState(false)
  const [viewerPath, setViewerPath] = useState<string | null>(null)
  // the message composer: which template is chosen (index), filled preview shown
  const [templateIdx, setTemplateIdx] = useState<number | null>(null)
  // what the last send / make-task did, in plain words
  const [sentNote, setSentNote] = useState<string | null>(null)
  const [making, setMaking] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const d = await api.silos.record(siloId, recordKey)
      setDetail(d)
      setError(null)
      try {
        setProposals((await api.silos.proposals(siloId)).filter((p) => p.key === recordKey && p.status === 'pending'))
      } catch {
        setProposals([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDetail(null)
    }
  }, [siloId, recordKey])

  useEffect(() => {
    void load()
  }, [load, siloTick])

  // Every action re-reads the record: the page never pretends a write it has
  // not seen land. A 409 is the CAS speaking — said in plain words, with the
  // fresh version already loaded for the retry.
  async function act(run: () => Promise<unknown>): Promise<void> {
    try {
      await run()
      setNotice(null)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNotice('Someone wrote this record first — re-read; your change was not applied. Try again.')
      else setNotice(e instanceof Error ? e.message : String(e))
    }
    await load()
  }

  // a message from a declared template; the answer says who got it. No
  // message wakes anyone: it waits in the inbox and
  // is read at the producer's next conversation
  async function send(template: number): Promise<void> {
    try {
      const r = await api.silos.message(siloId, recordKey, template)
      const to = (r && Array.isArray(r.to) ? r.to : []).map((id) => agentWord(agents, id))
      const who = to.join(', ') || 'the producer'
      setSentNote(`Sent to ${who} — it waits in the inbox; ${to.length > 1 ? 'each reads it at its' : `${who} reads it at its`} next conversation.`)
      setNotice(null)
    } catch (e) {
      setSentNote(null)
      setNotice(e instanceof Error ? e.message : String(e))
    }
    await load()
  }

  // «Make it a task for X ›» (what «Wake the producer now» became):
  // the filled template becomes a task of the producer in its project's
  // list. On its own: the server gives it (assigned) — said. Only when told:
  // nothing starts without the owner — so the page opens X with it, on the
  // surface «Open» goes to (give.ts surfaceOfAgent: its console when it has
  // one, chat when not), as «Give and open …» does.
  async function makeTask(template: number): Promise<void> {
    setMaking(true)
    setSentNote(null)
    let made: { name: string; ref: string } | null = null
    try {
      const r = await api.silos.makeTask(siloId, recordKey, template)
      const name = agentWord(agents, r.to)
      made = { name, ref: r.ref }
      refreshTasks()
      if (r.assigned) {
        setSentNote(`Given to ${name} — it starts on its own (${r.ref}).`)
      } else if (r.control === 'own') {
        setSentNote(`Made ${r.ref} for ${name}, but it wasn't handed over${r.why ? `: ${r.why}` : ''}.`)
      } else if (surfaceOfAgent(agents.find((a) => a.id === r.to)) === 'chat') {
        const w = await api.tasksTalk(r.taskKey)
        if (w.isNew) await waitForSession(w.folder, w.sessionId)
        setSentNote(`Made ${r.ref} for ${name} — opening ${name} with it.`)
        useStore.getState().setChatMode('chat')
        await openSession(w.folder, w.sessionId)
      } else {
        const w = await api.workOnTask(r.taskKey, dark ? 'dark' : 'light')
        if (w.mode === 'new') await waitForSession(w.folder, w.sessionId)
        setSentNote(`Made ${r.ref} for ${name} — opening ${name} with it.`)
        useStore.getState().setChatMode('console')
        await openSession(w.folder, w.sessionId)
        if (w.warn) useStore.setState({ error: `Started — but ${w.warn}.` })
      }
      setNotice(null)
    } catch (e) {
      const words = e instanceof Error ? e.message : String(e)
      // made, but its conversation did not open: the task stands — say so
      setNotice(made ? `${made.ref} was made for ${made.name}, but ${made.name} did not open: ${words}` : words)
    } finally {
      setMaking(false)
    }
    await load()
  }

  const states = useMemo(() => detail?.kind.states ?? [], [detail])
  const story = useMemo(() => (detail ? storyOf(detail.history, detail.events, states, momentWord) : []), [detail, states])
  const overlay = useMemo(() => (detail ? overlayRows(detail) : []), [detail])
  const conflicts = overlay.filter((o) => o.conflict !== null)
  const anchors = detail ? anchorLinks(detail.record.anchors) : []
  // a closed plan TASK of an agent in play: the owner's note reopens it in
  // its own write — the box says so, by its name
  const reopensOnNote = (() => {
    if (!detail || siloId !== PLANS_SILO || !recordKey.includes('/tasks/')) return null
    if (detail.record.state !== 'done' && detail.record.state !== 'cancelled') return null
    const owner = (detail.value as Record<string, unknown> | undefined)?.owner
    const who = agents.find((a) => a.id === owner && !a.archived)
    return who ? who.name : null
  })()
  const setFieldAction = detail?.actions.find((a) => a.verb === 'set-field')
  // an owner-writable field that is not among the kind's declared fields —
  // the state usually, which lives in the envelope — still needs its row,
  // or the one action the silo declares would have no home on the page
  const writableExtras = (setFieldAction?.fields ?? [])
    .filter((w) => !(detail?.fields ?? []).some((f) => f.name === w.name))
    .map((w) => {
      // not a declared field: the state lives in the envelope; anything else
      // reads from what the file carries (extra), said as text
      const raw = w.name === 'state' ? (detail?.record.state ?? null) : (detail?.extra[w.name] ?? null)
      return {
        name: w.name,
        type: 'string',
        value: raw,
        text:
          w.name === 'state'
            ? (detail?.record.stateLabel ?? '—')
            : typeof raw === 'string' && raw !== ''
              ? raw
              : raw == null || raw === ''
                ? '—'
                : JSON.stringify(raw),
      }
    })
  // the kernel-verbs the silo declares on this kind (catalogs.md
  // «Kernel-verbs»): each door says the catalog's word, shows only where its
  // `when` holds for this record (`applies`), and its guard field — the
  // kernel's own bookkeeping for that door, never the record's voice — stays
  // out of the field list: the door is how it speaks
  const kernelVerbs = (detail?.actions ?? []).filter((a) => a.verb === 'kernel-verb' && typeof a.name === 'string')
  const guards = new Set(kernelVerbs.flatMap((a) => (a.guard ? [a.guard] : [])))
  const [verbBusy, setVerbBusy] = useState<string | null>(null)
  const [verbSaid, setVerbSaid] = useState<{ words: string; failed: boolean } | null>(null)
  // the door reads the catalog's pending word («Stopping…») from the
  // confirm until the answer AND the re-read record — never a mute button
  async function runVerb(name: string): Promise<void> {
    setVerbBusy(name)
    setVerbSaid(null)
    try {
      const r = await api.silos.kernelVerb(siloId, { key: recordKey, name })
      setVerbSaid({ words: r.says, failed: r.outcome === 'partial' })
    } catch (e) {
      setVerbSaid({ words: e instanceof Error ? e.message : String(e), failed: true })
    }
    try {
      await load()
    } finally {
      setVerbBusy(null)
    }
  }
  const messageAction = detail?.actions.find((a) => a.verb === 'message-agent')
  const canAck = detail?.actions.some((a) => a.verb === 'ack') ?? false
  const extraEntries = detail ? Object.entries(detail.extra) : []
  const folderAnchor = anchors.find((a) => a.hub === 'folder')?.value ?? null

  const openAnchor = (hub: string, value: string): void => {
    if (hub === 'agent') {
      if (agents.some((a) => a.id === value)) selectAgent(value)
    } else if (hub === 'folder') {
      changePage({ kind: 'project', folder: value })
    } else if (hub === 'task') {
      // a record hung from a plan task: its key is <plan key>/tasks/<id>
      const cut = value.lastIndexOf('/tasks/')
      if (cut > 0) changePage({ kind: 'task', plan: value.slice(0, cut), task: value.slice(cut + '/tasks/'.length) })
    } else if (hub === 'conversation') {
      // a conversation anchor carries '<folder>/<id>' — opened best-effort
      const cut = value.lastIndexOf('/')
      if (cut > 0) void useStore.getState().openSession(value.slice(0, cut), value.slice(cut + 1))
    }
  }

  // an attachment opens in the existing viewer when its project is known
  const attachmentPath = (rel: string): string | null => {
    if (rel.startsWith('/')) return rel
    return folderAnchor ? `${folderAnchor}/${rel}` : null
  }
  const ownKind = detail?.kind.name.slice(siloId.length + 1)
  const backView = (lists ?? []).findIndex((l) => l.kind === ownKind) > 0 ? lists!.find((l) => l.kind === ownKind)!.id : null

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <PageHeader
        testId="silo-record-header"
        crumbs={[silosCrumb(changePage), siloCrumb(changePage, siloId, detail?.silo.name ?? siloLabel, backView)]}
        seal={<SiloSeal silo={descriptor} />}
        // a record's identity is often a phrase: two lines, never cut short
        wrapTitle
        // an empty identity: the project's list's words, else «(untitled)»
        title={detail ? identityWords(detail.record) : <span className="text-ink-3">Reading…</span>}
        // its state, when, its anchors (each a door to its hub), the remarks
        facts={
          detail ? (
            <>
              <Fact className="text-ink">{detail.record.stateLabel}</Fact>
              {detail.record.at ? <Fact>{momentWord(detail.record.at)}</Fact> : null}
              {anchors.map((a) => (
                <Fact key={`${a.hub}:${a.value}`} truncate>
                  <button
                    type="button"
                    onClick={() => openAnchor(a.hub, a.value)}
                    className="min-w-0 truncate underline-offset-2 hover:text-terracotta hover:underline"
                  >
                    {a.hub === 'agent'
                      ? `with ${agentWord(agents, a.value)}`
                      : a.hub === 'folder'
                        ? `in ${a.value.split('/').filter(Boolean).pop()}`
                        : a.hub === 'task'
                          ? `for ${taskRefOf(a.value, taskReading.tasks)}`
                          : a.value}
                  </button>
                </Fact>
              ))}
              {detail.record.remarks.map((m) => (
                <Fact key={m} truncate className="text-ink-3">
                  <span className="min-w-0 truncate">{m}</span>
                </Fact>
              ))}
            </>
          ) : null
        }
        // a record with a dedicated surface names its house — this generic
        // page stays whole (machinery view), but the gesture lives there
        // (the owner answered a task from BOTH
        // boxes without knowing they were the same)
        actions={
          kernelVerbs.some((a) => a.applies) ? (
            <>
              {kernelVerbs
                .filter((a) => a.applies)
                .map((a) =>
                  verbBusy === a.name ? (
                    <span
                      key={a.name}
                      role="status"
                      data-testid="silo-verb-pending"
                      className="flex items-center gap-1.5 rounded-lg border border-terracotta/40 bg-terracotta-soft px-3 py-1.5 text-[13px] text-terracotta"
                    >
                      <span aria-hidden="true" className="inline-block size-[6px] rounded-full bg-terracotta motion-safe:animate-pulse" />
                      {a.pending ?? `${a.says ?? a.name}…`}
                    </span>
                  ) : (
                    <ConfirmButton
                      key={a.name}
                      onConfirm={() => void runVerb(a.name!)}
                      disabled={verbBusy !== null}
                      confirmLabel={`${a.says ?? a.name} it — sure?`}
                      className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink-2 hover:border-terracotta hover:text-terracotta disabled:opacity-50"
                      armedClassName="flex items-center gap-1.5 rounded-lg border border-terracotta bg-terracotta-soft px-3 py-1.5 text-[13px] font-medium text-terracotta"
                    >
                      {a.says ?? a.name!}
                    </ConfirmButton>
                  ),
                )}
            </>
          ) : undefined
        }
        notes={(() => {
          const house = detail && siloId === PLANS_SILO ? taskPageOfKey(recordKey) : null
          return house ? (
            <p className="mt-0.5 truncate text-[12.5px]">
              <button
                type="button"
                data-testid="record-house-door"
                onClick={() => changePage(house)}
                className="text-terracotta underline decoration-terracotta/40 underline-offset-2 hover:decoration-terracotta"
              >
                This task’s house ›
              </button>
              <span className="text-ink-3"> — its conversations, wakes and the answer box live there.</span>
            </p>
          ) : null
        })()}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[56rem] px-4 pb-12 pt-1 sm:px-5">
          {error ? (
            <div role="alert" className="mt-4 text-[13px] text-terracotta">
              {error}
            </div>
          ) : null}
          {notice ? (
            <div role="status" className="mt-4 rounded-lg border border-terracotta/40 bg-terracotta-soft px-3 py-2 text-[12.5px] text-ink">
              {notice}
            </div>
          ) : null}
          {verbSaid ? (
            <p role="status" data-testid="silo-verb-said" className={`mt-4 text-[13px] ${verbSaid.failed ? 'text-terracotta' : 'text-ink-2'}`}>
              {verbSaid.words}
            </p>
          ) : null}

          {detail ? (
            <>
              {/* what this record asks of you — the one live thing on the page */}
              {detail.needsYou.length > 0 || conflicts.length > 0 || proposals.length > 0 ? (
                <div className="mt-5 flex flex-col gap-2">
                  {conflicts.map((c) => (
                    <div key={c.field} className="rounded-lg border border-terracotta/40 bg-terracotta-soft px-3 py-2.5" data-testid="silo-conflict">
                      <p className="text-[13.5px] text-ink">
                        you set <span className="font-mono text-[12.5px]">{c.field}</span> to{' '}
                        <strong className="font-semibold">{valueWord(c.owner, states)}</strong>; the source now says{' '}
                        <strong className="font-semibold">{valueWord(c.conflict!.sourceValue, states)}</strong>
                        <span className="text-ink-2"> (it held {valueWord(c.base, states)} when you wrote)</span>
                      </p>
                      <div className="mt-1.5 flex items-center gap-3">
                        <Act primary onClick={() => void act(() => api.silos.resolve(siloId, recordKey, c.field, 'keep-mine'))}>
                          Keep mine
                        </Act>
                        <Act onClick={() => void act(() => api.silos.resolve(siloId, recordKey, c.field, 'take-source'))}>Take the source's</Act>
                      </div>
                    </div>
                  ))}
                  {proposals.map((p) => (
                    <div key={p.id} className="rounded-lg border border-terracotta/40 bg-terracotta-soft px-3 py-2.5" data-testid="silo-proposal">
                      <p className="text-[13.5px] text-ink">{proposalWords(p, states)}</p>
                      {p.note ? <p className="mt-0.5 text-[12.5px] text-ink-2">{p.note}</p> : null}
                      <div className="mt-1.5 flex items-center gap-3">
                        <Act primary onClick={() => void act(() => api.silos.decideProposal(siloId, p.id, 'approve'))}>
                          Approve
                        </Act>
                        <Act onClick={() => void act(() => api.silos.decideProposal(siloId, p.id, 'reject'))}>Reject</Act>
                      </div>
                    </div>
                  ))}
                  {detail.needsYou.map((n) => (
                    <div key={n.entry} className="rounded-lg border border-line bg-panel px-3 py-2.5" data-testid="silo-needs-you">
                      <p className="text-[13.5px] text-ink">
                        <span className={`font-mono text-[11px] ${n.urgency === 'blocking' ? 'text-terracotta' : 'text-ink-2'}`}>{n.urgency}</span>
                        <span className="text-ink-2"> — this one is yours to do</span>
                        {n.clears ? <span className="block font-mono text-[11px] text-ink-3">clears when {n.clears}</span> : null}
                      </p>
                      {canAck ? (
                        <div className="mt-1.5">
                          <Act onClick={() => void act(() => api.silos.ack(siloId, recordKey))}>Seen</Act>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}

              {/* the fields, in the kind's own vocabulary */}
              <section className="mt-7">
                <SectionLabel>Fields</SectionLabel>
                <dl className="mt-2 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
                  {[...detail.fields.filter((f) => !guards.has(f.name)), ...writableExtras].map((f) => {
                    // an object field (a task's waitingOn {owner, action}) is
                    // written by Silos for the owner, never typed here as text
                    const writable = f.type === 'object' ? undefined : setFieldAction?.fields?.find((w) => w.name === f.name)
                    // a field with no value is not drawn (a running
                    // process has no exitedAt) — unless the owner may write
                    // it here: then its row is where the value goes
                    if (!writable && (f.value === null || f.value === undefined || f.value === '')) return null
                    const path = f.type === 'attachment' && typeof f.value === 'string' ? attachmentPath(f.value) : null
                    return (
                      <div key={f.name} className="flex items-baseline gap-3 border-b border-line/50 py-1">
                        <dt className="w-[16ch] shrink-0 break-all font-mono text-[11px] text-ink-3" title={'label' in f && f.label ? f.name : undefined}>
                          {'label' in f && f.label ? f.label : f.name.split('.').pop()}
                        </dt>
                        <dd className="min-w-0 flex-1 text-[13px] text-ink">
                          {writable && !writable.values ? (
                            <InlineEdit
                              field={f}
                              clearable={writable.clearable === true}
                              onSave={(value) =>
                                act(() =>
                                  api.silos.setField(siloId, { key: recordKey, field: f.name, value, ...(detail.version ? { version: detail.version } : {}) }),
                                )
                              }
                            />
                          ) : writable && writable.values ? (
                            <select
                              aria-label={`Set ${f.name}`}
                              value={typeof f.value === 'string' ? f.value : ''}
                              onChange={(e) =>
                                void act(() =>
                                  api.silos.setField(siloId, {
                                    key: recordKey,
                                    field: f.name,
                                    value: e.target.value,
                                    ...(detail.version ? { version: detail.version } : {}),
                                  }),
                                )
                              }
                              className="rounded border border-line bg-panel px-1 py-0.5 text-[12.5px]"
                            >
                              {writable.values.map((v) => (
                                <option key={v} value={v}>
                                  {stateWord(states, v)}
                                </option>
                              ))}
                            </select>
                          ) : path ? (
                            <button
                              type="button"
                              onClick={() => setViewerPath(path)}
                              className="break-all text-left underline-offset-2 hover:text-terracotta hover:underline"
                            >
                              {f.text}
                            </button>
                          ) : (
                            <span className="break-words">{f.text}</span>
                          )}
                          {overlay.some((o) => o.field === f.name && o.conflict === null) ? (
                            <span className="ml-2 font-mono text-[10px] text-ink-3" title="your value stands over the source's until it catches up">
                              your edit stands
                            </span>
                          ) : null}
                        </dd>
                      </div>
                    )
                  })}
                </dl>
                {extraEntries.length > 0 ? (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setExtraOpen((v) => !v)}
                      className="font-mono text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                    >
                      {extraEntries.length} field{extraEntries.length === 1 ? '' : 's'} preserved as written {extraOpen ? '— hide' : '— show'}
                    </button>
                    {extraOpen ? (
                      <pre className="mt-1 overflow-x-auto rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[11px] text-ink-2">
                        {JSON.stringify(detail.extra, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </section>

              {/* a message to the producer, from the declared templates — the
                  exact filled line is shown BEFORE anything is sent */}
              {messageAction?.templates && messageAction.templates.length > 0 ? (
                <section className="mt-7">
                  <SectionLabel>Message the producer</SectionLabel>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {messageAction.templates.map((t, i) => (
                      <li key={t}>
                        {templateIdx === i ? (
                          <div className="rounded-lg border border-line bg-panel px-3 py-2">
                            <p className="text-[13px] text-ink" data-testid="silo-template-preview">
                              {fillTemplate(t, detail)}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-3">
                              <Act
                                primary
                                onClick={() => {
                                  setTemplateIdx(null)
                                  void send(i)
                                }}
                              >
                                Send
                              </Act>
                              {producer ? (
                                <Act
                                  onClick={() => {
                                    if (making) return
                                    setTemplateIdx(null)
                                    void makeTask(i)
                                  }}
                                >{`Make it a task for ${producer.name} ›`}</Act>
                              ) : null}
                              <Act onClick={() => setTemplateIdx(null)}>Cancel</Act>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setTemplateIdx(i)
                              setSentNote(null)
                            }}
                            className="text-left text-[12.5px] text-ink-2 underline-offset-2 hover:text-terracotta hover:underline"
                          >
                            {fillTemplate(t, detail)}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {sentNote ? (
                    <p role="status" className="mt-2 text-[12px] text-ink-2" data-testid="silo-sent-note">
                      {sentNote}
                    </p>
                  ) : null}
                </section>
              ) : null}

              {/* children: sub-kind records inside this file, each with its envelope */}
              {/* a child's identity links to its own url when it carries one
                  (a mail thread); who wrote it is said (a note's author); the
                  owner's verbs on a sub-kind sit with it — «move to…» per
                  child (move-item), an add form under the list (append-item) */}
              {detail.children
                .filter((c) => c.rows.length > 0 || c.append)
                .map((c) => (
                  <section key={c.collection} className="mt-7">
                    <SectionLabel>{c.collection}</SectionLabel>
                    <ul className="mt-2 flex flex-col">
                      {c.rows.map((k) => (
                        <li key={k.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line/50 py-1.5">
                          <span className="min-w-0 flex-1 text-[13px] text-ink">
                            {k.by ? <span className="mr-1.5 font-mono text-[11px] text-ink-3">{k.by} —</span> : null}
                            {k.url ? (
                              <a href={k.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-terracotta hover:underline">
                                {k.identity || k.id}
                              </a>
                            ) : (
                              k.identity || k.id
                            )}
                          </span>
                          <span className="shrink-0 font-mono text-[11.5px] text-ink-2">
                            {k.stateLabel}
                            {k.at ? `${k.stateLabel ? ' · ' : ''}${momentWord(k.at)}` : ''}
                          </span>
                          {c.move && c.move.targets.length > 0 ? (
                            <select
                              aria-label={`Move ${k.identity || k.id} to`}
                              value=""
                              onChange={(e) => {
                                const to = e.target.value
                                if (to) void act(() => api.silos.move(siloId, `${recordKey}/${c.collection}/${k.id}`, to, detail.version ?? undefined))
                              }}
                              className="shrink-0 rounded border border-line bg-panel px-1 py-0.5 text-[12px] text-ink-2"
                            >
                              <option value="">move to…</option>
                              {c.move.targets.map((t) => (
                                <option key={t.key} value={t.key}>
                                  {t.label}
                                </option>
                              ))}
                            </select>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {c.append ? (
                      <AppendForm
                        collection={c.collection}
                        fields={c.append.fields}
                        {...(c.collection === 'notes' && reopensOnNote ? { says: `Write to ${reopensOnNote} — reopens it` } : {})}
                        onAdd={async (values) => {
                          try {
                            await api.silos.append(siloId, {
                              key: recordKey,
                              collection: c.collection,
                              values,
                              ...(detail.version ? { version: detail.version } : {}),
                            })
                            setNotice(null)
                            await load()
                            return true
                          } catch (e) {
                            setNotice(
                              e instanceof ApiError && e.status === 409
                                ? 'Someone wrote this record first — re-read; your note was not added. Try again.'
                                : e instanceof Error
                                  ? e.message
                                  : String(e),
                            )
                            await load()
                            return false
                          }
                        }}
                      />
                    ) : null}
                  </section>
                ))}

              {/* the story: what the journal observed + what actions did. The
                  first observation is a baseline — «arrived», never «became». */}
              <section className="mt-7">
                <SectionLabel>Story</SectionLabel>
                {story.length === 0 ? (
                  <p className="mt-2 font-mono text-[11px] text-ink-3">nothing observed yet</p>
                ) : (
                  <ul className="mt-2 flex flex-col">
                    {story.map((l, i) => (
                      <li key={`${l.at}-${i}`} className="flex items-baseline gap-3 border-b border-line/50 py-1.5">
                        <span className="w-[18ch] shrink-0 font-mono text-[11px] text-ink-3">{momentWord(l.at)}</span>
                        <span className={`min-w-0 flex-1 text-[13px] ${l.source === 'event' ? 'text-ink' : 'text-ink-2'}`}>{l.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {detail.record.file ? (
                <p className="mt-7 font-mono text-[10.5px] text-ink-3">
                  <button
                    type="button"
                    onClick={() => setViewerPath(detail.record.file)}
                    className="break-all text-left underline-offset-2 hover:text-ink hover:underline"
                  >
                    {detail.record.file}
                  </button>
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {viewerPath ? <FileViewer path={viewerPath} onClose={() => setViewerPath(null)} /> : null}
    </div>
  )
}
