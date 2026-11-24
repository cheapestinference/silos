// helpers/silo-manifests.ts — the manifests the standard's tests read: the
// silos Silos ships (docs/standard/reference/, the catalog) and the generic
// test fixtures (fixtures/silos/: a files-sourced silo fed by a sync, a
// project-anchored one) that exercise the
// parts of the standard no shipped silo uses. One lookup for both folders.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REFERENCE_DIR } from '../../src/silos/native.js'

export const FIXTURE_SILOS_DIR = join(import.meta.dirname, '..', 'fixtures', 'silos')
export const MANIFEST_DIRS: readonly string[] = [REFERENCE_DIR, FIXTURE_SILOS_DIR]

export function siloFile(id: string): string {
  for (const dir of MANIFEST_DIRS) {
    const f = join(dir, `${id}.silo.json`)
    if (existsSync(f)) return f
  }
  throw new Error(`no manifest ${id}.silo.json in the reference or fixture folders`)
}

export const siloManifest = (id: string): Record<string, any> => JSON.parse(readFileSync(siloFile(id), 'utf8'))
