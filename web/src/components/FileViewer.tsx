// FileViewer.tsx — a file viewer/editor. Opens when clicking a path in the
// Files block. One modal per file: markdown (view↔edit with saving), an
// embedded PDF, an image, text/code with highlighting (the same pipeline
// as the transcript), and a download for everything else. Bytes are
// requested via fetch+header (the token never travels in an <img>/
// <embed>'s URL) and served via objectURL, revoked on close.
//
// The Esc contract (same as MediaScope/AgentModal): preventDefault +
// close, so Chat.tsx's global handler (gated on defaultPrevented) doesn't
// cancel a turn in progress just from closing the viewer. With unsaved
// changes, Esc and clicking the background ask for confirmation before discarding.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Copy, Download, FolderOpen, Loader2, Pencil, Eye, X } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../store'
import { Markdown } from './Turn'
import { PlanView } from './PlanView'
import { isPlanFile } from '../lib/team-plan'
import { handoffOf, loadPlan, unreadTasksOf, type LoadedPlan } from '../lib/plan-record'
import { planTaskDone } from '../lib/task-gesture'
import { planDoor } from '../lib/tasks'
import { handoffWords } from '../lib/home'
import { fileErrorWords } from '../lib/file-refs'
import type { FileMeta } from '../lib/types'

// extension → language for the code block's hint (rehype-highlight
// auto-detects with no hint; this just refines it). Not exhaustive on purpose.
const LANG: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.json': 'json',
  '.jsonl': 'json',
  '.ndjson': 'json',
  '.html': 'xml',
  '.htm': 'xml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.vue': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'scss',
  '.less': 'less',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.php': 'php',
  '.lua': 'lua',
  '.r': 'r',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.fish': 'bash',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.env': 'bash',
  '.dockerfile': 'dockerfile',
}

// wraps the content in a code fence long enough not to break if the
// content itself contains backticks.
function asCodeBlock(content: string, ext: string): string {
  let maxRun = 0
  for (const m of content.matchAll(/`+/g)) maxRun = Math.max(maxRun, m[0].length)
  const fence = '`'.repeat(Math.max(3, maxRun + 1))
  const lang = LANG[ext] ?? ''
  return `${fence}${lang}\n${content}\n${fence}`
}

function KindBadge({ kind }: { kind: FileMeta['kind'] }) {
  return (
    <span className="shrink-0 rounded-full border border-line px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-ink-2 max-sm:hidden">{kind}</span>
  )
}

function downloadFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // revokes on the next tick: gives the browser time to start the download
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// the folder a path lives in, home folded to ~
function folderOf(path: string): string {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '/'
  return dir.replace(/^\/home\/[^/]+(?=\/|$)/, '~')
}

// `inline` renders the same viewer/editor WITHOUT the modal shell (portal,
// scrim, scroll-lock, focus-trap) — for the Files mode, where it fills the main
// area instead of floating over the app.
// `onDirty` (optional): reports whether an edit is unsaved — a host that
// can close the viewer by its own means (the Knows Drawer's Esc / ✕ /
// click outside) asks before dropping it. Reported false on unmount.
// `onClose` absent (inline only): the viewer IS the pane's content, nothing to close back to — no ✕
export function FileViewer({
  path,
  onClose,
  inline = false,
  onDirty,
}: {
  path: string
  onClose?: () => void
  inline?: boolean
  onDirty?: (dirty: boolean) => void
}) {
  const [meta, setMeta] = useState<FileMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null) // markdown/code
  const [blobUrl, setBlobUrl] = useState<string | null>(null) // image/pdf
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // a plan file as the plans silo reads it (lib/plan-record.ts) — null: not
  // a plan the silo reads, and the text shows as it is
  const [plan, setPlan] = useState<LoadedPlan | null>(null)
  const agents = useStore((s) => s.agents)
  const dirty = editing && draft !== (text ?? '')
  const windowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    onDirty?.(dirty)
  }, [dirty, onDirty])
  useEffect(() => () => onDirty?.(false), [onDirty])

  // load: metadata → depending on kind, text or blob. Cancels on unmount/change.
  useEffect(() => {
    let cancelled = false
    let localUrl: string | null = null
    setMeta(null)
    setError(null)
    setText(null)
    setBlobUrl(null)
    setEditing(false)
    setNotice(null)
    setPlan(null)
    api.file
      .meta(path)
      .then(async (m) => {
        if (cancelled) return
        setMeta(m)
        if (m.tooLarge || m.kind === 'binary') return // download only
        if (m.kind === 'markdown' || m.kind === 'text') {
          const [t, p] = await Promise.all([api.file.text(path), isPlanFile(m.name) ? loadPlan(path).catch(() => null) : Promise.resolve(null)])
          if (!cancelled) {
            setText(t)
            setDraft(t)
            setPlan(p)
          }
        } else {
          const b = await api.file.blob(path)
          if (cancelled) return
          localUrl = URL.createObjectURL(b)
          setBlobUrl(localUrl)
        }
      })
      .catch((e: unknown) => {
        // in the owner's words: a server's message or code never paints here
        if (!cancelled) setError(fileErrorWords(e))
      })
    return () => {
      cancelled = true
      if (localUrl) URL.revokeObjectURL(localUrl)
    }
  }, [path])

  const close = (): void => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    onClose?.()
  }

  // Esc closes (contract: preventDefault so it doesn't cancel the turn in progress).
  // Inline (Files mode) has no modal to dismiss, so it doesn't grab Esc.
  useEffect(() => {
    if (inline) return
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // close depends on dirty/text/draft; recreates the handler when they change
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close is listed through what it reads
  }, [dirty, text, draft, inline])

  // a root-level modal: locks the body's scroll behind the scrim and traps
  // focus inside the window while it's open (restored on close). Skipped inline.
  useEffect(() => {
    if (inline) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const previouslyFocused = document.activeElement as HTMLElement | null
    // focuses the window on open (initial focus inside the modal)
    windowRef.current?.focus()

    function trapTab(e: globalThis.KeyboardEvent): void {
      if (e.key !== 'Tab') return
      const cont = windowRef.current
      if (!cont) return
      const focusables = cont.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) {
        e.preventDefault()
        cont.focus()
        return
      }
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || active === cont) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', trapTab)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', trapTab)
      previouslyFocused?.focus?.()
    }
  }, [inline])

  const save = async (): Promise<void> => {
    if (!meta) return
    setSaving(true)
    setNotice(null)
    try {
      await api.file.write(path, draft)
      setText(draft)
      setEditing(false)
      setNotice('Saved')
      if (meta && isPlanFile(meta.name)) setPlan(await loadPlan(path).catch(() => null))
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  // Team plans: "Done" on a task is the owner's Done (lib/task-gesture.ts
  // planTaskDone — ONE write, judged on the state the plan view painted; a
  // plan outside Silos' projects is refused before anything is sent). The
  // plan and the raw text are re-read; the notice says who the Done
  // unblocked, in Home's words.
  const markPlanDone = async (id: string): Promise<void> => {
    if (!plan) return
    try {
      const h = handoffOf((await planTaskDone(plan, id)).nowReady ?? [], (a) => agents.find((x) => x.id === a)?.name ?? a)
      const [t, p] = await Promise.all([api.file.text(path), loadPlan(path).catch(() => null)])
      setText(t)
      setDraft(t)
      setPlan(p)
      setNotice(
        handoffWords(h)
          .map((x) => x.text)
          .join(' ') || 'Saved',
      )
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not save')
    }
  }

  const handleCopy = async (): Promise<void> => {
    // copies the current content — the live draft while editing, else the saved text.
    const content = editing ? draft : (text ?? '')
    try {
      await navigator.clipboard.writeText(content)
      setNotice('Copied')
    } catch {
      setNotice('Could not copy')
    }
  }

  const handleDownload = async (): Promise<void> => {
    if (!meta) return
    try {
      const b = await api.file.blob(path, true)
      downloadFile(meta.name, b)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not download')
    }
  }

  // a root-level modal: PORTALED to document.body so nothing in the tree
  // (the context column, the terminal panel, dropdowns) can clip it, and
  // it sits above everything (z-[100] > other modals'/the lightbox's
  // z-50). The scrim covers the WHOLE app. Clicking the background or Esc
  // close it; ✕ in the bar too.
  const windowEl = (
    <div
      ref={windowRef}
      role={inline ? undefined : 'dialog'}
      aria-modal={inline ? undefined : 'true'}
      aria-label={`File · ${meta?.name ?? path}`}
      tabIndex={-1}
      className={
        inline
          ? 'flex h-full min-h-0 flex-col overflow-hidden bg-canvas outline-none'
          : 'modal-pop flex max-h-[85vh] w-[min(900px,92vw)] flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-2xl outline-none'
      }
    >
      {/* header — on a phone the actions keep their icons and drop their
            words (the page headers' rule: AgentPage / AutomationsPage), so the
            name truncates and every action stays on screen */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5 max-sm:px-3">
        {meta ? <KindBadge kind={meta.kind} /> : null}
        <span className="flex min-w-0 flex-1 flex-col" title={path}>
          <span className="truncate font-mono text-xs text-ink">{meta?.name ?? path.split('/').pop()}</span>
          {/* over a page (the sheet), where the file lives — the page you
                came from stays right behind; Files is a door, never a fall */}
          {inline ? null : (
            <span data-testid="file-sheet-folder" className="truncate font-mono text-[11px] text-ink-3">
              {folderOf(path)}
            </span>
          )}
        </span>
        {notice ? <span className="shrink-0 text-[11px] text-ink-2">{notice}</span> : null}
        {/* view↔edit: only markdown is editable */}
        {meta?.editable ? (
          editing ? (
            <>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || draft === text}
                className="shrink-0 rounded-full border border-terracotta/40 bg-terracotta-soft px-2.5 py-1 text-xs font-medium text-terracotta hover:border-terracotta disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                aria-label="View"
                title="View"
                onClick={() => {
                  if (!dirty || window.confirm('Discard unsaved changes?')) {
                    setDraft(text ?? '')
                    setEditing(false)
                  }
                }}
                className="shrink-0 inline-flex items-center gap-1 rounded-full border border-line px-2 py-1 text-xs text-ink-2 hover:border-ink-2 hover:text-ink"
              >
                <Eye size={12} aria-hidden="true" />
                <span className="max-sm:hidden">View</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label="Edit"
              title="Edit"
              onClick={() => {
                setDraft(text ?? '')
                setEditing(true)
              }}
              className="shrink-0 inline-flex items-center gap-1 rounded-full border border-line px-2 py-1 text-xs text-ink-2 hover:border-terracotta hover:text-terracotta"
            >
              <Pencil size={12} aria-hidden="true" />
              <span className="max-sm:hidden">Edit</span>
            </button>
          )
        ) : null}
        {/* edit-by-chat: hand the file to the agent that owns its folder
              (or the inbox scoped to the folder) and open a fresh chat. Only
              in Files mode — the modal viewer opens from other contexts where
              navigating to a chat would be jarring. */}
        {inline ? (
          <button
            type="button"
            aria-label="Edit with an agent"
            title="Open a chat with the agent for this folder to edit the file by conversation"
            onClick={() => useStore.getState().askAgentAboutFile(path)}
            className="shrink-0 inline-flex items-center gap-1 rounded-full border border-line px-2 py-1 text-xs text-ink-2 hover:border-terracotta hover:text-terracotta"
          >
            <Bot size={12} aria-hidden="true" />
            <span className="max-sm:hidden">Ask agent</span>
          </button>
        ) : null}
        {text !== null ? (
          <button
            type="button"
            aria-label="Copy file contents"
            title="Copy"
            onClick={() => void handleCopy()}
            className="shrink-0 inline-flex items-center gap-1 rounded-full border border-line px-2 py-1 text-xs text-ink-2 hover:border-terracotta hover:text-terracotta"
          >
            <Copy size={12} aria-hidden="true" />
            <span className="max-sm:hidden">Copy</span>
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Download file"
          title="Download"
          onClick={() => void handleDownload()}
          className="shrink-0 inline-flex items-center gap-1 rounded-full border border-line px-2 py-1 text-xs text-ink-2 hover:border-terracotta hover:text-terracotta"
        >
          <Download size={12} aria-hidden="true" />
          <span className="max-sm:hidden">Download</span>
        </button>
        {inline ? null : (
          <button
            type="button"
            data-testid="open-in-files"
            aria-label="Open in Files"
            title="Open the file explorer on this file's folder — leaves the page you are on"
            onClick={() => useStore.getState().changePage({ kind: 'files', path })}
            className="shrink-0 inline-flex items-center gap-1 rounded-full border border-line px-2 py-1 text-xs text-ink-2 hover:border-terracotta hover:text-terracotta"
          >
            <FolderOpen size={12} aria-hidden="true" />
            <span className="max-sm:hidden">Open in Files</span>
          </button>
        )}
        {onClose ? (
          <button
            type="button"
            aria-label="Close file viewer"
            onClick={close}
            className="shrink-0 rounded-full p-1 text-ink-2 hover:bg-panel hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
          >
            <X size={16} />
          </button>
        ) : null}
      </header>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-auto">
        <Body
          meta={meta}
          error={error}
          text={text}
          blobUrl={blobUrl}
          editing={editing}
          draft={draft}
          onDraft={setDraft}
          onDownload={() => void handleDownload()}
          plan={plan}
          onPlanMarkDone={(id) => void markPlanDone(id)}
        />
      </div>
    </div>
  )
  if (inline) return windowEl
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/60 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      {windowEl}
    </div>,
    document.body,
  )
}

function Loading() {
  return (
    <div className="flex items-center justify-center gap-2 p-10 text-sm text-ink-2">
      <Loader2 size={16} className="animate-spin" /> Loading…
    </div>
  )
}

function DownloadOnly({ meta, onDownload, reason }: { meta: FileMeta; onDownload: () => void; reason: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <p className="text-sm text-ink-2">{reason}</p>
      <button
        type="button"
        onClick={onDownload}
        className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm text-ink hover:border-terracotta hover:text-terracotta"
      >
        <Download size={14} /> Download {meta.name}
      </button>
    </div>
  )
}

function Body({
  meta,
  error,
  text,
  blobUrl,
  editing,
  draft,
  onDraft,
  onDownload,
  plan,
  onPlanMarkDone,
}: {
  meta: FileMeta | null
  error: string | null
  text: string | null
  blobUrl: string | null
  editing: boolean
  draft: string
  onDraft: (v: string) => void
  onDownload: () => void
  plan?: LoadedPlan | null
  onPlanMarkDone?: (id: string) => void
}) {
  if (error) return <p className="p-6 text-sm text-ink-2">{error}</p>
  if (!meta) return <Loading />

  if (meta.tooLarge) {
    return <DownloadOnly meta={meta} onDownload={onDownload} reason={`This file is too large to preview inline (${Math.round(meta.size / 1024)} KB).`} />
  }

  if (meta.kind === 'binary') {
    return <DownloadOnly meta={meta} onDownload={onDownload} reason="No preview available for this file type." />
  }

  if (meta.kind === 'image') {
    return blobUrl ? (
      <div className="flex items-center justify-center bg-panel p-4">
        <img src={blobUrl} alt={meta.name} className="max-h-[72vh] max-w-full rounded object-contain" />
      </div>
    ) : (
      <Loading />
    )
  }

  if (meta.kind === 'pdf') {
    return blobUrl ? <embed src={blobUrl} type="application/pdf" title={meta.name} className="h-[72vh] w-full" /> : <Loading />
  }

  // markdown / text
  if (text === null) return <Loading />

  if (editing) {
    return (
      <textarea
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        spellCheck={false}
        className="h-[72vh] w-full resize-none bg-canvas px-4 py-3 font-mono text-[13px] leading-relaxed text-ink outline-none"
      />
    )
  }

  // team plans (plans/*.plan.json): render the shared plan, as the plans
  // silo reads it, instead of raw JSON — Edit still opens the raw file. A
  // plan the silo does not read falls through to the code view: honesty
  // over a broken render. One read outside Silos' projects, or closed, is drawn
  // read-only and says so.
  if (isPlanFile(meta.name) && plan) {
    const door = planDoor({ key: plan.key, file: meta.path, outside: plan.outside, closed: plan.closed })
    // tasks the file holds that the reader can't build: the plan below leaves
    // them out, and this file is where they are fixed (Edit) — said here, the
    // landing of «N tasks in <plan> can't be read»'s door
    const unread = unreadTasksOf(plan.remarks, text)
    // read only: outside Silos' projects, or closed (its project's own, finished)
    const readOnly = plan.outside || plan.closed
    return (
      <>
        {plan.closed ? (
          <p data-testid="plan-closed" className="px-5 pt-3 font-mono text-[11px] text-ink-3">
            closed · read only
          </p>
        ) : plan.outside ? (
          <p data-testid="plan-outside" className="px-5 pt-3 font-mono text-[11px] text-ink-3">
            outside Silos' projects · read only
          </p>
        ) : null}
        {unread.length > 0 ? (
          <div
            data-testid="plan-unread"
            className="mx-5 mt-3 rounded-md border border-[color-mix(in_srgb,var(--health-amber)_40%,transparent)] px-3 py-2 text-[12.5px] leading-relaxed text-ink-2"
          >
            <p className="text-ink">
              {unread.length === 1 ? "1 task in this file can't be read" : `${unread.length} tasks in this file can't be read`} — the plan below leaves{' '}
              {unread.length === 1 ? 'it' : 'them'} out. Edit the file to fix {unread.length === 1 ? 'it' : 'them'}.
            </p>
            <ul className="mt-1">
              {unread.map((u, i) => (
                <li key={i}>
                  <span className="font-mono text-[11.5px] text-ink">{u.id ?? `task ${i + 1}`}</span> — {u.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <PlanView
          plan={plan.plan}
          planPath={meta.path}
          planKey={readOnly ? undefined : plan.key}
          onMarkDone={readOnly ? undefined : onPlanMarkDone}
          onOpenTask={readOnly ? undefined : (id) => useStore.getState().changePage({ kind: 'task', plan: plan.key, task: id })}
          // the plan's name opens its house (Tasks narrowed to it — B4); the sheet closes on the way
          onOpenPlan={
            door?.kind === 'house'
              ? () => {
                  useStore.getState().setViewingFile(null)
                  useStore.getState().changePage(door.page)
                }
              : undefined
          }
        />
      </>
    )
  }

  if (meta.kind === 'markdown') {
    return (
      <div className="px-5 py-4">
        <Markdown text={text} />
      </div>
    )
  }

  // text/code: the same highlighting pipeline as the transcript
  return (
    <div className="px-4 py-3 text-[13px]">
      <Markdown text={asCodeBlock(text, meta.ext)} />
    </div>
  )
}
