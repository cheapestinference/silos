// OpenCode's conformance fixture: an OpenCodeReader over a throwaway DB
// (helpers/opencode-db), joined to a SessionIndex the way index.ts does
// (moved verbatim from harness-conformance.test.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeOpenCodeDb } from '../helpers/opencode-db.js'
import { opencode } from '../../src/harnesses/opencode/index.js'
import { OpenCodeReader } from '../../src/harnesses/opencode/reader.js'
import { ClaudeReader } from '../../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../../src/agent-registry.js'
import { SessionIndex } from '../../src/session-index.js'
import { KEY, onCleanup, type ConformanceFixture, type ReaderUnderTest } from './contract.js'

const T0 = 1776984076759

async function opencodeReader(): Promise<ReaderUnderTest> {
  const base = mkdtempSync(join(tmpdir(), 'conf-opencode-'))
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'agents', 'writer'), { recursive: true })
  writeFileSync(
    join(dataDir, 'agents.json'),
    JSON.stringify({ agents: [{ id: 'writer', name: 'Writer', role: 'writer', folder: '/home/u/proj', framework: 'opencode' }] }),
  )
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  const db = makeOpenCodeDb(join(dataDir, 'agents', 'writer'))
  db.insertSession({
    id: 'ses_conf1',
    project_id: 'p1',
    directory: '/home/u/proj',
    title: 'conf',
    version: '1.14.22',
    time_created: T0,
    time_updated: T0 + 1000,
  })
  db.insertMessage({ id: 'msg_1', session_id: 'ses_conf1', time_created: T0 + 10, data: { role: 'user', agent: 'build', time: { created: T0 + 10 } } })
  mkdirSync(join(base, 'global'))
  const globalDb = makeOpenCodeDb(join(base, 'global'))
  const reader = new OpenCodeReader({ dataDir, registry, globalDb: globalDb.path, muted: [], ephemeralPrefix: null })
  const emptyRoot = join(base, 'projects')
  mkdirSync(emptyRoot)
  const index = new SessionIndex(new ClaudeReader(emptyRoot, join(base, 'cache.json')))
  index.addReader(reader)
  await index.init()
  onCleanup(() => {
    reader.close()
    db.close()
    globalDb.close()
    rmSync(base, { recursive: true, force: true })
  })
  return {
    harness: 'opencode',
    ownsId: (x) => reader.ownsId(x),
    index,
    list: () => reader.list(),
    victim: { folder: '-home-u-proj', id: 'ses_conf1' },
    reader,
    unknown: { folder: '-home-u-proj', id: 'ses_never_seen' },
  }
}

export const fixture: ConformanceFixture = {
  harness: opencode,
  provider: { id: 'prov', kind: 'harness-provider', label: 'Conf', harness: 'opencode', providerId: 'zai', apiKey: KEY },
  sampleId: 'ses_x',
  resumeId: 'ses_x',
  reader: opencodeReader,
  fileBacked: false,
  // OpenCode hides Silos-side: the reader cannot tell, the index announces once
  unknownRemove: undefined,
}
