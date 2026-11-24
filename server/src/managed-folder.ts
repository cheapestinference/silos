// managed-folder.ts — the ONE rule for "a folder Silos may act on by path":
// a registry agent's folder or one of its extra territories (folders[]),
// active agents only (archived = out of play). Every folder-keyed route
// (/api/folders/:folder/…) resolves its segment here, so
// none of them ever operates on an arbitrary path from the request.
//
// The segment is the folder's exact path (URI-encoded by the web), so
// proj.one and proj-one never collide; the older munged form still resolves
// when it names exactly one managed folder. Anything else — an unknown path,
// an ambiguous munge — is null (the routes answer 404).
import { mungePath, type AgentRegistry } from './agent-registry.js'
import { territoriesOf } from './territory.js'

export function managedFolderOf(registry: Pick<AgentRegistry, 'list'>, param: string): string | null {
  const hits = new Set<string>()
  for (const a of registry.list()) {
    for (const f of territoriesOf(a)) {
      if (param.startsWith('/') ? f === param : mungePath(f) === param) hits.add(f)
    }
  }
  return hits.size === 1 ? (hits.values().next().value as string) : null
}
