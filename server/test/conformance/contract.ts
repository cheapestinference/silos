// conformance/contract.ts — what a conformance fixture declares
// (harness-conformance.test.ts loads every ./conformance/*.fixture.ts by
// glob). Not a fixture itself: the shapes, the shared secrets the launch
// checks look for, and the per-test cleanup list the readers register with.
import type { Agent, SessionMeta } from '../../src/types.js'
import type { ChatTurnHooks, Harness, HarnessId, HarnessReader, HeadlessEngine } from '../../src/harnesses/contract.js'
import type { ResolvedProvider } from '../../src/providers-store.js'
import type { ChatSendInput } from '../../src/chat-service.js'
import type { SessionIndex } from '../../src/session-index.js'

/** The provider key a launch spec carries — argv must never contain it. */
export const KEY = 'sk-conf'

export interface ReaderUnderTest {
  harness: HarnessId
  ownsId(id: string): boolean
  index: SessionIndex
  list(): SessionMeta[]
  /** a session it lists, to remove */
  victim: { folder: string; id: string }
  /** the reader itself, for the contract's optional members */
  reader: HarnessReader
  /** an id of this harness it has never seen */
  unknown: { folder: string; id: string }
  /** the projects root its files live under, when file-backed (a SessionStore over it can trash them) */
  root?: string
  /** a session it knows by id but must not list (hidden), when the fixture has one */
  hiddenOne?: { folder: string; id: string }
}

export interface ConformanceFixture {
  harness: Harness
  /** what launchSpec carries for this engine */
  provider: ResolvedProvider
  /** an id it owns (disjointness) */
  sampleId: string
  resumeId: string
  reader(): Promise<ReaderUnderTest>
  fileBacked: boolean
  /** what remove() of a never-seen id answers */
  unknownRemove: false | undefined
  /** optional: the emit-every-event check. `hooks` is the suite's, so it
   *  can compare what the engine yields with what it emitted. */
  headless?(hooks: ChatTurnHooks): { engine: HeadlessEngine; agent: Agent; input: ChatSendInput }
}

const cleanups: (() => void)[] = []
/** A reader fixture's teardown, run after each test. */
export function onCleanup(c: () => void): void {
  cleanups.push(c)
}
export function runCleanups(): void {
  for (const c of cleanups.splice(0)) c()
}
