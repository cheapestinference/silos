// routes/silos.ts — the Silo Standard's REST surface (registry, submissions,
// install/uninstall, operator, relations, records and their actions,
// producer routes, validate), moved VERBATIM out of server.ts (split the
// monoliths by domain, behavior unchanged). Registered
// unconditionally; the old `if (siloRegistry)` guard moved inside.
import { initiativeNow } from '../initiative.js'
import type { LiveTurn } from '../live-turns.js'
import { URGENT_GONE } from './messages.js'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { territoriesOf } from '../territory.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { AgentStateStore } from '../agent-state.js'
import type { SessionIndex } from '../session-index.js'
import type { SessionMeta } from '../types.js'
import type { LineageStore } from '../lineage.js'
import { taskThreads, type TaskThreads } from '../task-threads.js'
import { sessionTasks, sessionTasksBySession, type SessionTasksInput } from '../session-tasks.js'
import type { SiloRegistry } from '../silos/registry.js'
import type { ValidateRoute } from '../silos/validator.js'
import type { SiloKernel } from '../silos/kernel.js'
import type { SiloSurfaces } from '../silos/surfaces.js'
import type { TransitionJournal } from '../silos/journal.js'
import { outsideDetail, recordDetail, recordKeyOfFile, recordsPage, type NoteProvenance, type RecordsQuery } from '../silos/views.js'
import { readOutside } from '../silos/reader.js'
import { recordKey } from '../silos/journal.js'
import type { SiloActions, ActionResult, KernelVerbImpl } from '../silos/actions.js'
import type { SiloInstaller } from '../silos/installer.js'
import { availableSilos, availableManifest } from '../silos/catalog.js'
import type { SiloOperatorStore } from '../silos/operator.js'
import { relationsOf, RelationStore, type EndpointState, type RelationDecl } from '../silos/relations.js'
import { isAbsolute } from 'node:path'
import type { Resident } from '../resident.js'
import { PLANS_SILO } from '../plans-floor.js'
import { wakesOfControl, withWakes } from '../conversation-live.js'
import type { TaskModeEngine } from '../task-mode/engine.js'
import { recordWriters } from '../record-writers.js'
import { respondToGate } from '../silos/respond.js'
import { authorOf } from '../author.js'
import { baseRecordOf } from '../silos/voice.js'
import { ClosedPlans } from '../plans-closed.js'

export interface SiloRoutesCtx {
  siloRegistry: SiloRegistry | undefined
  siloInstaller: SiloInstaller | undefined
  siloOperator: SiloOperatorStore | undefined
  siloKernel: SiloKernel | undefined
  siloSurfaces: SiloSurfaces | undefined
  siloJournal: TransitionJournal | undefined
  siloActions: SiloActions | undefined
  siloRelations: RelationStore | undefined
  siloValidate: ValidateRoute | undefined
  registry: AgentRegistry
  agentState: AgentStateStore | undefined
  taskMode: TaskModeEngine | undefined
  index: SessionIndex
  resident: Resident | undefined
  classifyAgentId: (m: SessionMeta) => string
  broadcast: (msg: unknown) => void
  // how the conversation⇄task inverse closes over rotations: a
  // task lists the conversation it was worked in; the owner may be
  // looking at that thread's TIP after a rotation, and both must read as one
  // thread (task-threads.ts threadMembership — deep walk, trash-proof)
  lineage?: LineageStore
  // the task threads index.ts reads once per ttl (threadKey, currentOf — the
  // R13 current conversations); absent (tests), a fresh reading per request
  threadsOfTasks?: (ttlMs: number) => TaskThreads
  // a console key → the native id its engine sealed (terminals.nativeIdOf)
  nativeIdOf?: (key: string) => string | null
  // the kernel's own verbs, by name (KERNEL_VERBS — server.ts wires
  // stop-process to the process engine); absent or missing a name: 503 said
  kernelVerbs?: Readonly<Record<string, KernelVerbImpl>>
  // read a silo again when what it presents moved since its last reading
  // (the System silo's gauges: at most one scan old) — before a records answer
  freshen?: (id: string) => void
}

export function siloRoutes(app: FastifyInstance, ctx: SiloRoutesCtx): void {
  const {
    siloRegistry,
    siloInstaller,
    siloOperator,
    siloKernel,
    siloSurfaces,
    siloJournal,
    siloActions,
    siloRelations,
    siloValidate,
    registry,
    taskMode,
    index,
    classifyAgentId,
    broadcast,
    lineage,
  } = ctx
  if (!siloRegistry) return
  // a task of a CLOSED plan (plans/closed/) still resolves by its key —
  // read-only, for references only (the conversation's chip, the task's
  // page), never in a list (plans-closed.ts)
  const closedPlans = siloKernel
    ? new ClosedPlans({
        siloId: PLANS_SILO,
        manifest: () => {
          const e = siloRegistry.get(PLANS_SILO)
          return e?.manifest && e.status.state === 'active' ? (e.manifest as Record<string, unknown>) : null
        },
        conventionDirs: () =>
          siloKernel
            .watchedFolders()
            .filter((w) => w.silo === PLANS_SILO)
            .map((w) => w.dir),
      })
    : null
  // The silos this Silos knows (silos/registry.ts): one descriptor per silo
  // — state and its reason in plain words, derived conventions, wants,
  // kinds, slots — what a web paints without asking by name (the
  // /api/harnesses pattern). Owner-only: an agent bearer is refused by
  // agentMayRead (not in its read allow-list; agents don't manage silos in v0).
  // every id this Silos already holds SOMEWHERE — the catalog offers only
  // what is held nowhere (one id, one home: installed/pending silos, a
  // waiting submission, an operator decision incl. uninstalled, kernel
  // words and ids approved once)
  const siloHeldIds =
    siloInstaller && siloOperator
      ? (): Set<string> => {
          const r = siloRegistry.reservedIds()
          return new Set([
            ...siloRegistry.describe().map((d) => d.id),
            ...siloInstaller.submissions().map((s) => s.id),
            ...siloOperator.list().map((s) => s.id),
            ...r.kernel,
            ...r.approved,
          ])
        }
      : null
  // With the installer, the same answer carries what Settings › Silos paints
  // (additive): per silo the submission waiting for it and its sync
  // automation, and `uninstalled` — the silos the owner took out, what
  // stayed on disk and whether a manifest was kept to reinstall from.
  app.get('/api/silos', async () => {
    // recommended / optional / null (the owner's own) — Settings › Silos
    // groups by it, and a recommended one carries what uninstalling it gives up
    const lineupOf = siloInstaller ? siloInstaller.lineup() : null
    return {
      silos: siloRegistry.describe().map((d) => ({
        ...d,
        // Task mode's producers are DERIVED: every
        // agent On its own — never the operator's stored list
        producers: d.id === 'task-mode' && taskMode ? [...taskMode.boundAgents()] : (siloOperator?.producersOf(d.id) ?? null),
        // audience routing: the silo page says whose queue the
        // needs-you entries are — same derivation as the board (surfaces.ts)
        ...(siloSurfaces ? { routing: siloSurfaces.routing(d.id) } : {}),
        ...(siloInstaller ? { submission: siloInstaller.pendingOf(d.id), automation: siloInstaller.automationOf(d.id) } : {}),
        // how it came (silos/native.ts): 'builtin' = it comes with Silos —
        // the page says so; and, for an id Silos still serves natively, the
        // words that refuse submitting it (the page offers no door then)
        ...(siloInstaller ? { provenance: siloInstaller.provenanceOf(d.id), native: siloInstaller.nativeRefusal(d.id) } : {}),
        ...(lineupOf ? lineupOf(d.id) : {}),
      })),
      ...(siloInstaller ? { uninstalled: siloInstaller.uninstalled().map((u) => ({ ...u, ...lineupOf!(u.id) })) } : {}),
      // what this Silos DISTRIBUTES (silos/catalog.ts): the standard's
      // optional manifests whose id is held nowhere — Settings › Silos lists
      // them under «Optional», and installing one is a normal submission
      ...(siloInstaller && siloOperator ? { available: availableSilos({ heldIds: siloHeldIds!, dimensions: siloInstaller.dimensions }) } : {}),
    }
  })

  // Installing (silos/installer.ts). Submitting is open to agent bearers —
  // it is THEIR gesture, and it always lands pending; everything else here
  // is the owner's. Routes with a fixed segment (submissions, operator)
  // win over /:id in Fastify; both words are kernel-reserved ids.
  if (siloInstaller) {
    app.post<{ Body: unknown }>('/api/silos/submissions', async (req, reply) => {
      const r = siloInstaller.submit(req.body ?? null, req.agentId ?? 'owner')
      return reply.code(r.code).send(r.body)
    })
    app.get('/api/silos/submissions', async () => ({ submissions: siloInstaller.submissions() }))
    // ?producers=a,b (empty = none): the binding the owner is weighing —
    // requirements and the proposed automation re-derived for it
    app.get<{ Params: { id: string }; Querystring: { producers?: string } }>('/api/silos/submissions/:id/consequences', async (req, reply) => {
      const raw = req.query.producers
      const producers =
        raw === undefined
          ? undefined
          : raw
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '')
      const bad = producers ? siloInstaller.notAgents(producers) : []
      if (bad.length > 0) return reply.code(400).send({ error: `not agents: ${bad.join(', ')}` })
      const c = siloInstaller.consequences(req.params.id, producers ? { producers } : {})
      return c ?? reply.code(404).send({ error: `no pending submission of ${req.params.id}` })
    })
    app.post<{ Params: { id: string }; Body: unknown }>('/api/silos/submissions/:id/approve', async (req, reply) => {
      const r = siloInstaller.approve(req.params.id, req.body ?? null)
      return reply.code(r.code).send(r.body)
    })
    app.post<{ Params: { id: string }; Body: { reason?: unknown } | null }>('/api/silos/submissions/:id/reject', async (req, reply) => {
      const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason : null
      const r = siloInstaller.reject(req.params.id, reason)
      return reply.code(r.code).send(r.body)
    })
    app.post<{ Params: { id: string } }>('/api/silos/:id/uninstall', async (req, reply) => {
      const r = siloInstaller.uninstall(req.params.id)
      return reply.code(r.code).send(r.body)
    })
    // the owner's door back (Settings › Silos): submit the manifest Silos
    // already holds — kept at an uninstall, or sitting pending in the
    // registry — so the dialog at /silo/<id>/review can approve it. A
    // submission already waiting answers 409 with it (never stacked).
    app.post<{ Params: { id: string } }>('/api/silos/:id/resubmit', async (req, reply) => {
      const r = siloInstaller.resubmit(req.params.id)
      return reply.code(r.code).send(r.body)
    })
    // installing from the catalog (silos/catalog.ts): the reference
    // manifest goes through submit() like any submission — the fixed
    // segment wins over /:id and `available` is a kernel-reserved id
    app.post<{ Params: { id: string } }>('/api/silos/available/:id/submit', async (req, reply) => {
      // a dimension Silos still serves natively is never offered — said, not 404'd
      const native = siloInstaller.nativeRefusal(req.params.id)
      if (native !== null) return reply.code(409).send({ error: native, native: true })
      const manifest = siloHeldIds ? availableManifest({ heldIds: siloHeldIds, dimensions: siloInstaller.dimensions }, req.params.id) : null
      if (!manifest) return reply.code(404).send({ error: `${req.params.id} is not in the catalog — nothing available by that id` })
      const r = siloInstaller.submit({ manifest }, 'owner')
      return reply.code(r.code).send(r.body)
    })
    app.patch<{ Params: { id: string }; Body: unknown }>('/api/silos/:id/operator', async (req, reply) => {
      // Task mode's producers are DERIVED from each agent's control —
      // never operated here
      const body = req.body
      if (req.params.id === 'task-mode' && body && typeof body === 'object' && 'producers' in body) {
        return reply.code(409).send({ error: "who moves on its own is each agent's control — set it on the agent's page" })
      }
      const r = siloInstaller.operatorPatch(req.params.id, req.body ?? null)
      return reply.code(r.code).send(r.body)
    })
    // the operator's state, whole — exportable (silos/operator.json)
    if (siloOperator) app.get('/api/silos/operator', async () => siloOperator.export())
  }
  // A silo's RELATIONS (silos/relations.ts, step 4 edge-only silos): the
  // edges the manifest declares, written by the OWNER alone — an agent
  // bearer is refused here as well as by agent-authz (reads and writes of
  // /api/silos are outside its allow-lists): a title or a reporting line
  // gives no access, and an agent never draws its own place.
  {
    const relationStore = siloRelations ?? new RelationStore(siloRegistry.root)
    const agentLookup = {
      stateOf: (id: string): EndpointState => {
        const a = registry.list(true).find((x) => x.id === id)
        return !a ? 'gone' : a.archived ? 'archived' : 'ok'
      },
      projectsOf: (id: string): string[] => {
        const a = registry.list(true).find((x) => x.id === id)
        return a ? territoriesOf(a) : []
      },
    }
    const nameOfAgent = (id: string): string => registry.list(true).find((a) => a.id === id)?.name ?? id
    const relationOf = (siloId: string, name: string): { decl: RelationDecl } | { code: number; error: string } => {
      const e = siloRegistry.get(siloId)
      if (!e || !e.manifest) return { code: 404, error: `no silo ${siloId}` }
      const decl = relationsOf(e.manifest).find((r) => r.name === name)
      if (!decl) return { code: 404, error: `${e.status.manifest.name ?? siloId} declares no relation ${name}` }
      if (e.status.state !== 'active')
        return { code: 409, error: `${e.status.manifest.name ?? siloId} is ${e.status.state} — its relations are drawn once it is active` }
      return { decl }
    }
    app.get<{ Params: { id: string; name: string } }>('/api/silos/:id/relations/:name', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not read relations — they are the owner's` })
      const r = relationOf(req.params.id, req.params.name)
      if ('error' in r) return reply.code(r.code).send({ error: r.error })
      return { silo: req.params.id, relation: r.decl, edges: relationStore.list(req.params.id, r.decl.name, agentLookup) }
    })
    // body {from, to}: the one edge from `from` (to null clears it)
    app.put<{ Params: { id: string; name: string }; Body: { from?: unknown; to?: unknown } | null }>('/api/silos/:id/relations/:name', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not write relations — only the owner draws them` })
      const r = relationOf(req.params.id, req.params.name)
      if ('error' in r) return reply.code(r.code).send({ error: r.error })
      const b = req.body ?? {}
      if (typeof b.from !== 'string' || b.from === '' || (b.to !== null && (typeof b.to !== 'string' || b.to === '')))
        return reply.code(400).send({ error: 'send {"from": "<agent id>", "to": "<agent id>" | null}' })
      const w = relationStore.set(req.params.id, r.decl, b.from, b.to as string | null, agentLookup, nameOfAgent)
      if (!w.ok) return reply.code(w.code).send({ error: w.reason })
      broadcast({ ev: 'silos' })
      return { silo: req.params.id, relation: r.decl, edges: relationStore.list(req.params.id, r.decl.name, agentLookup) }
    })
  }
  // A silo's records, merged with the owner's overlay — server-paginated,
  // counted over the whole set, the cut said (silos/views.ts). What the
  // list page paints; and one record with its journal story (the record
  // page). The record key travels in the query (it holds '/' and ':').
  if (siloKernel) {
    // the same voice Home's rows are said in (silos/surfaces.ts voice): the
    // task flow's live facts and agents' names included — a list row and a
    // Needs you row never disagree
    const voiceOf = (id: string) =>
      siloSurfaces?.voice(id, Date.now()) ?? {
        now: Date.now(),
        isAgent: (v: string) => registry.list(true).some((a) => a.id === v),
        since: siloKernel.sinceFor(id),
      }
    // who wrote each note of a plan task (09-11b A4): task mode's ONE check
    // (owner-notes.ts), stamped as `fromOwner` on every note the answer
    // carries — the web paints «You» from it, never from the file's `by`
    const notesOf = (id: string): { notes?: NoteProvenance } => (id === PLANS_SILO && taskMode ? { notes: taskMode.ownerNoteCheck() } : {})
    app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>('/api/silos/:id/records', async (req, reply) => {
      const entry = siloRegistry.get(req.params.id)
      if (!entry) return reply.code(404).send({ error: `no silo ${req.params.id}` })
      const q = req.query
      try {
        ctx.freshen?.(entry.id)
      } catch {
        /* the last reading answers */
      }
      const num = (v: string | undefined): number | undefined => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined)
      if (q.folded !== undefined && !['include', 'exclude', 'only'].includes(q.folded))
        return reply.code(400).send({ error: 'folded must be include, exclude or only' })
      const facets = Object.fromEntries(
        Object.entries(q)
          .filter(([k, v]) => k.startsWith('facet.') && typeof v === 'string')
          .map(([k, v]) => [k.slice('facet.'.length), v as string]),
      )
      if (q.rank !== undefined && q.rank !== 'needs-you') return reply.code(400).send({ error: 'rank must be needs-you' })
      const query: RecordsQuery = {
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.state ? { state: q.state } : {}),
        facets,
        ...(q.id ? { id: q.id } : {}),
        ...(q.file ? { file: q.file } : {}),
        ...(q.rank === 'needs-you' ? { rank: 'needs-you' as const } : {}),
        ...(q.folded ? { folded: q.folded as RecordsQuery['folded'] } : {}),
        ...(q.q !== undefined && q.q.trim() !== '' ? { q: q.q.slice(0, 200) } : {}),
        ...(num(q.offset) !== undefined ? { offset: num(q.offset)! } : {}),
        ...(num(q.limit) !== undefined ? { limit: num(q.limit)! } : {}),
        ...(q.values === '1' || q.values === 'true' ? { values: true } : {}),
      }
      const reading = siloKernel.reading(entry.id)
      const overlayKeys = new Set((reading?.records ?? []).filter((r) => r.overlay).map((r) => recordKey(r)))
      const conflictKeys = new Set(siloKernel.overlayState(entry.id).conflicts.map((c) => c.key))
      const folderOf = (agentId: string): string | null => registry.list(true).find((a) => a.id === agentId)?.folder ?? null
      const page = recordsPage(
        entry,
        reading,
        {
          voice: voiceOf(entry.id),
          overlayKeys,
          conflictKeys,
          folderOf,
          ...(siloJournal ? { journal: siloJournal } : {}),
          ...(query.values ? notesOf(entry.id) : {}),
        },
        query,
      )
      if ('error' in page) return reply.code(400).send(page)
      return page
    })
    // ?key=<record key>, or ?file=<absolute path> — a page that knows the
    // FILE (plans: the column's PlanView, the FileViewer) asks by path; the
    // path is matched against the reading, never opened
    app.get<{ Params: { id: string }; Querystring: { key?: string; file?: string } }>('/api/silos/:id/record', async (req, reply) => {
      const entry = siloRegistry.get(req.params.id)
      if (!entry) return reply.code(404).send({ error: `no silo ${req.params.id}` })
      try {
        ctx.freshen?.(entry.id)
      } catch {
        /* the last reading answers */
      }
      const reading = siloKernel.reading(entry.id)
      let key = typeof req.query.key === 'string' && req.query.key !== '' ? req.query.key : null
      if (key === null && typeof req.query.file === 'string' && req.query.file !== '') {
        if (!isAbsolute(req.query.file)) return reply.code(400).send({ error: 'file must be an absolute path' })
        key = recordKeyOfFile(reading, req.query.file)
        // a file no location of the silo holds (G12 — a plan authored in a
        // folder no agent lives in, one under plans/closed/): the owner may
        // still read it by its path, said «outside», never written
        if (key === null && req.agentId === undefined && entry.manifest && entry.status.state === 'active') {
          const o = readOutside(entry.id, entry.manifest, req.query.file, {
            now: Date.now(),
            isAgent: (v: string) => registry.list(true).some((a) => a.id === v),
          })
          if (o && 'unreadable' in o) return reply.code(422).send({ error: `${req.query.file} can't be read as ${entry.id}: ${o.unreadable}` })
          const d = o ? outsideDetail(entry, o, voiceOf(entry.id), undefined, notesOf(entry.id).notes) : null
          if (d) return d
        }
        if (key === null) return reply.code(404).send({ error: `no record of ${entry.id} is read from ${req.query.file}` })
      }
      if (key === null) return reply.code(400).send({ error: 'key (or file) required' })
      const d = recordDetail(entry, reading, key, {
        voice: voiceOf(entry.id),
        ...(siloJournal ? { journal: siloJournal } : {}),
        ...(siloActions ? { events: (k: string) => siloActions.events(entry.id, k) } : {}),
        ...notesOf(entry.id),
      })
      if (!d) {
        // a plan the protocol moved to plans/closed/: its tasks keep their
        // key, read-only and said closed (the owner's only, like outside)
        const closed =
          req.agentId === undefined && entry.id === PLANS_SILO
            ? closedPlans?.resolve(key, { now: Date.now(), isAgent: (v: string) => registry.list(true).some((a) => a.id === v) })
            : null
        const cd = closed ? outsideDetail(entry, closed, voiceOf(entry.id), key, notesOf(entry.id).notes) : null
        if (cd) return { ...cd, closed: true, writtenBy: [] }
        return reply.code(404).send({ error: `no record ${key} in ${entry.id}` })
      }
      // the conversations that wrote its file (record-writers.ts) — what a
      // page says as «by <who>»; read from the transcripts, the owner's only
      const writtenBy =
        req.agentId === undefined && d.record.file
          ? recordWriters(d.record.file, index.allSessions(), { filesOf: (f, id) => index.getContext(f, id)?.files, agentOf: (m) => classifyAgentId(m) })
          : []
      return { ...d, writtenBy }
    })
  }
  // The v0 actions (silos/actions.ts). Owner routes take the record key in
  // the body; the producer's routes sit under /agents/<itself>/ so the
  // bearer allow-list (agent-authz.ts) can judge them by path segment.
  if (siloActions) {
    const send = (reply: FastifyReply, r: ActionResult): unknown =>
      r.ok ? (r.value ?? { ok: true }) : reply.code(r.code).send({ error: r.reason, ...(r.detail !== undefined ? { detail: r.detail } : {}) })
    const keyOf = (b: unknown): string | null =>
      b && typeof b === 'object' && typeof (b as { key?: unknown }).key === 'string' && (b as { key: string }).key !== '' ? (b as { key: string }).key : null
    type B = Record<string, unknown> | null
    app.post<{ Params: { id: string }; Body: B }>('/api/silos/:id/record/set-field', async (req, reply) => {
      const b = req.body ?? {}
      const key = keyOf(b)
      if (!key || typeof b.field !== 'string' || !('value' in b)) return reply.code(400).send({ error: 'send {key, field, value, version?}' })
      // `by` is the speaker the request names (authorOf: an agent's header
      // makes it the agent's write), never anything in the body
      const r = siloActions.setField(req.params.id, key, b.field, b.value, {
        version: typeof b.version === 'string' ? b.version : null,
        by: authorOf(req, registry),
      })
      // a task's answer: the tasks it made ready, each owner said with
      // whether it will move (the floor the native Done/Drop reported)
      // a plans write may be a task event (task mode looks now, not at the tick)
      if (r.ok && taskMode && req.params.id === PLANS_SILO) {
        try {
          taskMode.look()
        } catch {
          /* the tick looks again */
        }
      }
      if (r.ok && r.value.nowReady)
        return {
          ...r.value,
          nowReady: withWakes(r.value.nowReady, {
            inPlay: (a) => registry.list().some((x) => x.id === a),
            wakes: (a: string) => wakesOfControl(taskMode?.isBound(a) === true ? 'own' : 'told'),
          }),
        }
      return send(reply, r)
    })
    // append-item: {key, collection, values, version?} — the owner adds a
    // child (a note) to an appendOnly sub-kind the manifest lets them
    app.post<{ Params: { id: string }; Body: B }>('/api/silos/:id/record/append', async (req, reply) => {
      const b = req.body ?? {}
      const key = keyOf(b)
      if (!key || typeof b.collection !== 'string' || !('values' in b)) return reply.code(400).send({ error: 'send {key, collection, values, version?}' })
      // the note's author is the speaker the request names: an
      // agent that says who it is (X-Silos-Agent) writes an
      // AGENT's note — never the owner's, whatever its body says. A `by`
      // in values is not a declared field: it never reaches the file
      const by = authorOf(req, registry)
      let values: unknown = b.values
      let undo: (() => void) | null = null
      // a plan TASK is born with its origin:
      // the identity is the request's credential (bearer + its turn, or the
      // owner's), judged by the reader's own rules (judgeCreation) BEFORE
      // the write, stamped and registered so the reader finds it known
      const initiative = initiativeNow()
      if (req.params.id === PLANS_SILO && b.collection === 'tasks' && initiative && values && typeof values === 'object' && !Array.isArray(values)) {
        const id = typeof (values as Record<string, unknown>).id === 'string' ? ((values as Record<string, unknown>).id as string).trim() : ''
        if (id !== '') {
          const turn = (req as unknown as { turn?: LiveTurn }).turn
          const actor =
            req.agentId !== undefined ? (turn ? { agentId: req.agentId, turn } : null) : req.ownerCredential === true ? { owner: true as const } : null
          if (!actor) return reply.code(401).send({ error: "a task is born with an identity — the owner's credential or an agent's bearer with its turn" })
          const prep = initiative.prepareTask(actor, `${key}/tasks/${id}`, values)
          if (!prep.ok) return reply.code(prep.code).send({ error: prep.error })
          values = prep.values
          undo = prep.undo
        }
      }
      const r = siloActions.appendItem(req.params.id, key, b.collection, values, {
        version: typeof b.version === 'string' ? b.version : null,
        by,
        ...(req.agentId !== undefined ? { actor: { agentId: req.agentId } } : {}),
      })
      if (!r.ok && undo) undo()
      // a note an unattended run leaves on a task of ANOTHER owner carries
      // its run (S10-r5): the end of the turn re-stamps it with readOutside
      if (r.ok && initiative && req.params.id === PLANS_SILO && b.collection === 'notes' && req.agentId !== undefined) {
        const turn = (req as unknown as { turn?: LiveTurn }).turn
        const t = taskMode?.tasks().find((x) => x.key === key)
        const mine = t?.notes.filter((n) => n.by === req.agentId).at(-1)
        if (turn?.unattended && t && t.owner !== req.agentId && mine) initiative.markNote(key, req.agentId, turn, mine.at)
      }
      // an owner's note on a task is a task-mode event: looked at now
      if (r.ok && taskMode && req.params.id === PLANS_SILO) {
        try {
          taskMode.look()
        } catch {
          /* the tick looks again */
        }
      }
      return send(reply, r)
    })
    // ensure: {folder, id} — the owner makes sure a silo's reserved record
    // exists in a project (plans: the project's list, plans/tasks.plan.json
    // — «a task never needs a plan»), born from the manifest's seed, and
    // rotated monthly when it declares so. Owner-only: the agent
    // allow-list never names it (an agent writes the file itself).
    app.post<{ Params: { id: string }; Body: B }>('/api/silos/:id/record/ensure', async (req, reply) => {
      const b = req.body ?? {}
      if (typeof b.folder !== 'string' || !b.folder.startsWith('/') || typeof b.id !== 'string' || b.id === '')
        return reply.code(400).send({ error: 'send {folder, id}' })
      const r = siloActions.ensureRecord(req.params.id, `folder:${b.folder}`, b.id)
      return send(reply, r)
    })
    // respond: {key, text, state} — ONE gesture for a gate of the owner's
    // that agents wait on: the gate closes with
    // the owner's Done FIRST (taskGesture, judged on the state painted),
    // then the text lands as an owner note on EACH open
    // agent task that depends on it directly (the note wakes a bound agent
    // and reopens what nothing holds any more — D17). A note that fails
    // after the close answers `closed: true` and `missing`; sent again over
    // the done gate it writes only those. Owner-only (the agent allow-list
    // never names it): an agent answering a gate for the owner would be
    // approving its own wait.
    // GET /api/sessions/:folder/:id/tasks — the tasks this CONVERSATION
    // is on, each saying whether it is still CURRENT there (session-tasks.ts
    // — the same function as GET /api/tasks/by-session). What the
    // conversation header's «☑ Working on» / «Worked on ✓» says. An agent
    // bearer reads only its own conversations (403 otherwise).
    const sessionTasksInput = (closed: boolean): SessionTasksInput => {
      const metas = index.allSessions()
      const entry = siloRegistry.get(PLANS_SILO)
      const active = !!entry?.manifest && entry.status.state === 'active'
      return {
        metas,
        reading: active ? (siloKernel?.reading(PLANS_SILO) ?? null) : null,
        manifest: active ? (entry!.manifest as Record<string, unknown>) : null,
        ...(closed && active && closedPlans
          ? { closedPlans: closedPlans.records({ now: Date.now(), isAgent: (v: string) => registry.list(true).some((a) => a.id === v) }) }
          : {}),
        threads: ctx.threadsOfTasks ? ctx.threadsOfTasks(5_000) : taskThreads({ metas, lineage: lineage ?? null, ownerOf: (m) => classifyAgentId(m) }),
      }
    }
    app.get<{ Params: { folder: string; id: string } }>('/api/sessions/:folder/:id/tasks', async (req, reply) => {
      const meta = index.allSessions().find((m) => m.folder === req.params.folder && m.id === req.params.id)
      if (!meta) return reply.code(404).send({ error: 'no such conversation' })
      if (req.agentId !== undefined && classifyAgentId(meta) !== req.agentId) return reply.code(403).send({ error: 'that conversation is not one of yours' })
      return { tasks: sessionTasks(sessionTasksInput(true), meta) }
    })
    // GET /api/tasks/by-session — { [sessionId]: [{key, ref, title, state,
    // current}] }: every conversation on an OPEN task's current thread (the
    // sidebar's ☑), or, with ?session=<id>, that one conversation's tasks
    // exactly as the header reads them (the /clear hook's fallback when it
    // does not know the folder; an id the index does not hold yet → {}, and
    // the hook stays quiet). An agent bearer sees only its own conversations.
    app.get<{ Querystring: { session?: string } }>('/api/tasks/by-session', async (req) => {
      const id = typeof req.query.session === 'string' ? req.query.session.trim() : ''
      const metas = index.allSessions()
      const mine = (m: SessionMeta): boolean => req.agentId === undefined || classifyAgentId(m) === req.agentId
      if (id !== '') {
        // a console key whose engine sealed its native id reads as that id
        const native = ctx.nativeIdOf?.(id) ?? null
        const meta = metas.find((m) => m.id === id) ?? (native ? metas.find((m) => m.id === native) : undefined)
        if (!meta || !mine(meta)) return {}
        return { [id]: sessionTasks(sessionTasksInput(true), meta) }
      }
      const all = sessionTasksBySession(sessionTasksInput(false))
      if (req.agentId === undefined) return all
      const byId = new Map(metas.map((m) => [m.id, m]))
      return Object.fromEntries(
        Object.entries(all).filter(([sid]) => {
          const m = byId.get(sid)
          return m !== undefined && mine(m)
        }),
      )
    })
    // GET /api/tasks/closed-plans → { plans: ClosedPlanEntry[] }: the
    // finished plans (plans/closed/), newest first — Tasks › Done's Plans
    // strip. A listing only: their tasks never join a reading
    // (plans-closed.ts). The owner's (agentMayRead does not list it).
    app.get('/api/tasks/closed-plans', async () => {
      const entry = siloRegistry.get(PLANS_SILO)
      const active = entry?.status.state === 'active'
      return {
        plans: active && closedPlans ? closedPlans.listing({ now: Date.now(), isAgent: (v: string) => registry.list(true).some((a) => a.id === v) }) : [],
      }
    })
    app.post<{ Params: { id: string }; Body: B }>('/api/silos/:id/record/respond', async (req, reply) => {
      const b = req.body ?? {}
      const key = keyOf(b)
      if (!key || typeof b.text !== 'string' || b.text.trim() === '') return reply.code(400).send({ error: 'send {key, text, state}' })
      // the owner's gesture only: a request that names an agent is refused
      if (authorOf(req, registry) !== 'owner') return reply.code(403).send({ error: 'only the owner answers a gate — an agent writes a note on its task' })
      // the gate's state as the owner saw it: its Done is judged on it
      if (typeof b.state !== 'string' || b.state.trim() === '') return reply.code(400).send({ error: 'send {state}: the state of the gate you saw' })
      const entry = siloRegistry.get(req.params.id)
      if (!entry?.manifest || !siloKernel || !siloSurfaces) return reply.code(404).send({ error: `no active silo ${req.params.id}` })
      const base = (siloKernel.reading(req.params.id)?.records ?? []).map((r) => baseRecordOf(r))
      const r = respondToGate({
        siloId: req.params.id,
        manifest: entry.manifest as Record<string, unknown>,
        base,
        key,
        text: b.text,
        state: b.state.trim(),
        actions: siloActions,
        voice: siloSurfaces.voice(req.params.id, Date.now()),
        // an archived agent is an agent, never a person whose gate this is (F11)
        isAgent: (id) => registry.list(true).some((a) => a.id === id),
      })
      if (taskMode && req.params.id === PLANS_SILO) {
        try {
          taskMode.look()
        } catch {
          /* the tick looks again */
        }
      }
      if (!r.ok) return reply.code(r.code).send({ error: r.reason, notified: r.notified, ...(r.closed ? { closed: true, missing: r.missing } : {}) })
      const nowReady = r.value.nowReady
        ? withWakes(r.value.nowReady as Parameters<typeof withWakes>[0], {
            inPlay: (a) => registry.list().some((x) => x.id === a),
            wakes: (a: string) => wakesOfControl(taskMode?.isBound(a) === true ? 'own' : 'told'),
          })
        : undefined
      return { ...r.value, ...(nowReady ? { nowReady } : {}), notified: r.notified }
    })
    // move-item: {key: <record key>/<collection>/<child id>, to: <sibling
    // record key>, version?, toVersion?} — the CAS of the source (and of the
    // destination) the owner saw, like append-item's: stale → 409, nothing written
    app.post<{ Params: { id: string }; Body: B }>('/api/silos/:id/record/move', async (req, reply) => {
      const b = req.body ?? {}
      const key = keyOf(b)
      if (!key || typeof b.to !== 'string' || b.to === '')
        return reply.code(400).send({ error: 'send {key: <child key>, to: <record key>, version?, toVersion?}' })
      return send(
        reply,
        siloActions.moveItem(req.params.id, key, b.to, {
          version: typeof b.version === 'string' ? b.version : null,
          toVersion: typeof b.toVersion === 'string' ? b.toVersion : null,
        }),
      )
    })
    // kernel-verb: {key, name} — the owner asks the KERNEL to do one of its
    // declared verbs on a record of a kernel source (KERNEL_VERBS, closed:
    // stop-process). The owner's gesture alone: an agent bearer never
    // reaches it (agent-authz.ts) and a request without the owner's
    // credential is refused here — an agent acts from its own shell. The
    // answer says what happened in words (`says`); refusals too.
    app.post<{ Params: { id: string }; Body: B }>('/api/silos/:id/record/kernel-verb', async (req, reply) => {
      const b = req.body ?? {}
      const key = keyOf(b)
      if (!key || typeof b.name !== 'string' || b.name === '') return reply.code(400).send({ error: 'send {key, name}' })
      if (req.agentId !== undefined || req.ownerCredential !== true)
        return reply.code(403).send({ error: `${b.name} is the owner's gesture — an agent acts from its own shell` })
      try {
        ctx.freshen?.(req.params.id)
      } catch {
        /* the last reading answers */
      }
      return send(reply, await siloActions.kernelVerb(req.params.id, key, b.name, ctx.kernelVerbs ?? {}, { by: 'owner' }))
    })
    app.post<{ Params: { id: string }; Body: B }>('/api/silos/:id/record/ack', async (req, reply) => {
      const key = keyOf(req.body)
      if (!key) return reply.code(400).send({ error: 'send {key}' })
      return send(reply, siloActions.ack(req.params.id, key))
    })
    // a message from a declared template: it waits in the producer's inbox
    // and is read at its next conversation — no message wakes anyone (R9)
    app.post<{ Params: { id: string }; Body: B }>('/api/silos/:id/record/message', async (req, reply) => {
      const b = req.body ?? {}
      const key = keyOf(b)
      if (b.urgent !== undefined) return reply.code(400).send({ error: URGENT_GONE })
      if (!key || typeof b.template !== 'number' || !Number.isInteger(b.template)) return reply.code(400).send({ error: 'send {key, template: <index>}' })
      return send(reply, siloActions.messageAgent(req.params.id, key, b.template))
    })
    // make-task (what «Wake the producer now» became):
    // the filled template becomes a task of the producer X in its project's
    // list, born the owner's; then the owner's gesture — assign when X is
    // On its own (R1: Give), and the page opens X with it when Only when told
    app.post<{ Params: { id: string }; Body: B }>('/api/silos/:id/record/make-task', async (req, reply) => {
      const b = req.body ?? {}
      const key = keyOf(b)
      if (!key || typeof b.template !== 'number' || !Number.isInteger(b.template)) return reply.code(400).send({ error: 'send {key, template: <index>}' })
      if (req.agentId !== undefined || req.ownerCredential !== true)
        return reply.code(403).send({ error: "making a task for the producer is the owner's gesture" })
      const initiative = initiativeNow()
      const r = siloActions.makeTask(req.params.id, key, b.template, {
        folderOf: (id) => registry.get(id)?.folder ?? null,
        ...(initiative
          ? {
              prepare: (taskKey: string, values: Record<string, unknown>) => {
                const p = initiative.prepareTask({ owner: true }, taskKey, values)
                return p.ok ? { ok: true as const, values: p.values, undo: p.undo } : { ok: false as const, code: p.code, error: p.error }
              },
            }
          : {}),
      })
      if (!r.ok) return send(reply, r)
      const { to, taskKey } = r.value
      if (taskMode) {
        try {
          taskMode.look()
        } catch {
          /* the tick looks again */
        }
      }
      // On its own: the owner's Give (ownerGesture — R1); Only when told: nothing starts without the owner
      const own = taskMode?.isBound(to) === true
      if (!own || !taskMode) return { ...r.value, assigned: false, control: 'told' as const }
      try {
        initiative?.bless(taskKey, 'give')
        return { ...r.value, assigned: true, control: 'own' as const, assign: taskMode.assign(taskKey, Date.now(), { ownerGesture: true }) }
      } catch (err) {
        return { ...r.value, assigned: false, control: 'own' as const, why: err instanceof Error ? err.message : String(err) }
      }
    })
    app.post<{ Params: { id: string }; Body: B }>('/api/silos/:id/record/resolve', async (req, reply) => {
      const b = req.body ?? {}
      const key = keyOf(b)
      if (!key || typeof b.field !== 'string' || (b.choice !== 'keep-mine' && b.choice !== 'take-source'))
        return reply.code(400).send({ error: 'send {key, field, choice: keep-mine | take-source}' })
      return send(reply, siloActions.resolveConflict(req.params.id, key, b.field, b.choice))
    })
    app.get<{ Params: { id: string } }>('/api/silos/:id/proposals', async (req) => ({ proposals: siloActions.proposals(req.params.id) }))
    app.post<{ Params: { id: string; pid: string; choice: string }; Body: B }>('/api/silos/:id/proposals/:pid/:choice', async (req, reply) => {
      const choice = req.params.choice
      if (choice !== 'approve' && choice !== 'reject') return reply.code(404).send({ error: 'approve or reject' })
      const p = siloActions.proposal(req.params.pid)
      if (!p || p.silo !== req.params.id) return reply.code(404).send({ error: 'no such proposal' })
      const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason : null
      return send(reply, siloActions.decide(req.params.pid, choice, reason))
    })
    app.get<{ Params: { id: string }; Querystring: { key?: string } }>('/api/silos/:id/events', async (req) => ({
      events: siloActions.events(req.params.id, req.query.key),
    }))

    // the producer (its bearer; the owner may act too)
    const self = (req: FastifyRequest, agentId: string): boolean => req.agentId === undefined || req.agentId === agentId
    app.put<{ Params: { id: string; agentId: string; recordId: string }; Body: B }>('/api/silos/:id/agents/:agentId/records/:recordId', async (req, reply) => {
      if (!self(req, req.params.agentId)) return reply.code(403).send({ error: `${req.agentId} may only write its own records` })
      const b = req.body ?? {}
      if (!('record' in b)) return reply.code(400).send({ error: 'send {record, version?}' })
      return send(
        reply,
        siloActions.agentWrite(req.params.id, req.params.agentId, req.params.recordId, b.record, { version: typeof b.version === 'string' ? b.version : null }),
      )
    })
    app.get<{ Params: { id: string; agentId: string } }>('/api/silos/:id/agents/:agentId/merged', async (req, reply) => {
      if (!self(req, req.params.agentId)) return reply.code(403).send({ error: `${req.agentId} may only read its own view` })
      const r = siloActions.agentMerged(req.params.id, req.params.agentId)
      return r.ok ? { records: r.value, sync: siloActions.agentSync(req.params.id) } : reply.code(r.code).send({ error: r.reason })
    })
    app.post<{ Params: { id: string; agentId: string }; Body: B }>('/api/silos/:id/agents/:agentId/proposals', async (req, reply) => {
      if (!self(req, req.params.agentId)) return reply.code(403).send({ error: `${req.agentId} may only propose as itself` })
      const b = req.body ?? {}
      const key = typeof b.recordId === 'string' && b.recordId !== '' ? `agent:${req.params.agentId}/${b.recordId}` : keyOf(b)
      if (!key || typeof b.field !== 'string' || !('value' in b)) return reply.code(400).send({ error: 'send {recordId, field, value, note?}' })
      const r = siloActions.propose(req.params.id, req.params.agentId, key, b.field, b.value, typeof b.note === 'string' ? b.note : null)
      return r.ok ? reply.code(201).send({ proposal: r.value }) : reply.code(r.code).send({ error: r.reason })
    })
    app.get<{ Params: { id: string; agentId: string } }>('/api/silos/:id/agents/:agentId/proposals', async (req, reply) => {
      if (!self(req, req.params.agentId)) return reply.code(403).send({ error: `${req.agentId} may only read its own proposals` })
      return { proposals: siloActions.proposals(req.params.id).filter((p) => p.by === req.params.agentId) }
    })
  }
  // the validator's eleven checks + the text preview, over a sent manifest
  // or an author's draft (agent-state/<agent>/silo-drafts/<id>.json) — read
  // on the asker's authority: an agent bearer its own draft and its own
  // territory's records (silos/bearer-scope.ts), the owner everything
  if (siloValidate) {
    app.post<{ Body: unknown }>('/api/silos/validate', async (req, reply) => {
      const r = siloValidate(req.body ?? null, req.agentId ?? 'owner')
      return reply.code(r.code).send(r.body)
    })
  }
}
