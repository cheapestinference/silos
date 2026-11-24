// router.ts — the ONLY bridge between the navigation state (store) and the
// URL (history). No component ever touches history: all navigation still
// goes through the store's actions (selectAgent/openSession/changePage/…)
// and this module observes that state and reflects it in the address bar,
// and the reverse on back/forward. The pure serialization logic lives in
// lib/routes.ts; this file only wires it up with the store and the history object.
//
// All navigable state lives in the URL — deep-linkable, refresh-restorable,
// back/forward. See the documented schema in lib/routes.ts.
import { useStore, type State } from '../store'
import { stateToRoute, routeToState, contextKey, returnSteps, type RouteIntent, type RouteSnapshot } from './routes'
import { resolveProjectFolder } from './home'
import { activeLeaveGuard } from './leave-guard'

// an anti-loop guard: set to true while we apply the URL TO the store
// (popstate/boot) so the store's subscription doesn't push the same URL we
// just read back out.
let applying = false

// a startup gate: the store->URL subscription stays INERT until the boot
// deep-link has been restored (restoreFromUrl). Without this, an early
// state change — e.g. loading the overview auto-selecting a candidate
// agent without setting `page` — would push '/' ON TOP OF the URL's
// deep-link before we get to restore it, losing the destination (a real
// bug caught in e2e). The popstate/URL->store direction does not depend on
// this flag: back/forward always work.
let active = false

// a composite navigation gesture fires SEVERAL set() calls in the same
// tick (e.g. startNewConversation = closeSession + set; or a handler
// chaining selectAgent + openSession/changeTab). Without
// coalescing, each set() would push its own history entry and Back would
// land on an intermediate dossier nobody actually visited.
//
// a SINGLE mechanism: a microtask-debounced flush. The subscription only
// FLAGS that something is pending; a queued microtask reads the burst's
// already-settled FINAL state and does ONE history write. For this to
// hold, a composite gesture's navigation has to SETTLE within a single
// synchronous tick — that's why `openSession` (store.ts) sets
// selectedAgentId/selected/page SYNCHRONOUSLY before its fetch's
// `await`, resolving the owner from the already-loaded overview; that way
// selectAgent + openSession land in the same tick and the coalescer
// merges them into ONE entry, with no heuristics like "the last one was a
// bare dossier" (that approach couldn't tell a composite gesture apart
// from two deliberate ones — it collapsed the most common flow, "open
// agent -> click a session", and ate a Back stop; removed).
let flushPending = false

// the next history write REPLACES whatever the stops say — set by a UI
// «back» link that could not walk back (it navigates, never stacks) and by
// a redirect (an alias resolving to its canonical address). Consumed by
// the next flush; cleared after the gesture's tick if nothing changed.
let forceReplace = false

// ── the entries' trail ────────────────────────────────────────────────────
// Every entry Silos writes carries, in history.state, the URLs below it
// (oldest first, capped): what a UI «back» link needs to know whether its
// origin is right below — the History API alone cannot tell. It survives
// a reload with the entry; a cold entry (a pasted
// link, a push notification) has none, so its «back» links navigate.
const TRAIL_CAP = 40
interface EntryState {
  silosTrail: string[]
}
function trailOf(state: unknown): string[] {
  const t = (state as Partial<EntryState> | null)?.silosTrail
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : []
}
function pushEntry(url: string): void {
  const trail = [...trailOf(window.history.state), currentUrl()].slice(-TRAIL_CAP)
  window.history.pushState({ silosTrail: trail } satisfies EntryState, '', url)
}
function replaceEntry(url: string): void {
  window.history.replaceState({ silosTrail: trailOf(window.history.state) } satisfies EntryState, '', url)
}

function snapshotOf(s: State): RouteSnapshot {
  return {
    page: s.page,
    selected: s.selected,
    newChatOpen: s.newChatOpen,
    tab: s.tab,
    projectTab: s.projectTab,
    from: s.agentFrom,
    sheet: s.homeSheet,
    file: s.viewingFile,
    filesPart: s.filesPart,
  }
}

// applies a parsed intent using ONLY the store's actions — it never writes
// state by hand, so the rest of the store's invariants (convPrefs resets,
// unreadAgentIds, mobileView…) are respected exactly as if the user had
// navigated by hand. Degrades honestly: an agent/session/automation that
// no longer exists falls back to a sane destination instead of crashing.
async function applyIntent(i: RouteIntent): Promise<void> {
  const st = useStore.getState()
  const p = i.page
  if (p === null) {
    st.changePage(null)
    if (i.sheet) useStore.getState().setHomeSheet(i.sheet)
    return
  }
  if (p.kind === 'agent') {
    // a deep-link to a deleted (or not-yet-loaded) agent -> an honest home.
    if (!st.agents.some((a) => a.id === p.id)) {
      st.changePage(null)
      return
    }
    if (i.session) {
      try {
        // openSession is the source of truth for the conversation's owner:
        // it sets selectedAgentId/page to the session's REAL agent (which
        // can differ from the URL's <id> — the later canonicalization
        // fixes it in the address bar).
        await useStore.getState().openSession(i.session.folder, i.session.id)
      } catch {
        // a deleted/unreadable session -> falls back to the agent's
        // dossier, without crashing.
        useStore.getState().selectAgent(p.id)
        return
      }
      return
    }
    if (i.newChat) {
      st.selectAgent(p.id)
      useStore.getState().startNewConversation()
      return
    }
    st.selectAgent(p.id)
    useStore.getState().changeTab(i.facet ?? 'threads')
    if (i.filesPart) useStore.getState().setFilesPart(i.filesPart)
    // the return chip (?from=, or a legacy facet-over-conversation URL)
    if (i.from) useStore.getState().setAgentFrom(i.from)
    return
  }
  if (p.kind === 'project') {
    // /project/-home-u-x (the munged session-folder form) lands on the
    // known folder it names; applyGuarded then rewrites the address bar to
    // the canonical /project/%2Fhome%2Fuser%2Fx with replaceState.
    const folder = resolveProjectFolder(st.agents, p.folder) ?? p.folder
    st.changePage(folder === p.folder ? p : { ...p, folder })
    if (i.projectTab) useStore.getState().changeProjectTab(i.projectTab)
    if (i.filesPart) useStore.getState().setFilesPart(i.filesPart)
    if (i.sheet) useStore.getState().setHomeSheet(i.sheet)
    return
  }
  if (p.kind === 'automation' && p.id === 'new') {
    // the editor creating one: an agent that no longer exists is simply
    // not preselected — the picker is right there.
    if (p.agent && !st.agents.some((a) => a.id === p.agent)) {
      const { agent: _gone, ...rest } = p
      st.changePage(rest)
    } else st.changePage(p)
    return
  }
  if (p.kind === 'automation') {
    // the same honest fallback as the agent case — a nonexistent
    // automation (a garbage / deleted id) is NOT a dead end: it falls back
    // to home and the address bar gets canonicalized to '/'. The
    // automations list is already loaded by boot time (App waits for
    // loadAutomations before restoring) and on any later navigation.
    if (!st.automations.some((a) => a.id === p.id)) {
      st.changePage(null)
      return
    }
    // openAutomation also fires loadAutomationRuns — same as a click.
    st.openAutomation(p.id)
    return
  }
  // settings | board | map: changePage already carries the tab inside `page`.
  st.changePage(p)
}

// applies an intent with the anti-loop guard held and, once done,
// CANONICALIZES the URL to the real final state (replaceState, no new
// history entry) — so a URL the store "corrected" (a session's real
// agentId, a nonexistent session/automation -> dossier/home, an invalid
// path -> '/') ends up faithfully reflected in the address bar without
// littering back/forward.
async function applyGuarded(i: RouteIntent, fromPop = false): Promise<void> {
  applying = true
  try {
    await applyIntent(i)
    // the file sheet over the page (?file=) — applied after the place, whose
    // actions close any sheet; an entry without one closes it (Back)
    useStore.getState().setViewingFile(i.file ?? null)
  } finally {
    applying = false
    const route = stateToRoute(snapshotOf(useStore.getState()))
    if (route !== currentUrl()) {
      // a back/forward a leave guard held (unsaved changes, see
      // lib/leave-guard.ts): the page stayed, so it goes back on the stack
      // as a new entry — rewriting the popped-to entry instead would leave
      // the NEXT Back stepping out of Silos altogether.
      if (fromPop && activeLeaveGuard()) pushEntry(route)
      else replaceEntry(route)
    }
  }
}

// the real history write: reads the store's FINAL state and does ONE
// operation (push or replace). Called from the debounce's microtask.
function syncUrl(): void {
  if (applying || !active) return
  const next = stateToRoute(snapshotOf(useStore.getState()))
  // with the query: a route that carries one (/automation/new?agent=…,
  // /files?path=…) would otherwise never equal the bare pathname
  const current = currentUrl()
  const replace = forceReplace
  forceReplace = false
  if (next === current) return
  // the same stop (a filter, a view, a value riding along) -> replaceState;
  // another stop (a place, a tab, a sheet, a record) -> pushState. The
  // grammar is contextKey's (lib/routes.ts).
  if (replace || contextKey(current) === contextKey(next)) replaceEntry(next)
  else pushEntry(next)
}

// store -> URL: the subscription does NOT write to history directly — it
// only enqueues (dedupes) a microtask that will do ONE write with the
// already-settled state.
function onStoreChange(): void {
  if (applying || !active) return
  if (flushPending) return
  flushPending = true
  queueMicrotask(() => {
    flushPending = false
    syncUrl()
  })
}

// URL -> store: the browser's back/forward.
// pathname + search: the Files deep-link carries its open file in the
// query (/files?path=…) — pathname alone silently dropped it.
function currentUrl(): string {
  return window.location.pathname + window.location.search
}

function onPopstate(): void {
  void applyGuarded(routeToState(currentUrl()), true)
}

// wires up both directions. Called ONCE from App; returns the cleanup.
// The subscription is safe from startup: before the user navigates, the
// `page` state doesn't change, so nothing spurious gets pushed while the
// overview loads.
export function connectRouter(): () => void {
  const unsubscribe = useStore.subscribe(onStoreChange)
  window.addEventListener('popstate', onPopstate)
  return () => {
    unsubscribe()
    window.removeEventListener('popstate', onPopstate)
  }
}

// the boot deep-link: called AFTER the overview (and the automations, to
// be able to validate an automation id) have loaded — the agents and
// sessions have to exist to resolve an id/session from the URL. Restores
// the state from window.location.pathname; if it doesn't resolve, it
// gracefully falls back to home (applyIntent does that).
export async function restoreFromUrl(): Promise<void> {
  await applyGuarded(routeToState(currentUrl()))
  // from here on the store's state IS the URL's truth: the store->URL
  // sync gets activated so every later navigation reflects it.
  active = true
}

// the URL a (possibly not yet applied) state would have — the leave guard
// computes where a held gesture was going (lib/leave-guard.ts).
export function routeOfState(s: State): string {
  return stateToRoute(snapshotOf(s))
}

// navigates to a route as if by a link: one history entry, applied through
// the store's actions (the same path as back/forward). The leave guard's
// "Discard" replays a held gesture this way.
export function navigateToRoute(route: string): void {
  if (route !== currentUrl()) pushEntry(route)
  void applyGuarded(routeToState(route))
}

// a UI «back» link («‹ conversation», a task's origin, «‹ silo», a sheet's
// ✕): when its target is right below — over entries of this same place
// only — it is the browser's Back (history.go), so the stack shrinks
// instead of growing; otherwise `go` navigates there and the entry is
// REPLACED: a «back» never stacks.
export function goBackTo(target: string, go: () => void): void {
  const steps = active ? returnSteps(trailOf(window.history.state), currentUrl(), target) : 0
  if (steps > 0) {
    window.history.go(-steps)
    return
  }
  replacing(go)
}

// runs a navigation whose history write REPLACES the current entry — a
// redirect (an alias resolved to its canonical address) or a «back» that
// could not walk back.
export function replacing(go: () => void): void {
  forceReplace = true
  go()
  // nothing changed (already there): the flag must not leak into the next
  // gesture. Queued after the store's own flush, so that one consumes it.
  queueMicrotask(() => {
    forceReplace = false
  })
}

// closes the sheet open over Home / a project's Now: the sheet was a stop,
// so closing it is Back when the page under it is right below; else the
// entry is rewritten without the sheet.
export function closeHomeSheet(): void {
  const target = stateToRoute({ ...snapshotOf(useStore.getState()), sheet: null })
  goBackTo(target, () => useStore.getState().setHomeSheet(null))
}

// opens a file in the one viewer over the page you are in:
// a stop of its own, so Back closes it — never a change of place.
export function openFileSheet(path: string): void {
  useStore.getState().setViewingFile(path)
}

// closes the file sheet: Back when the page under it is right below, else
// the entry is rewritten without the sheet (a pasted ?file= link).
export function closeFileSheet(): void {
  const target = stateToRoute({ ...snapshotOf(useStore.getState()), file: null })
  goBackTo(target, () => useStore.getState().setViewingFile(null))
}

// the route of a state in the making — a «back» link's target
export function routeOf(snapshot: Partial<RouteSnapshot> & Pick<RouteSnapshot, 'page'>): string {
  return stateToRoute({ selected: null, newChatOpen: false, tab: 'threads', projectTab: 'now', ...snapshot })
}

// tests only: resets the guards between cases.
export function __resetRouterForTests(): void {
  applying = false
  active = false
  flushPending = false
  forceReplace = false
}
