// artifacts-aggregate.ts — aggregated artifacts list ("what has this agent
// produced > what have we talked about"). PURE function over what the
// index already has in memory (SessionContext.links.artifacts, accumulated
// by ContextAccumulator from the JSONL's frame-link entries) — no
// re-parsing, no fabrication: if a session never emitted a frame-link,
// nothing shows up here. Same module criteria as tools-aggregate.ts: pure,
// testable logic, with the pass over index.allSessions() living in server.ts.
import type { ArtifactItem } from './types.js'

// Response cap: the 200 most recent (the real total travels separately so
// the UI can be honest about "N in total").
export const ARTIFACTS_CAP = 200

export interface ArtifactSessionEntry {
  folder: string
  id: string
  cwd: string | null
  agentId: string
  sessionTitle: string
  artifacts: readonly { path: string; url: string; ts: string; title?: string }[]
}

export interface ArtifactFilter {
  agent?: string | undefined
  // REAL project path (same semantics as ProjectPage: a session belongs to
  // the project if its cwd is the folder or hangs off it — this also
  // covers worktrees physically inside the project).
  folder?: string | undefined
}

// Honest title: the published page's title when the accumulator captured
// one (Artifact tool_result), else the last segment of the path — nothing
// else is invented.
function titleOf(a: { path: string; title?: string }): string {
  if (a.title) return a.title
  const seg = a.path.split('/').filter(Boolean).pop()
  return seg ?? a.path
}

// Scheme allowlist. Frame-links come from transcripts Silos didn't write
// (foreign data) and this route turns them into CLICKABLE rows — a
// handcrafted `javascript:`/`data:` frameUrl would execute in the app's own
// origin (with access to the localStorage token). Filtered HERE, at
// aggregation time: a non-https URL never reaches the client. https-only on
// purpose: the real corpus is 100% https://claude.ai/... — if a real case
// ever needs http://localhost, it gets extended with a test, not before.
function isAllowedUrl(url: string): boolean {
  return url.startsWith('https://')
}

function tsMs(ts: string): number {
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : 0
}

export function aggregateArtifacts(entries: readonly ArtifactSessionEntry[], filter: ArtifactFilter = {}): { artifacts: ArtifactItem[]; total: number } {
  const out: ArtifactItem[] = []
  for (const e of entries) {
    if (filter.agent !== undefined && e.agentId !== filter.agent) continue
    if (filter.folder !== undefined) {
      if (e.cwd === null) continue
      if (e.cwd !== filter.folder && !e.cwd.startsWith(filter.folder + '/')) continue
    }
    for (const a of e.artifacts) {
      if (!isAllowedUrl(a.url)) continue // see isAllowedUrl — never travels to the client
      out.push({
        title: titleOf(a),
        url: a.url,
        path: a.path,
        ts: a.ts,
        sessionKey: `${e.folder}/${e.id}`,
        sessionTitle: e.sessionTitle,
        agentId: e.agentId,
      })
    }
  }
  // most recent first; an invalid/empty ts falls to the end (0), stably.
  out.sort((x, y) => tsMs(y.ts) - tsMs(x.ts))
  // Dedup by URL — the harness re-emits a frame-link for the SAME artifact
  // on every redeploy (verified in the real corpus: the same URL repeated
  // line after line). After the desc sort, the first occurrence of each URL
  // is the most recent — that's the one kept; `total` counts the deduped
  // set, not the repeats.
  const seen = new Set<string>()
  const unique = out.filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true)))
  return { artifacts: unique.slice(0, ARTIFACTS_CAP), total: unique.length }
}
