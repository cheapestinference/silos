// Claude Code's conformance fixture: a ClaudeReader over a JSONL fixture,
// the index's fallback reader (moved verbatim from harness-conformance.test.ts).
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCode } from '../../src/harnesses/claude-code/index.js'
import { ClaudeReader } from '../../src/harnesses/claude-code/reader.js'
import { SessionIndex } from '../../src/session-index.js'
import { KEY, onCleanup, type ConformanceFixture, type ReaderUnderTest } from './contract.js'

const ID = 'e8d01560-f788-4cd6-9dbc-1dc32e174b91'
const FIX = new URL('../fixtures/basic.jsonl', import.meta.url).pathname

async function claudeReader(): Promise<ReaderUnderTest> {
  const base = mkdtempSync(join(tmpdir(), 'conf-claude-'))
  onCleanup(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'projects')
  mkdirSync(join(root, '-p'), { recursive: true })
  const file = join(root, '-p', `${ID}.jsonl`)
  cpSync(FIX, file)
  const old = (Date.now() - 3_600_000) / 1000
  utimesSync(file, old, old)
  // a bookkeeping-only stub (no timestamped record, no turns): known by id, never listed
  const STUB = '6a1f0c3e-0000-4000-8000-00000000b00c'
  writeFileSync(join(root, '-p', `${STUB}.jsonl`), '{"type":"ai-title","aiTitle":"stub"}\n')
  const reader = new ClaudeReader(root, join(base, 'cache.json'))
  const index = new SessionIndex(reader)
  await index.init()
  onCleanup(() => index.stopHeartbeat())
  return {
    harness: 'claude-code',
    ownsId: (x) => reader.ownsId(x),
    index,
    list: () => reader.list(),
    victim: { folder: '-p', id: ID },
    root,
    reader,
    unknown: { folder: '-p', id: '0f0f0f0f-0000-4000-8000-000000000000' },
    hiddenOne: { folder: '-p', id: STUB },
  }
}

export const fixture: ConformanceFixture = {
  harness: claudeCode,
  provider: { id: 'prov', kind: 'anthropic-compatible', label: 'Conf', baseUrl: 'https://conf.test', apiKey: KEY },
  sampleId: ID,
  resumeId: ID,
  reader: claudeReader,
  fileBacked: true,
  unknownRemove: false,
}
