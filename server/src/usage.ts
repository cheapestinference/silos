// usage.ts — Usage: what the fleet spent, by
// agent, kind, task, automation, conversation and account.
//
// Two sources, never counted twice:
//   - the TOKENS come only from the transcript, through each engine's
//     reader (contract.ts usageRecords — priced by the engine's own table;
//     an engine that can't say is «not measured on <engine>»);
//   - the WINDOWS (usage-ledger.ts) say who and why: each record falls in
//     the window of its thread that held it (usage-attribution.ts).
//
// This service also KEEPS the windows: it is what ChatService opens and
// closes a turn's window through (TurnWindows), what TerminalService tells
// about consoles, and what closes, at boot, the turns a dead process left
// open (`interrupted`, at the conversation's last record).
//
// One money: the caps count with what own-turns.ts reads (each run's
// and each wake's costUsd, from its chat-done). A turn that ended without
// saying its price — failed, cancelled, timed out, cut by a restart — gets
// its cost read from its transcript here and written there (`writeCost`),
// so the caps and Usage say the same figure. The caps' rows never read
// from here: their head and breakdown are own-turns' own records (one source
// per row); their «See today ›» opens this page.
//
// A turn on a plan shows no dollars: tokens and «on plan».
import { providerPrices, type ResolvedProvider } from './providers-store.js'
import type { UsageRecord } from './harnesses/contract.js'
import type { SessionMeta } from './types.js'
import type { TurnDeclaration } from './live-turns.js'
import type { TurnWindows } from './chat-service.js'
import { consoleWindowId, type RunOf, type UsageLedger, type UsageWindow, type WindowOutcome } from './usage-ledger.js'
import { addTokens, attribute, totalTokens, type AttributedRecord, type ThreadedRecords } from './usage-attribution.js'
import { localYmd } from './control.js'

export type UsageBy = 'agent' | 'kind' | 'task' | 'automation' | 'conversation' | 'account'
export const USAGE_BY: readonly UsageBy[] = ['agent', 'kind', 'task', 'automation', 'conversation', 'account']

export interface Tokens {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
}

export interface UsageRow {
  key: string
  label: string
  /** turns with something measured in the range (windows), 0 for rows that are no turn */
  turns: number
  tokens: Tokens
  /** dollars of the turns on a provider that prices; null = none priced */
  costUsd: number | null
  /** records priced at no row of the engine's table (a new model) */
  unpriced: number
  /** the models of those records — what the page names («no price for …») */
  unpricedModels?: string[]
  /** some of its tokens ran on a plan (no dollars shown for them) */
  plan: boolean
  /** turns of this row the daily max does not count (an owner's gesture, an accepted automation) */
  outsideMax?: number
  /** engines whose turns in this row are not measured */
  notMeasured?: string[]
  /** turns of this row not measured because their transcript is gone (counted, no tokens) */
  gone?: number
  /** a conversation row: whose turns it holds (two conversations may share a title) */
  agents?: string[]
  /** a conversation row: where it lives (absent: hidden — a muted or
   *  ephemeral folder, the trash — said without its title or path) */
  ref?: { folder: string; id: string }
  /** a conversation the sidebar does not list: «Hidden conversation» */
  hidden?: boolean
  /** of its turns, how many are consoles (a console is no count of turns) */
  consoles?: number
  /** a conversation row: the classes its turns ran as, and the server's
   *  local day of its latest record — what tells two of one title apart */
  classes?: SeriesClass[]
  day?: string
  /** sub-rows: an agent's kinds, Unattributed's conversations */
  children?: UsageRow[]
}

/** The stacking classes of the day bars, in order. */
export const SERIES_CLASSES = ['with-you', 'task', 'heartbeat', 'own-automation', 'your-automation', 'unattributed', 'silos', 'before'] as const
export type SeriesClass = (typeof SERIES_CLASSES)[number]

export interface UsageReport {
  from: string
  to: string
  by: UsageBy
  agent: string | null
  rows: UsageRow[]
  /** one point per local day: total tokens per class — and, read by agent
   *  over the whole fleet, the same day's tokens per agent (`agents`: the
   *  windowed classes split by whose window held them; what is no one's —
   *  unattributed, Silos itself, before — stays only in `classes`) */
  series: Array<{ day: string; classes: Partial<Record<SeriesClass, number>>; agents?: Record<string, number> }>
  /** `unpriced`: records on a priced provider without a price row (said «+ N unpriced», like the rows) */
  totals: {
    tokens: Tokens
    costUsd: number | null
    plan: boolean
    turns: number
    unpriced: number
    unpricedModels?: string[]
    /** of the turns, consoles */ consoles: number
  }
  /** the register's first window; null = nothing ran yet */
  since: string | null
  /** its local day on the SERVER ('YYYY-MM-DD') — what the page names it by */
  sinceDay: string | null
  /** the server's local day now: every row, bar and cap counts by it */
  today: string
  /** providers that price, with what they cost in the range */
  priced: Array<{ provider: string; label: string; costUsd: number }>
  /** accounts on a plan the range ran on (their limits are read by the page's header) */
  accounts: Array<{ account: string; label: string; weeklyPercent: number | null; fiveHourPercent: number | null }>
  /** engines that ran in the range and can't be measured */
  notMeasured: string[]
  /** turns of the range whose transcript is gone: counted, not measured */
  gone: number
}

export interface UsageDeps {
  ledger: UsageLedger
  sessions: {
    all(): SessionMeta[]
    usageRecords(folder: string, id: string): Promise<UsageRecord[] | null | 'unmeasured'>
    silosOwnUsage(sinceMs: number): Promise<UsageRecord[]>
  }
  /** a session's thread (thread-tools.ts threadRootKey) — `lookup`: the
   *  read's own id → meta map, built once per read */
  threadKeyOf(m: SessionMeta, lookup: (id: string) => SessionMeta | null): string
  /** a nested session's parent session id (its birth marker, session-owner.ts nestedOf), or null */
  nestedParentOf?(m: SessionMeta): string | null
  /** the engine's label for a session ('Claude Code', …) */
  engineLabelOf(m: SessionMeta): string
  labels: {
    agent(id: string): string
    /** an automation's name (null: unknown) — never its class: a window's
     *  class is sealed when it opens (runOfNow) */
    automation(id: string): string | null
    task(key: string): string | null
    provider(id: string): string
  }
  /** the machine's default provider — what prices «Silos itself» and a
   *  loose record whose conversation never named one (G) */
  defaultProvider?(): ResolvedProvider | null
  /** a plan account's current reading (plan-usage's cache) — the header */
  planReading?(account: string): { weeklyPercent: number | null; fiveHourPercent: number | null } | null
  /** a run's automation as it is NOW — read once, when its window opens, and
   *  sealed there (usage-ledger.ts RunOf). null: unknown → 'yours' */
  runOfNow?(automationId: string): RunOf | null
  /** whether the turn is an owner's gesture (a wake the owner started, «Run now») */
  gestureOf?(turnId: string, turn: TurnDeclaration): boolean | undefined
  /** «one money»: write a window's transcript cost where own-turns.ts reads
   *  it — 'later' when its record isn't closed yet (retried) */
  writeCost?(w: UsageWindow, cost: { costUsd: number | null; model?: string }): 'done' | 'later' | 'skip'
  now?: () => number
  /** retry delay for writeCost's 'later' (tests) */
  retryMs?: number
}

const zero = (): Tokens => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })

/** Who a record's money is billed to: its window's provider, or — a record
 *  in no window — its conversation's (the thread's latest window), else the
 *  machine's default. A plan account shows no dollars. */
interface Pricing {
  provider: string
  account?: string
  priced: boolean
}
const pricingOf = (p: ResolvedProvider | null | undefined): Pricing => ({
  provider: p?.id ?? 'default',
  ...(p?.kind === 'claude-account' ? { account: p.id } : p ? {} : { account: 'default' }),
  priced: providerPrices(p),
})
const CONCURRENCY = 8
const RETRIES = 15
const CONVERSATION_ROWS = 20

/** The class of a window as the day bar stacks it — from what the window
 *  sealed when it opened, never the automation's state now. A run window
 *  without its seal is the owner's (nothing is guessed in the agent's favour). */
function seriesClassOf(w: UsageWindow): SeriesClass {
  if (w.class === 'chat' || w.class === 'console') return 'with-you'
  if (w.class === 'wake') return 'task'
  if (w.class === 'heartbeat') return 'heartbeat'
  return w.runOf === 'own' || w.runOf === 'accepted' ? 'own-automation' : 'your-automation'
}

/** Whether the agent's daily max leaves the window's turn out: an owner's
 *  gesture, an accepted or the owner's automation, every heartbeat —
 *  sealed at the opening like its class. */
function outsideMaxOf(w: UsageWindow): boolean {
  if (w.class === 'wake') return w.gesture === true
  if (w.class === 'run') return w.runOf !== 'own'
  return w.class === 'heartbeat'
}

const SERIES_LABEL: Record<SeriesClass, string> = {
  'with-you': 'With you',
  task: 'Task starts',
  heartbeat: 'Heartbeat',
  'own-automation': 'Its automations',
  'your-automation': 'Automations you set',
  unattributed: 'Unattributed',
  silos: 'Silos itself',
  before: 'Before',
}

/** A window's kind key (by=kind): its class, a heartbeat with its kind. */
function kindKeyOf(w: UsageWindow): string {
  return w.class === 'heartbeat' && w.kind ? `heartbeat:${w.kind}` : w.class
}
const KIND_LABEL: Record<string, string> = {
  chat: 'Chat',
  console: 'Console',
  wake: 'Task starts',
  run: 'Automation runs',
  heartbeat: 'Heartbeat',
  'heartbeat:look': 'Heartbeat · look',
  'heartbeat:think': 'Heartbeat · think',
  'heartbeat:round': 'Heartbeat · round',
}

class RowAcc {
  tokens = zero()
  cost = 0
  priced = false
  unpriced = 0
  unpricedModels = new Set<string>()
  plan = false
  windows = new Set<string>()
  agentIds = new Set<string>()
  outside = new Set<string>()
  engines = new Set<string>()
  gone = new Set<string>()
  consoles = new Set<string>()
  classes = new Set<SeriesClass>()
  lastAt = 0
  hidden = false
  children = new Map<string, RowAcc>()
  /** names the agents of a conversation row (set by the report) */
  label$: ((id: string) => string) | null = null
  constructor(
    readonly key: string,
    public label: string,
    readonly ref?: { folder: string; id: string },
  ) {}
  /** `pricing`: who pays a record in no window (its window's provider otherwise) */
  add(a: AttributedRecord, outsideMax: boolean, pricing?: Pricing | null): void {
    addTokens(this.tokens, a.rec)
    if (a.rec.at > this.lastAt) this.lastAt = a.rec.at
    if (a.window) this.turn(a.window, outsideMax)
    const p = a.window ?? pricing ?? null
    if (!p) return
    if (p.priced) {
      if (a.rec.costUsd === null) {
        this.unpriced++
        this.unpricedModels.add(a.rec.model)
      } else {
        this.cost += a.rec.costUsd
        this.priced = true
      }
    } else this.plan = true
  }
  /** a window of this row: a turn — a console, said apart */
  turn(w: UsageWindow, outsideMax: boolean): void {
    this.windows.add(w.id)
    if (outsideMax) this.outside.add(w.id)
    if (w.class === 'console') this.consoles.add(w.id)
    this.classes.add(seriesClassOf(w))
  }
  /** folds another row in — «N more conversations» keeps the rows adding up */
  absorb(o: RowAcc): void {
    this.tokens.in += o.tokens.in
    this.tokens.out += o.tokens.out
    this.tokens.cacheRead += o.tokens.cacheRead
    this.tokens.cacheWrite += o.tokens.cacheWrite
    this.cost += o.cost
    this.priced ||= o.priced
    this.unpriced += o.unpriced
    this.plan ||= o.plan
    for (const m of o.unpricedModels) this.unpricedModels.add(m)
    for (const [mine, theirs] of [
      [this.windows, o.windows],
      [this.outside, o.outside],
      [this.engines, o.engines],
      [this.gone, o.gone],
      [this.agentIds, o.agentIds],
      [this.consoles, o.consoles],
    ] as const)
      for (const x of theirs) mine.add(x)
  }
  child(key: string, label: string, ref?: { folder: string; id: string }): RowAcc {
    let c = this.children.get(key)
    if (!c) {
      c = new RowAcc(key, label, ref)
      this.children.set(key, c)
    }
    return c
  }
  row(childOrder?: (a: RowAcc, b: RowAcc) => number, childCap?: number): UsageRow {
    const r: UsageRow = {
      key: this.key,
      label: this.label,
      turns: this.windows.size,
      tokens: { ...this.tokens },
      costUsd: this.priced ? round(this.cost) : null,
      unpriced: this.unpriced,
      plan: this.plan,
    }
    if (this.unpricedModels.size > 0) r.unpricedModels = [...this.unpricedModels].sort()
    if (this.outside.size > 0) r.outsideMax = this.outside.size
    if (this.engines.size > 0) r.notMeasured = [...this.engines].sort()
    if (this.gone.size > 0) r.gone = this.gone.size
    if (this.consoles.size > 0) r.consoles = this.consoles.size
    if (this.ref) r.ref = this.ref
    if (this.hidden) r.hidden = true
    if (this.ref || this.hidden) {
      if (this.classes.size > 0) r.classes = SERIES_CLASSES.filter((c) => this.classes.has(c))
      if (this.lastAt > 0) r.day = localYmd(this.lastAt)
    }
    if (this.agentIds.size > 0 && this.label$) r.agents = [...this.agentIds].map(this.label$).sort()
    if (this.children.size > 0) r.children = capped([...this.children.values()].sort(childOrder ?? classOrder), childCap).map((c) => c.row())
    return r
  }
}

// rows rank by what they used — tokens, the one unit every row has (a plan turn has no dollars)
const weightOf = (a: RowAcc): number => totalTokens(a.tokens)
const byWeight = (a: RowAcc, b: RowAcc): number => weightOf(b) - weightOf(a)
// an agent's classes keep the bars' fixed order (the colour follows the class,
// never its rank); any other sub-rows by weight
const classOrder = (a: RowAcc, b: RowAcc): number => {
  const ia = (SERIES_CLASSES as readonly string[]).indexOf(a.key)
  const ib = (SERIES_CLASSES as readonly string[]).indexOf(b.key)
  return ia >= 0 && ib >= 0 ? ia - ib : byWeight(a, b)
}
const round = (usd: number): number => Math.round(usd * 1e6) / 1e6

/** The first `cap` rows, the rest folded into one «N more conversations»
 *  row with their sum — the rows always add up to the period. */
function capped(list: RowAcc[], cap?: number): RowAcc[] {
  if (cap === undefined || list.length <= cap) return list
  const rest = list.slice(cap)
  const more = new RowAcc('more', `${rest.length} more conversations`)
  for (const r of rest) more.absorb(r)
  return [...list.slice(0, cap), more]
}

export class UsageService implements TurnWindows {
  private now: () => number
  private timeouts = new Set<string>()
  private staleAtBoot: UsageWindow[]

  constructor(private d: UsageDeps) {
    this.now = d.now ?? Date.now
    // every TURN window still open at construction belongs to a process that
    // died: SDK turns never survive a restart (closeInterrupted)
    this.staleAtBoot = d.ledger.openTurns()
  }

  // ── the windows (TurnWindows + consoles) ─────────────────────────────

  turnOpened(t: { turnId: string; agentId: string; folder: string; sessionId: string; turn: TurnDeclaration; provider: ResolvedProvider | null }): void {
    const p = t.provider
    let gesture: boolean | undefined
    try {
      gesture = this.d.gestureOf?.(t.turnId, t.turn)
    } catch {
      gesture = undefined
    }
    const kind = (t.turn as { kind?: unknown }).kind
    let runOf: RunOf | null = null
    if (t.turn.class === 'run') {
      try {
        runOf = t.turn.automationId !== undefined ? (this.d.runOfNow?.(t.turn.automationId) ?? null) : null
      } catch {
        runOf = null
      }
      runOf ??= 'yours'
    }
    this.d.ledger.open({
      id: t.turnId,
      class: t.turn.class,
      agentId: t.agentId,
      session: { folder: t.folder, id: t.sessionId },
      ...(kind === 'look' || kind === 'think' || kind === 'round' ? { kind } : {}),
      ...(t.turn.taskKey !== undefined ? { taskKey: t.turn.taskKey } : {}),
      ...(t.turn.automationId !== undefined ? { automationId: t.turn.automationId } : {}),
      ...(t.turn.runId !== undefined ? { runId: t.turn.runId } : {}),
      ...(runOf !== null ? { runOf } : {}),
      ...(gesture !== undefined ? { gesture } : {}),
      provider: p?.id ?? 'default',
      ...(p?.kind === 'claude-account' ? { account: p.id } : {}),
      priced: providerPrices(p),
    })
  }

  /** The resident decided this turn timed out (it cancels it next): its
   *  window closes `timeout` when the turn really ends. */
  markTimeout(turnId: string): void {
    this.timeouts.add(turnId)
  }

  turnClosed(turnId: string, outcome: 'done' | 'failed' | 'cancelled', chatDone: boolean): void {
    const final: WindowOutcome = this.timeouts.delete(turnId) ? 'timeout' : outcome
    this.d.ledger.close(turnId, final)
    // a turn that never said its price — or whose consumer stopped listening
    // before it did (a timeout) — is priced from its transcript
    if (!chatDone || final !== 'done') this.fillCost(turnId)
  }

  /** A console Silos launched (TerminalService): its window opens. */
  consoleOpened(c: { key: string; agentId: string; folder: string; sessionId: string; provider: ResolvedProvider | null }): void {
    const at = this.now()
    const p = c.provider
    this.d.ledger.open({
      id: consoleWindowId(c.key, at),
      at: new Date(at).toISOString(),
      class: 'console',
      agentId: c.agentId,
      session: { folder: c.folder, id: c.sessionId },
      provider: p?.id ?? 'default',
      ...(p?.kind === 'claude-account' ? { account: p.id } : {}),
      priced: providerPrices(p),
    })
  }

  /** A console's tmux is gone: its window closes. */
  consoleClosed(key: string): void {
    for (const w of this.d.ledger.openConsoles()) if (w.id.startsWith(`console:${key}:`)) this.d.ledger.close(w.id, 'done')
  }

  /** A listing of the live consoles (boot and every periodic listing): every
   *  open console window not in it closes; every live console with no open
   *  window — one launched before the register, or by a process that never
   *  told it — gets one opened NOW when `adopt` names its agent. What it used
   *  before stays unattributed: nothing is guessed backwards. */
  consolesAlive(
    keys: ReadonlySet<string>,
    adopt?: (key: string) => { agentId: string; folder: string; sessionId: string; provider: ResolvedProvider | null } | null,
  ): void {
    const windowed = new Set<string>()
    for (const w of this.d.ledger.openConsoles()) {
      const key = w.id.slice('console:'.length, w.id.lastIndexOf(':'))
      if (!keys.has(key)) this.d.ledger.close(w.id, 'done')
      else windowed.add(key)
    }
    if (!adopt) return
    for (const key of keys) {
      if (windowed.has(key)) continue
      let c: ReturnType<typeof adopt> = null
      try {
        c = adopt(key)
      } catch {
        c = null
      }
      if (c) this.consoleOpened({ key, ...c })
    }
  }

  /** Boot: the turn windows a dead process left open close `interrupted`, at
   *  the time of their conversation's last record (else their opening), and
   *  their cost is read from the transcript. Run once the index is warm. */
  async closeInterrupted(): Promise<number> {
    let n = 0
    for (const w of this.staleAtBoot) {
      if (this.d.ledger.get(w.id)?.closedAt !== undefined) continue
      const last = await this.lastRecordAt(w).catch(() => null)
      const at = new Date(Math.max(Date.parse(w.at), last ?? 0)).toISOString()
      if (this.d.ledger.close(w.id, 'interrupted', at)) {
        n++
        this.fillCost(w.id)
      }
    }
    this.staleAtBoot = []
    return n
  }

  private async lastRecordAt(w: UsageWindow): Promise<number | null> {
    const recs = await this.d.sessions.usageRecords(w.session.folder, w.session.id)
    if (!Array.isArray(recs)) return null
    let last: number | null = null
    for (const r of recs) if (r.at >= Date.parse(w.at) && (last === null || r.at > last)) last = r.at
    return last
  }

  // ── one money ────────────────────────────────────────────────────────

  /** What one window's records cost, read from its thread (other windows of
   *  the thread keep theirs). null cost: nothing priced, or a model without
   *  a price; `measured: false`: its engine can't say. */
  async costOfWindow(id: string): Promise<{ costUsd: number | null; tokens: Tokens; model?: string; measured: boolean } | null> {
    const w = this.d.ledger.get(id)
    if (!w) return null
    const from = Date.parse(w.at)
    const to = w.closedAt !== undefined ? Date.parse(w.closedAt) + 1 : this.now() + 1
    const got = await this.gather(from, to)
    const mine = got.attributed.filter((a) => a.window?.id === id)
    const tokens = zero()
    let cost = 0
    let unpriced = false
    let model: string | undefined
    for (const a of mine) {
      addTokens(tokens, a.rec)
      if (a.rec.costUsd === null) unpriced = true
      else cost += a.rec.costUsd
      model ??= a.rec.model
    }
    const measured = !got.unmeasuredEngines.has(got.windowThread.get(id) ?? '') && !got.gone.has(id)
    return { costUsd: mine.length === 0 || unpriced ? null : round(cost), tokens, ...(model ? { model } : {}), measured }
  }

  private fillCost(id: string, attempt = 0): void {
    if (!this.d.writeCost) return
    void this.costOfWindow(id)
      .then((c) => {
        const w = this.d.ledger.get(id)
        if (!c || !w || !c.measured || c.costUsd === null) return
        let r: 'done' | 'later' | 'skip' = 'skip'
        try {
          r = this.d.writeCost!(w, { costUsd: c.costUsd, ...(c.model ? { model: c.model } : {}) })
        } catch (err) {
          console.warn("usage: writing a turn's cost failed —", err instanceof Error ? err.message : err)
        }
        if (r === 'later' && attempt < RETRIES) {
          const t = setTimeout(() => this.fillCost(id, attempt + 1), this.d.retryMs ?? 2_000)
          t.unref?.()
        }
      })
      .catch((err) => console.warn("usage: reading a turn's cost failed —", err instanceof Error ? err.message : err))
  }

  // ── reading ──────────────────────────────────────────────────────────

  /** Every record of [from, to), attributed. The LEDGER is the list
   *  of what ran: each window's transcript is read by its own {folder, id}
   *  — listed or not (a muted or ephemeral folder), from the trash while it
   *  is there (the engine's reader looks) — so a turn never vanishes from a
   *  past day because its conversation was hidden or trashed later. The
   *  index adds the conversations touched in the range that no window names
   *  (they are «Unattributed»). A window whose transcript can't be read is
   *  still a turn: counted, «not measured — its transcript is gone». One
   *  id → meta map per read (no index search per ancestor). */
  private async gather(from: number, to: number): Promise<Gathered> {
    const all = this.d.sessions.all()
    const metaByKey = new Map(all.map((m) => [`${m.folder}/${m.id}`, m]))
    const metaById = new Map(all.map((m) => [m.id, m]))
    const lookup = (id: string): SessionMeta | null => metaById.get(id) ?? null
    const threadMemo = new Map<string, string>()
    const threadOf = (m: SessionMeta): string => {
      const k = `${m.folder}/${m.id}`
      let t = threadMemo.get(k)
      if (t !== undefined) return t
      t = k
      try {
        // a nested session (a `claude -p` an agent ran) rides its parent's thread
        const parent = this.d.nestedParentOf?.(m) ?? null
        const pm = parent ? metaById.get(parent) : undefined
        t = pm && pm.id !== m.id ? this.d.threadKeyOf(pm, lookup) : this.d.threadKeyOf(m, lookup)
      } catch {
        /* its own key */
      }
      threadMemo.set(k, t)
      return t
    }
    // a session by its own {folder, id}: its listed meta, else a bare one
    // (hidden or trashed — its thread still walks lineage by id)
    const metaOf = (folder: string, id: string): { m: SessionMeta; listed: boolean } => {
      const m = metaByKey.get(`${folder}/${id}`) ?? metaById.get(id)
      return m ? { m, listed: true } : { m: { id, folder } as SessionMeta, listed: false }
    }
    const windows = this.d.ledger.windows().filter((w) => Date.parse(w.at) < to && (w.closedAt === undefined || Date.parse(w.closedAt) >= from))
    const toRead = new Map<string, { folder: string; id: string; m: SessionMeta; listed: boolean; order: number }>()
    for (const w of windows) {
      const k = `${w.session.folder}/${w.session.id}`
      if (toRead.has(k)) continue
      const { m, listed } = metaOf(w.session.folder, w.session.id)
      toRead.set(k, { folder: w.session.folder, id: w.session.id, m, listed, order: listed ? (m.startedAt ?? m.mtime) : Date.parse(w.at) })
    }
    // conversations that may hold a loose record of the range: touched since
    // `from` and born before `to`
    for (const m of all) {
      const k = `${m.folder}/${m.id}`
      if (toRead.has(k)) continue
      if (Math.max(m.mtime, m.subMtime ?? 0) >= from && (m.startedAt === undefined || m.startedAt < to))
        toRead.set(k, { folder: m.folder, id: m.id, m, listed: true, order: m.startedAt ?? m.mtime })
    }
    const candidates = [...toRead.values()].sort((a, b) => a.order - b.order) // the original before a --resume copy
    const conversations: ThreadedRecords[] = []
    const unmeasuredEngines = new Map<string, string>() // threadKey → engine label
    const unreadable = new Set<string>() // session keys whose transcript can't be read
    const readThreads = new Set<string>()
    const threadMeta = new Map<string, SessionMeta>() // a LISTED session naming each thread
    const reads = await pool(candidates, CONCURRENCY, async (c) => ({ c, recs: await this.d.sessions.usageRecords(c.folder, c.id).catch(() => null) }))
    for (const { c, recs } of reads) {
      const threadKey = threadOf(c.m)
      if (c.listed) {
        const cur = threadMeta.get(threadKey)
        // the thread's root names it when it is listed; else its latest listed session
        if (!cur || `${c.m.folder}/${c.m.id}` === threadKey || (`${cur.folder}/${cur.id}` !== threadKey && c.m.mtime > cur.mtime))
          threadMeta.set(threadKey, c.m)
      }
      if (recs === 'unmeasured') {
        unmeasuredEngines.set(threadKey, this.d.engineLabelOf(c.m))
        continue
      }
      if (recs === null) {
        unreadable.add(`${c.folder}/${c.id}`)
        continue
      }
      readThreads.add(threadKey)
      conversations.push({ sessionKey: `${c.folder}/${c.id}`, threadKey, records: recs })
    }
    const windowThread = new Map<string, string>()
    const threadPricing = new Map<string, Pricing>() // the thread's latest window's provider
    for (const w of windows) {
      const t = threadOf(metaOf(w.session.folder, w.session.id).m)
      windowThread.set(w.id, t)
      threadPricing.set(t, { provider: w.provider, ...(w.account ? { account: w.account } : {}), priced: w.priced })
    }
    // gone: a CLOSED window whose own transcript can't be read and whose
    // thread has nothing readable (an open one may not have written yet)
    const gone = new Set<string>()
    for (const w of windows) {
      const t = windowThread.get(w.id)!
      if (w.closedAt !== undefined && unreadable.has(`${w.session.folder}/${w.session.id}`) && !readThreads.has(t) && !unmeasuredEngines.has(t)) gone.add(w.id)
    }
    const placed = windows.map((w) => ({ window: w, threadKey: windowThread.get(w.id)! }))
    const since = this.d.ledger.since()
    const attributed = attribute({ windows: placed, conversations, since, from, to })
    return { attributed, unmeasuredEngines, windowThread, threadMeta, threadPricing, gone, windows }
  }

  /** GET /api/usage. */
  async report(q: { from: number; to: number; by: UsageBy; agent?: string | null }): Promise<UsageReport> {
    const { from, to, by } = q
    const agentFilter = q.agent ?? null
    const got = await this.gather(from, to)
    const silos = agentFilter === null ? await this.d.sessions.silosOwnUsage(from).catch(() => [] as UsageRecord[]) : []
    const auto = (id: string) => {
      try {
        return this.d.labels.automation(id)
      } catch {
        return null
      }
    }
    const since = this.d.ledger.since()
    const beforeLabel = since !== null ? `before ${localYmd(since)}` : `before ${localYmd(this.now())}`
    const inScope = (a: AttributedRecord): boolean => agentFilter === null || (a.window !== null && a.window.agentId === agentFilter)
    const recs = got.attributed.filter(inScope)

    const rows = new Map<string, RowAcc>()
    const rowFor = (key: string, label: string, ref?: { folder: string; id: string }): RowAcc => {
      let r = rows.get(key)
      if (!r) {
        r = new RowAcc(key, label, ref)
        rows.set(key, r)
      }
      return r
    }
    // a thread is named and linked by a session the sidebar lists; none
    // listed (muted, ephemeral, trashed): «Hidden conversation», no title, no path
    const convRow = (into: (key: string, label: string, ref?: { folder: string; id: string }) => RowAcc, key: string, threadKey: string): RowAcc => {
      const m = got.threadMeta.get(threadKey)
      const r = m ? into(key, m.title || m.id.slice(0, 8), { folder: m.folder, id: m.id }) : into(key, 'Hidden conversation')
      if (!m) r.hidden = true
      return r
    }
    const totals = new RowAcc('total', 'Total')
    const priced = new Map<string, number>()
    const accounts = new Set<string>()
    const seriesMap = new Map<string, Partial<Record<SeriesClass, number>>>()
    const bump = (day: string, cls: SeriesClass, n: number): void => {
      const s = seriesMap.get(day) ?? {}
      s[cls] = (s[cls] ?? 0) + n
      seriesMap.set(day, s)
    }
    // the day bars follow By agent (q4 t46): each day's windowed tokens by
    // whose window held them — only when the read is by agent over the fleet
    const byAgentDays = by === 'agent' && agentFilter === null ? new Map<string, Record<string, number>>() : null
    const bumpAgent = (day: string, agentId: string, n: number): void => {
      if (!byAgentDays) return
      const s = byAgentDays.get(day) ?? {}
      s[agentId] = (s[agentId] ?? 0) + n
      byAgentDays.set(day, s)
    }

    let machine: Pricing | null = null
    const machineDefault = (): Pricing => {
      if (!machine) {
        let p: ResolvedProvider | null = null
        try {
          p = this.d.defaultProvider?.() ?? null
        } catch {
          p = null
        }
        machine = pricingOf(p)
      }
      return machine
    }
    const bill = (pr: Pricing, rec: UsageRecord): void => {
      if (pr.priced && rec.costUsd !== null) priced.set(pr.provider, (priced.get(pr.provider) ?? 0) + rec.costUsd)
      if (!pr.priced && pr.account) accounts.add(pr.account)
    }
    for (const a of recs) {
      const w = a.window
      const pr: Pricing = w ?? got.threadPricing.get(a.threadKey) ?? machineDefault()
      totals.add(a, false, pr)
      // the day rule (usage-attribution.ts): a turn's record is its window's
      // opening day; a console's, like a loose one, its own
      const day = localYmd(w && w.class !== 'console' ? Date.parse(w.at) : a.rec.at)
      const cls: SeriesClass = w ? seriesClassOf(w) : a.bucket === 'before' ? 'before' : 'unattributed'
      bump(day, cls, totalTokens(a.rec.tokens))
      if (w) bumpAgent(day, w.agentId, totalTokens(a.rec.tokens))
      bill(pr, a.rec)
      if (!w) {
        // the same two rows in every view: what falls in no window is never
        // guessed — its money is its conversation's provider's, else the machine's
        const r = a.bucket === 'before' ? rowFor('before', beforeLabel) : rowFor('unattributed', 'Unattributed')
        r.add(a, false, pr)
        if (a.bucket === 'unattributed') convRow((k, l, ref) => r.child(k, l, ref), a.threadKey, a.threadKey).add(a, false, pr)
        continue
      }
      const out = outsideMaxOf(w)
      switch (by) {
        case 'agent': {
          const r = rowFor(`agent:${w.agentId}`, this.d.labels.agent(w.agentId))
          r.add(a, out)
          const c = seriesClassOf(w)
          r.child(c, SERIES_LABEL[c]).add(a, out)
          break
        }
        case 'kind': {
          const k = kindKeyOf(w)
          rowFor(k, KIND_LABEL[k] ?? k).add(a, out)
          break
        }
        case 'task': {
          if (w.taskKey) rowFor(`task:${w.taskKey}`, this.d.labels.task(w.taskKey) ?? w.taskKey).add(a, out)
          else rowFor('none', 'Not on a task').add(a, out)
          break
        }
        case 'automation': {
          if (w.automationId) rowFor(`automation:${w.automationId}`, auto(w.automationId) ?? w.automationId).add(a, out)
          else rowFor('none', 'Not an automation').add(a, out)
          break
        }
        case 'conversation': {
          const r = convRow(rowFor, `conversation:${a.threadKey}`, a.threadKey)
          r.add(a, out)
          r.agentIds.add(w.agentId)
          break
        }
        case 'account': {
          const key = w.account ?? w.provider
          rowFor(`account:${key}`, this.d.labels.provider(key)).add(a, out)
          break
        }
      }
    }
    // turns of a window with nothing measured — an engine that can't say, or
    // a transcript that is gone: the row counts the turn, no tokens, and
    // says why
    for (const w of got.windows) {
      if (agentFilter !== null && w.agentId !== agentFilter) continue
      const t = got.windowThread.get(w.id)!
      const engine = got.unmeasuredEngines.get(t)
      const gone = got.gone.has(w.id)
      if (engine === undefined && !gone) continue
      if (Date.parse(w.at) < from || Date.parse(w.at) >= to) continue
      const mark = (r: RowAcc): void => {
        r.turn(w, outsideMaxOf(w))
        if (engine !== undefined) r.engines.add(engine)
        if (gone) r.gone.add(w.id)
        if (r.lastAt === 0 && r.windows.size > 0) r.lastAt = Date.parse(w.at)
      }
      let r: RowAcc
      if (by === 'conversation') {
        r = convRow(rowFor, `conversation:${t}`, t)
        r.agentIds.add(w.agentId)
      } else {
        const key =
          by === 'agent'
            ? `agent:${w.agentId}`
            : by === 'kind'
              ? kindKeyOf(w)
              : by === 'task'
                ? w.taskKey
                  ? `task:${w.taskKey}`
                  : 'none'
                : by === 'automation'
                  ? w.automationId
                    ? `automation:${w.automationId}`
                    : 'none'
                  : `account:${w.account ?? w.provider}`
        const label =
          by === 'agent'
            ? this.d.labels.agent(w.agentId)
            : by === 'kind'
              ? (KIND_LABEL[key] ?? key)
              : by === 'task'
                ? w.taskKey
                  ? (this.d.labels.task(w.taskKey) ?? w.taskKey)
                  : 'Not on a task'
                : by === 'automation'
                  ? w.automationId
                    ? (auto(w.automationId) ?? w.automationId)
                    : 'Not an automation'
                  : this.d.labels.provider(w.account ?? w.provider)
        r = rowFor(key, label)
      }
      mark(r)
      if (by === 'agent') {
        const c = seriesClassOf(w)
        mark(r.child(c, SERIES_LABEL[c]))
      }
      totals.windows.add(w.id)
      if (gone) totals.gone.add(w.id)
    }
    if (silos.length > 0) {
      const r = rowFor('silos', 'Silos itself')
      for (const rec of silos) {
        if (rec.at < from || rec.at >= to) continue
        const a: AttributedRecord = { rec, sessionKey: '', threadKey: '', bucket: 'unattributed', window: null }
        r.add(a, false, machineDefault())
        totals.add(a, false, machineDefault())
        bill(machineDefault(), rec)
        bump(localYmd(rec.at), 'silos', totalTokens(rec.tokens))
      }
    }

    // order: the measured rows by weight; then Unattributed, Silos itself and «before» last
    const tail = ['unattributed', 'silos', 'before']
    let list = [...rows.values()].filter((r) => !tail.includes(r.key) && !(r.key === 'none'))
    list.sort(byWeight)
    if (by === 'conversation') list = capped(list, CONVERSATION_ROWS)
    const none = rows.get('none')
    const ordered = [...list, ...(none ? [none] : []), ...tail.map((k) => rows.get(k)).filter((r): r is RowAcc => r !== undefined)]
    const unRow = rows.get('unattributed')
    for (const r of ordered) if (r.key !== 'more') r.label$ = (id) => this.d.labels.agent(id)
    const out = ordered.map((r) => (r === unRow ? r.row((x, y) => byWeight(x, y), CONVERSATION_ROWS) : r.row()))

    const days: UsageReport['series'] = []
    for (let t = from; t < to; t = nextLocalMidnight(t)) {
      const day = localYmd(t)
      days.push({ day, classes: seriesMap.get(day) ?? {}, ...(byAgentDays ? { agents: byAgentDays.get(day) ?? {} } : {}) })
    }
    const notMeasured = [...new Set(got.unmeasuredEngines.values())].sort()
    const tot = totals.row()
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      by,
      agent: agentFilter,
      rows: out,
      series: days,
      totals: {
        tokens: tot.tokens,
        costUsd: tot.costUsd,
        plan: tot.plan,
        turns: totals.windows.size,
        unpriced: tot.unpriced,
        ...(tot.unpricedModels ? { unpricedModels: tot.unpricedModels } : {}),
        consoles: totals.consoles.size,
      },
      since: since !== null ? new Date(since).toISOString() : null,
      sinceDay: since !== null ? localYmd(since) : null,
      today: localYmd(this.now()),
      priced: [...priced]
        .map(([provider, usd]) => ({ provider, label: this.d.labels.provider(provider), costUsd: round(usd) }))
        .sort((x, y) => y.costUsd - x.costUsd),
      accounts: [...accounts].sort().map((account) => {
        const r = this.d.planReading?.(account) ?? null
        return { account, label: this.d.labels.provider(account), weeklyPercent: r?.weeklyPercent ?? null, fiveHourPercent: r?.fiveHourPercent ?? null }
      }),
      notMeasured,
      gone: totals.gone.size,
    }
  }
}

interface Gathered {
  attributed: AttributedRecord[]
  /** threads on an engine that can't say → its label */
  unmeasuredEngines: Map<string, string>
  /** each window's thread */
  windowThread: Map<string, string>
  /** a listed session naming each thread (absent: hidden) */
  threadMeta: Map<string, SessionMeta>
  /** windows whose transcript is gone */
  gone: Set<string>
  /** each thread's provider, from its latest window in the read */
  threadPricing: Map<string, Pricing>
  windows: UsageWindow[]
}

function nextLocalMidnight(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** The page's periods, named — the SERVER computes their range in
 *  its own local days, the ones every row, bar and cap counts by. */
export const USAGE_PERIODS = ['today', '7d', '30d'] as const
export type UsagePeriod = (typeof USAGE_PERIODS)[number]

/** [from, to) of a period: from the local midnight that starts it (today;
 *  the last 7 days; the last 30) to now. */
export function periodRange(p: UsagePeriod, now: number): { from: number; to: number } {
  const d = new Date(now)
  const days = p === '30d' ? 30 : p === '7d' ? 7 : 1
  return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime(), to: now + 1 }
}

async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const k = i++
      out[k] = await fn(items[k]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}
