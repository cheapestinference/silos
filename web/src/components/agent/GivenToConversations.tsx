// GivenToConversations.tsx — the agent page's Files tab, «Given to
// conversations»: ONE folded line under
// the agent's own files, never mixed into them. Open, it lists the
// conversations the owner gave files to, by conversation — its title, or
// «No longer listed» for threads whose conversations are gone (their files
// stay: they are the owner's). A conversation's files are read when it is
// opened; each opens the viewer. Absent when no conversation holds any.
import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import { relTime } from '../../lib/rel-time'
import type { AgentView, ContextFile, GivenThread } from '../../lib/types'

function ThreadFiles({ agentId, thread, onOpenFile }: { agentId: string; thread: string; onOpenFile: (path: string) => void }) {
  const version = useStore((s) => s.knowsVersion.context)
  const [files, setFiles] = useState<ContextFile[] | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => api.context.list(agentId, thread))
      .then((v) => {
        if (!cancelled) setFiles(v?.conversation ?? [])
      })
      .catch(() => {
        if (!cancelled) setFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [agentId, thread, version])
  if (files === null) return <p className="py-1 pl-9 text-[12px] text-ink-3">Reading…</p>
  if (files.length === 0) return <p className="py-1 pl-9 text-[12px] text-ink-3">Nothing left in it.</p>
  return (
    <ul className="pb-1">
      {files.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            onClick={() => onOpenFile(f.path)}
            title={f.path}
            className="group/f flex w-full items-baseline gap-2 py-1 pl-9 pr-4 text-left hover:bg-canvas/60"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink group-hover/f:text-terracotta">{f.rel}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-ink-3">{relTime(f.mtime)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function GivenToConversations({ agent, onOpenFile }: { agent: AgentView; onOpenFile: (path: string) => void }) {
  const version = useStore((s) => s.knowsVersion.context)
  const [threads, setThreads] = useState<GivenThread[] | null>(null)
  const [open, setOpen] = useState(false)
  const [openThread, setOpenThread] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => api.context.conversations(agent.id))
      .then((v) => {
        if (!cancelled) setThreads(v ?? [])
      })
      .catch(() => {
        if (!cancelled) setThreads([])
      })
    return () => {
      cancelled = true
    }
  }, [agent.id, version])
  if (!threads || threads.length === 0) return null
  // listed conversations newest first, then the ones gone, said once
  const listed = threads.filter((t) => t.session).sort((a, b) => b.session!.mtime - a.session!.mtime)
  const gone = threads.filter((t) => !t.session)
  const row = (t: GivenThread) => (
    <li key={t.thread}>
      <button
        type="button"
        aria-expanded={openThread === t.thread}
        onClick={() => setOpenThread(openThread === t.thread ? null : t.thread)}
        className="group/t flex w-full items-baseline gap-2 px-4 py-1.5 text-left hover:bg-canvas/60"
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`shrink-0 self-center text-ink-3 transition-transform duration-150 ${openThread === t.thread ? 'rotate-90' : ''}`}
        />
        <span className={`min-w-0 flex-1 truncate text-[13px] group-hover/t:text-terracotta ${t.session ? 'text-ink' : 'text-ink-2'}`}>
          {t.session?.title || 'Untitled conversation'}
        </span>
        {t.session ? <span className="shrink-0 font-mono text-[10.5px] text-ink-3">{relTime(t.session.mtime)}</span> : null}
      </button>
      {openThread === t.thread ? <ThreadFiles agentId={agent.id} thread={t.thread} onOpenFile={onOpenFile} /> : null}
    </li>
  )
  return (
    <section className="rounded-lg border border-line bg-panel" aria-label="Given to conversations">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="group flex w-full items-baseline gap-2 px-4 py-2.5 text-left">
        <ChevronRight size={13} aria-hidden="true" className={`shrink-0 self-center text-ink-2 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        <span className="text-[13px] text-ink group-hover:text-terracotta">Given to conversations</span>
        <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{threads.length}</span>
        <span className="min-w-0 truncate text-[11px] text-ink-3">· files you gave one conversation, told to no other</span>
      </button>
      {open ? (
        <div className="border-t border-line pb-1">
          {listed.length > 0 ? <ul className="pt-1">{listed.map(row)}</ul> : null}
          {gone.length > 0 ? (
            <>
              <h4 className="flex items-baseline gap-2 px-4 pb-1 pt-3 font-mono text-[10.5px] text-ink-3">
                <span>No longer listed</span>
                <span className="tabular-nums">{gone.length}</span>
              </h4>
              <ul>{gone.map(row)}</ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
