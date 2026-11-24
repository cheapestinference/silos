// The fake third harness's conformance fixture (fixtures/fake-harness.ts):
// its in-memory reader joined to a SessionIndex behind an empty Claude
// reader, the way compose.ts joins every non-fallback reader. The suite
// registers fakeHarness in beforeAll and unregisters it in afterAll.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeHarness } from '../fixtures/fake-harness.js'
import { ClaudeReader } from '../../src/harnesses/claude-code/reader.js'
import { SessionIndex } from '../../src/session-index.js'
import type { HarnessBootContext } from '../../src/harnesses/contract.js'
import type { ChatDeps } from '../../src/chat-service.js'
import type { Agent } from '../../src/types.js'
import { KEY, onCleanup, type ConformanceFixture, type ReaderUnderTest } from './contract.js'

async function fakeReader(): Promise<ReaderUnderTest> {
  const base = mkdtempSync(join(tmpdir(), 'conf-fake-'))
  onCleanup(() => rmSync(base, { recursive: true, force: true }))
  const reader = fakeHarness.boot!({} as HarnessBootContext).reader!
  const emptyRoot = join(base, 'projects')
  mkdirSync(emptyRoot)
  const index = new SessionIndex(new ClaudeReader(emptyRoot, join(base, 'cache.json')))
  index.addReader(reader)
  await index.init()
  onCleanup(() => index.stopHeartbeat())
  return {
    harness: 'fake',
    ownsId: (x) => reader.ownsId(x),
    index,
    list: () => reader.list(),
    victim: { folder: '-p', id: 'fake_1' },
    reader,
    unknown: { folder: '-p', id: 'fake_never_seen' },
  }
}

export const fixture: ConformanceFixture = {
  harness: fakeHarness,
  provider: { id: 'prov', kind: 'anthropic-compatible', label: 'Conf', baseUrl: 'https://conf.test', apiKey: KEY },
  sampleId: 'fake_x',
  resumeId: 'fake_x',
  reader: fakeReader,
  fileBacked: false,
  // an id it never knew: remove() says so, the index stays silent
  unknownRemove: false,
  headless: (hooks) => ({
    engine: fakeHarness.headless!({ deps: {} as ChatDeps, hooks, options: undefined })!,
    agent: { id: 'conf', name: 'Conf', folder: '/p', framework: 'fake' } as Agent,
    input: { turnId: 'tf', agentId: 'conf', text: 'hi' },
  }),
}
