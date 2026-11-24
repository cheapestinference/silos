// plan-records.ts — the plans silo's record of a plan file, for the web's
// tests: GET /api/silos/plans/record?file= answers the kernel's normalized
// value (each task's `state` beside its `status`). Tests that hold a plan as
// file TEXT bridge the automocked api with this — the record of whatever the
// mocked file.text returns, so «the file is the truth» stays true in them.
import type { SiloRecordDetail } from '../src/lib/types'

export function planRecordOf(path: string, text: string, over: Partial<SiloRecordDetail> = {}): SiloRecordDetail {
  const raw = JSON.parse(text) as Record<string, unknown> // not JSON → throws: the silo would not read it either
  if (typeof raw.title !== 'string' || !Array.isArray(raw.tasks)) throw new Error('not a plan')
  const slug = path.slice(path.lastIndexOf('/') + 1).replace(/\.plan\.json$/, '')
  const folder = path.slice(0, path.lastIndexOf('/plans/'))
  const tasks = (raw.tasks as Array<Record<string, unknown>>).map((t) => ({ dependsOn: [], ...t, state: t.status }))
  return { record: { key: `folder:${folder}/${slug}` }, version: 'v1', value: { ...raw, id: slug, tasks }, ...over } as unknown as SiloRecordDetail
}

// the automocked api: recordByFile reads through the mocked file.text
export function bridgePlanRecords(api: {
  file: { text: (p: string) => Promise<string> }
  silos: { recordByFile: { mockImplementation: (f: (id: string, path: string) => Promise<SiloRecordDetail>) => unknown } }
}): void {
  api.silos.recordByFile.mockImplementation(async (_id, path) => planRecordOf(path, await api.file.text(path)))
}
