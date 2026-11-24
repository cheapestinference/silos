// registrar.ts — seals the id an OpenCode console got.
//
// A Claude console is born under the id Silos picks (`--session-id`); an
// OpenCode console cannot be: OpenCode mints its own `ses_…` id. So the
// plugin (plugin-opencode/silos.ts) reports it in a birth marker carrying
// the Silos console key it was launched in (SILOS_CONSOLE_KEY), and this
// sweep turns that marker into what a Silos launch leaves behind: a native
// record (owner + "Silos launched it", so the session is never read as a
// nested run) and the console key ↔ native id binding on the terminals.
//
// Trust: an agent can write any marker in its own state dir (births-store
// checks only that the marker names that dir's agent), and agents share the
// uid, so any of them can list the console keys on Silos' tmux socket and
// read other agents' session ids. A marker is therefore sealed only when
// ALL hold:
//   · it has no `parent`: a child/subagent session shares its parent's
//     console key, and binding the console to it would be wrong;
//   · the session it names is in the marker agent's OWN opencode.db
//     (agentOfDb === agentId) — never a Claude session, a global-DB one or
//     another agent's. Not there yet (null) = wait: the reader's 'created'
//     event and the 5 s tick retry;
//   · its console key is a LIVE Silos console, launched by Silos for that
//     same agent (consoleAgent; null = not recorded yet → wait);
//   · the marker landed (ctime) no earlier than that console was created —
//     a marker planted before the console cannot be its birth;
//   · the key is not bound yet — or, `/new` typed inside the console (a
//     second session under the same key): the key is bound to an older
//     genuine seal of the SAME agent (its native record names that agent),
//     and this marker is no older than that seal's marker nor than the
//     console's Silos-owned record. Same agent + same key + newer is the
//     proof: the session is sealed as a new conversation and the binding
//     MOVES to it; the previous one keeps its native record (a finished
//     conversation of the same agent). Anything else bound: refused.
//   · the id is not contested (in more than one DB — reader isContested).
// A refusal (a check that fails for good) is warned once per marker; a
// "wait" is silent. Idempotent: a sealed marker (native record present) is
// skipped.
//
//   · no other UNSEALED marker claims the same console key (an agent can
//     write a marker naming any key it can list; two pending claims →
//     nobody, warned once). A sealed marker no longer claims: after `/new`
//     the console's first session and its second share the key.
//
// On a seal, the account the owner picked for the console (the record's
// `providerPick`, written by POST /api/console before the id was known) is
// pinned on the conversation — the "account per conversation" rule holds
// past a wake, a headless turn and the runs-on line.
//
// rehydrate() — the terminals keep key ↔ id and each console's launch
// agent in memory; a Silos restart loses them while the tmux consoles live
// on. They are rebuilt from the console RECORDS only (terminal-service:
// Silos-owned files under the data dir, written at launch and on bind),
// intersected with the live tmux keys — never from markers or the tmux env,
// which agents can write. A bound id that became contested is not rebound.
import type { Birth, BirthsStore } from '../../births-store.js'
import type { NativeStore } from '../../native-store.js'
import type { TerminalService } from '../../terminal-service.js'
import type { ConversationPrefsStore } from '../../conversation-prefs.js'

// ConsoleRegistrarDeps.pinProvider over the conversation-prefs store: the
// console's pick becomes the conversation's `provider` pin unless the owner
// already pinned one.
export function pinProviderInto(prefs: Pick<ConversationPrefsStore, 'get' | 'patch'>): (folder: string, sessionId: string, provider: string) => void {
  return (folder, sessionId, provider) => {
    if (!prefs.get(folder, sessionId)?.provider) prefs.patch(folder, sessionId, { provider })
  }
}

/** the model pick the same way — never over a model already pinned */
export function pinModelInto(prefs: Pick<ConversationPrefsStore, 'get' | 'patch'>): (folder: string, sessionId: string, model: string) => void {
  return (folder, sessionId, model) => {
    if (!prefs.get(folder, sessionId)?.model) prefs.patch(folder, sessionId, { model })
  }
}

export interface ConsoleRegistrarDeps {
  births: Pick<BirthsStore, 'all'>
  native: Pick<NativeStore, 'get' | 'register'>
  terminals: Pick<TerminalService, 'listConsoles' | 'bindNativeId' | 'consoleAgent' | 'nativeIdOf' | 'setConsoleAgent' | 'consoleRecords' | 'consoleRecord'>
  mungePath: (p: string) => string
  // reader.ts agentOfDb — the agent whose own opencode.db holds the session
  agentOfDb: (sessionId: string) => string | null
  // reader.ts isContested — the id is in more than one DB
  isContested?: (sessionId: string) => boolean
  // pins the console's account pick on a sealed conversation
  // (conversation-prefs `provider`); never overwrites a pin already there
  pinProvider?: (folder: string, sessionId: string, provider: string) => void
  // pins the console's model pick the same way (conversation-prefs `model`)
  pinModel?: (folder: string, sessionId: string, model: string) => void
}

export class ConsoleRegistrar {
  private warned = new Set<string>()
  constructor(private deps: ConsoleRegistrarDeps) {}

  // Seals every pending OpenCode console marker; resolves how many it
  // sealed. Sweeps never overlap (the tmux listing is async now): a sweep
  // asked while one runs runs right after it, so a caller that awaits it
  // (POST /api/console's beforeOpen) always sees a pass that began after
  // its own ask.
  private sweeping: Promise<unknown> = Promise.resolve()
  sweep(): Promise<number> {
    const next = this.sweeping.then(
      () => this.sweepOnce(),
      () => this.sweepOnce(),
    )
    this.sweeping = next.catch(() => undefined)
    return next
  }

  private async sweepOnce(): Promise<number> {
    let sealed = 0
    // ONE tmux listing per sweep, and only if some marker gets that far
    let live: Map<string, number | null> | null = null
    const consoles = async (): Promise<Map<string, number | null>> =>
      (live ??= new Map((await this.deps.terminals.listConsoles()).map((c) => [c.key, c.createdMs])))
    const markers = this.deps.births.all().filter((b) => b.harness === 'opencode' && !!b.consoleKey)
    const sealedAlready = (b: Birth): boolean => !!b.cwd && this.deps.native.get(this.deps.mungePath(b.cwd), b.sessionId) !== null
    const claims = new Map<string, number>()
    for (const b of markers) if (!sealedAlready(b)) claims.set(b.consoleKey as string, (claims.get(b.consoleKey as string) ?? 0) + 1)
    for (const b of markers) {
      if (!b.consoleKey) continue
      if (!b.cwd) {
        this.refuse(b.sessionId, 'no cwd')
        continue
      }
      const folder = this.deps.mungePath(b.cwd)
      if (this.deps.native.get(folder, b.sessionId)) continue
      if ((claims.get(b.consoleKey) ?? 0) > 1) {
        this.refuse(b.sessionId, `console ${b.consoleKey} is claimed by more than one marker`)
        continue
      }
      const verdict = await this.check(b, b.consoleKey, consoles, markers)
      if (verdict !== 'seal') {
        if (verdict !== 'wait') this.refuse(b.sessionId, verdict)
        continue
      }
      try {
        this.deps.native.register(folder, b.sessionId, { agentId: b.agentId, createdAt: b.at })
      } catch (err) {
        // runs from a watch callback and a timer: never throw — next sweep retries
        console.warn(`opencode registrar: could not seal ${b.sessionId}: ${(err as Error).message}`)
        continue
      }
      this.deps.terminals.bindNativeId(b.consoleKey, b.sessionId)
      const rec = this.deps.terminals.consoleRecord(b.consoleKey)
      const pick = rec?.providerPick
      if (pick && this.deps.pinProvider) {
        try {
          this.deps.pinProvider(folder, b.sessionId, pick)
        } catch (err) {
          console.warn(`opencode registrar: could not pin ${pick} on ${b.sessionId}: ${(err as Error).message}`)
        }
      }
      // the model picked for the new console pins with it (the panel's pending pin)
      if (rec?.modelPick && this.deps.pinModel) {
        try {
          this.deps.pinModel(folder, b.sessionId, rec.modelPick)
        } catch (err) {
          console.warn(`opencode registrar: could not pin model ${rec.modelPick} on ${b.sessionId}: ${(err as Error).message}`)
        }
      }
      sealed++
    }
    return sealed
  }

  // Rebuilds key ↔ id and launch agents for the live consoles after a
  // restart, from the console records (see the header). Returns how many
  // consoles it rebound to a session.
  async rehydrate(): Promise<number> {
    let rebound = 0
    // the listing also prunes the records of consoles that are gone
    const live = new Set((await this.deps.terminals.listConsoles()).map((c) => c.key))
    for (const r of this.deps.terminals.consoleRecords()) {
      if (!live.has(r.key) || r.harness !== 'opencode') continue
      if (r.agentId) this.deps.terminals.setConsoleAgent(r.key, r.agentId)
      if (!r.nativeId || this.deps.terminals.nativeIdOf(r.key) !== null || this.deps.isContested?.(r.nativeId)) continue
      this.deps.terminals.bindNativeId(r.key, r.nativeId)
      rebound++
    }
    return rebound
  }

  // 'seal', 'wait' (may pass on a later sweep — silent), or the reason a
  // marker is refused.
  private async check(
    b: Birth,
    key: string,
    consoles: () => Promise<Map<string, number | null>>,
    markers: readonly Birth[],
  ): Promise<'seal' | 'wait' | string> {
    if (b.parent != null) return 'child session (has a parent)'
    if (this.deps.isContested?.(b.sessionId)) return 'the session is in more than one database'
    const inDb = this.deps.agentOfDb(b.sessionId)
    if (inDb === null) return 'wait' // not in the agent's DB (yet) — or never: a Claude / global-DB id
    if (inDb !== b.agentId) return `the session is in ${inDb}'s database`
    const live = await consoles()
    if (!live.has(key)) return 'wait' // not up yet, or gone
    const consoleAgent = this.deps.terminals.consoleAgent(key)
    if (consoleAgent === null) return 'wait'
    if (consoleAgent !== b.agentId) return `console ${key} was not launched for ${b.agentId}`
    const createdMs = live.get(key) ?? null
    if (createdMs === null) this.warnOnce(`created:${key}`, `opencode registrar: console ${key} has no creation time — marker age not checked`)
    else if (b.ctimeMs < createdMs) return `the marker is older than console ${key}`
    // bound to this very id already: seal the record, the binding stands
    const bound = this.deps.terminals.nativeIdOf(key)
    if (bound !== null && bound !== b.sessionId) return this.newConversation(b, key, bound, markers)
    return 'seal'
  }

  // `/new` inside a console bound to `bound` (see the header): 'seal' when
  // the bound session is a genuine seal of the marker's agent and this
  // marker is no older than that seal nor than the console's record.
  private newConversation(b: Birth, key: string, bound: string, markers: readonly Birth[]): 'seal' | string {
    const boundMarker = markers.find((m) => m.sessionId === bound && m.agentId === b.agentId)
    const boundFolder = this.deps.mungePath(boundMarker?.cwd ?? (b.cwd as string))
    if (this.deps.native.get(boundFolder, bound)?.agentId !== b.agentId) return `console ${key} is already bound`
    const rec = this.deps.terminals.consoleRecord(key)
    if (!rec) return `console ${key} is already bound (no console record)`
    if (b.ctimeMs < rec.createdMs) return `the marker is older than console ${key}`
    if (boundMarker && b.ctimeMs < boundMarker.ctimeMs) return `the marker is older than the session console ${key} is bound to`
    return 'seal'
  }

  private warnOnce(tag: string, message: string): void {
    if (this.warned.has(tag)) return
    this.warned.add(tag)
    console.warn(message)
  }

  private refuse(sessionId: string, reason: string): void {
    this.warnOnce(sessionId, `opencode registrar: marker ${sessionId} refused — ${reason}`)
  }
}
