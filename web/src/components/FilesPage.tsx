// FilesPage.tsx — System › Files. The page carries its OWN explorer column
// (a second bar beside the sidebar, which stays as it is) and,
// at its right, the selected file inline in the viewer/editor (FileViewer:
// markdown edit/save, images/pdf, download for any extension). No file yet →
// an empty «pick a file» pane. A `folder` (a project's «Browse the folder ›»)
// roots the explorer there. On a phone the two never share the screen: the
// explorer until a file is open, then the file (its ✕ brings the explorer).
import { FilesIcon } from '../lib/icons'
import { useStore } from '../store'
import { FileExplorer } from './FileExplorer'
import { FileViewer } from './FileViewer'
import { PageHeader } from './PageHeader'
import { SystemTabs } from './SystemTabs'
import { goBackTo } from '../lib/router'

export function FilesPage() {
  const page = useStore((s) => s.page)
  const home = useStore((s) => s.home)
  const changePage = useStore((s) => s.changePage)
  const path = page?.kind === 'files' ? page.path : undefined
  const folder = page?.kind === 'files' ? page.folder : undefined
  const root = folder ?? home
  // ✕ is a «back» to the bare explorer: Back when it is below, else it
  // replaces — opening a file is a stop, closing one never stacks
  const bare = folder ? `/files?folder=${encodeURIComponent(folder)}` : '/files'
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <PageHeader
        testId="files-header"
        title="System"
        tabs={<SystemTabs />}
        facts={
          folder ? (
            <span className="min-w-0 truncate font-mono text-[12px]" title={folder}>
              {folder}
            </span>
          ) : (
            <span className="min-w-0 truncate">The folders your agents work in, read and edited in place</span>
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="File explorer"
          data-testid="files-explorer"
          className={`${path ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-line bg-panel/40 md:w-64 lg:w-72`}
        >
          {root ? <FileExplorer root={root} selected={path} onOpenFile={(p) => changePage({ kind: 'files', ...(folder ? { folder } : {}), path: p })} /> : null}
        </aside>
        <div className={`${path ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          {path ? (
            <FileViewer
              key={path}
              path={path}
              inline
              onClose={() => goBackTo(bare, () => changePage(folder ? { kind: 'files', folder } : { kind: 'files' }))}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-ink-2">
              <FilesIcon size={28} className="text-ink-3" />
              <p className="text-sm">Pick a file from the explorer to view or edit it.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
