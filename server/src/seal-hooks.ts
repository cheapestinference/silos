// seal-hooks.ts — the seam between the stores that WRITE files and the seal
// (seals.ts). A leaf with no imports: json-store.ts,
// harnesses/claude-code/local-settings.ts and role-plugin.ts call these without importing the seal
// (no cycle), and with no seal installed (most tests) every hook is a no-op
// and every write happens exactly as before.

export interface SealHooks {
  /** A sealed write: when the path is under a seal, the seal performs the
   *  write in its contract ORDER (copy → file → cache) and returns true;
   *  false = not sealed, the caller writes as usual. */
  write?(file: string, text: string, mode?: number): boolean
  /** A sealed removal (a store deleting a file of its own): true when the
   *  seal removed it — copy, file and cache together; false = not sealed. */
  remove?(file: string): boolean
  /** A sealed file its store writes ITSELF (an exclusive link-into-place):
   *  stage = step (1), the copy, before the store writes the file; commit =
   *  step (3), the cache, after; abort = the write did not happen. Each
   *  returns/does nothing for a path no restore seal covers. */
  stage?(file: string, text: string): void
  commit?(file: string): void
  abort?(file: string): void
  /** Silos is about to read-modify-write an ENGINE/operator file it watches
   *  by read hash (settings.local.json): notice any foreign change first. */
  beforeOwnEdit?(file: string): void
  /** …and has written it: the new bytes are Silos' — re-seal the read hash. */
  afterOwnEdit?(file: string): void
  /** Silos wrote into an agent's plugin dir (role pack, manifest, accept):
   *  re-seal the tree. `pluginDir` is agent-state/<id>/plugin. */
  pluginWritten?(pluginDir: string): void
}

let hooks: SealHooks = {}

export function setSealHooks(h: SealHooks | null): void {
  hooks = h ?? {}
}

export function sealHooks(): SealHooks {
  return hooks
}
