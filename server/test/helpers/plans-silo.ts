// plans-silo.ts — the built-in Plans silo over a test's plan files: the
// reference manifest read by the kernel's own SiloReader over the folders a
// test writes, and the floor's questions to it (plans-floor.ts). What the
// house wires from the kernel's reading (index.ts / server.ts), built fresh
// on every call so a test that rewrites a plan is read anew.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REFERENCE_DIR } from '../../src/silos/native.js'
import { SiloReader } from '../../src/silos/reader.js'
import { planProgressOf, readyTasksOf, type PlansSilo, type ReadyState } from '../../src/plans-floor.js'

export const plansManifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(REFERENCE_DIR, 'plans.silo.json'), 'utf8')) as Record<string, unknown>

// the silo reading every folder in `folders` (a project location each)
export function plansSiloOf(folders: readonly string[], isAgent: (v: string) => boolean = () => true, now = Date.now()): PlansSilo {
  const manifest = plansManifest()
  const reading = new SiloReader({ agentStates: () => [], projects: () => [...folders] }).read('plans', manifest, { now, isAgent })
  return { manifest, reading }
}

// TriggerDeps.readyTasks / ResidentDeps.planTasks: the folder asked about, read now
export function readyFromDisk(isAgent: (v: string) => boolean = () => true): (folder: string, ownerId: string) => ReadyState[] {
  return (folder, ownerId) => readyTasksOf(plansSiloOf([folder], isAgent), folder, ownerId, { now: Date.now(), isAgent })
}

// autonomyViewOf's planProgress: the folder's plans and the authored ones
export function progressFromDisk(authored: readonly string[] = []): (folder: string) => ReturnType<typeof planProgressOf> {
  return (folder) => planProgressOf(plansSiloOf([folder]), folder, authored, { now: Date.now() })
}
