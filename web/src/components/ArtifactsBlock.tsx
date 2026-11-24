// ArtifactsBlock.tsx — the Files tab's two parts, the same on the agent page
// and the project page: Files · Artifacts, each an address
// (…/files/artifacts — a reload keeps it), the folder's door «Browse the
// folder ›» beside them, and the Artifacts list in the same box on both.
// An artifact is the protagonist of its row (title + relative time, click =
// open the URL in a new tab) and the conversation that produced it a
// secondary affordance (a `#` glyph, click = open that conversation). Only
// real, parsed data (a frame-link → ContextAccumulator): with no
// artifacts, "No artifacts yet" — nothing is ever fabricated. The pane has
// no heading of its own: the part it sits under already names it.
import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { relTime } from '../lib/rel-time'
import { SubNav } from './SubNav'
import type { ArtifactItem } from '../lib/types'

// the two parts and the folder's door, one row — `count` is the Files
// part's figure when it is known
export function FilesParts({ count, folder, browseLabel = 'Browse the folder' }: { count?: number | null; folder: string | null; browseLabel?: string }) {
  const part = useStore((s) => s.filesPart)
  const setFilesPart = useStore((s) => s.setFilesPart)
  const changePage = useStore((s) => s.changePage)
  const items: ['files' | 'artifacts', ReactNode][] = [
    ['files', <>Files{count !== undefined && count !== null ? <span className="font-mono text-[10.5px] text-ink-3">{count}</span> : null}</>],
    ['artifacts', 'Artifacts'],
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <SubNav label="Files" value={part} onChange={setFilesPart} items={items} />
      {folder ? (
        <button
          type="button"
          onClick={() => changePage({ kind: 'files', folder })}
          title={folder}
          className="ml-auto text-[12px] text-ink-2 hover:text-terracotta"
        >
          {browseLabel} ›
        </button>
      ) : null}
    </div>
  )
}

export function ArtifactsBlock({ agentId, folder }: { agentId?: string; folder?: string }) {
  const openSession = useStore((s) => s.openSession)
  const selectAgent = useStore((s) => s.selectAgent)
  const nowTick = useStore((s) => s.nowTick)
  const [data, setData] = useState<{ artifacts: ArtifactItem[]; total: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    const scope = { ...(agentId !== undefined ? { agent: agentId } : {}), ...(folder !== undefined ? { folder } : {}) }
    // Promise.resolve(...): the same defensive pattern as AccountFooter/
    // ProviderFields — tests' automock returns undefined; a failed fetch
    // leaves the block in an honest empty state instead of breaking the whole tab.
    Promise.resolve(api.artifacts(scope))
      .then((r) => {
        if (!cancelled) setData(r ?? { artifacts: [], total: 0 })
      })
      .catch(() => {
        if (!cancelled) setData({ artifacts: [], total: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [agentId, folder])

  function openConversation(a: ArtifactItem): void {
    // sessionKey = "folder/id" — the munged folder never contains '/'.
    const slash = a.sessionKey.indexOf('/')
    if (slash <= 0) return
    selectAgent(a.agentId)
    void openSession(a.sessionKey.slice(0, slash), a.sessionKey.slice(slash + 1))
  }

  return (
    <section aria-label="Artifacts" className="rounded-lg border border-line bg-panel px-2 py-2">
      {data === null ? (
        <p className="px-2 py-1 text-xs text-ink-3">Reading…</p>
      ) : data.artifacts.length === 0 ? (
        <p className="px-2 py-1 text-xs text-ink-2">No artifacts yet</p>
      ) : (
        <>
          <ul role="list" className="space-y-0.5">
            {data.artifacts.map((a) => {
              const ms = Date.parse(a.ts)
              return (
                <li key={`${a.sessionKey}:${a.url}`} className="group rounded-lg px-2 py-1.5 hover:bg-canvas">
                  {/* the URL arrives ALREADY filtered by the server (an https
                      allowlist in artifacts-aggregate.ts) — this <a> only
                      paints entries from that response; noopener is explicit belt-and-suspenders. */}
                  <a href={a.url} target="_blank" rel="noopener noreferrer" title={a.path} className="flex w-full items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm text-ink group-hover:text-terracotta">{a.title}</span>
                      <ExternalLink
                        size={11}
                        aria-hidden="true"
                        className="shrink-0 text-ink-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                      />
                    </span>
                    {Number.isFinite(ms) && ms > 0 ? <span className="shrink-0 font-mono text-[10.5px] text-ink-3">{relTime(ms, nowTick)}</span> : null}
                  </a>
                  <button
                    type="button"
                    onClick={() => openConversation(a)}
                    title="Open the conversation that produced it"
                    className="mt-0.5 flex max-w-full items-baseline gap-1 truncate text-xs text-ink-2 hover:text-ink"
                  >
                    <span aria-hidden="true">#</span>
                    <span className="truncate">{a.sessionTitle}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {data.artifacts.length < data.total ? (
            <p className="px-2 pt-1.5 font-mono text-[10.5px] text-ink-3">
              the latest {data.artifacts.length} of {data.total}
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}
