// FileViewerHost.tsx — the ONE viewer every file link in Silos opens, mounted
// once in App: a file is a sheet over the page you are in,
// never a change of place. Its state is State.viewingFile, riding the URL as
// ?file=<path> (lib/router.ts) — Back closes it, a reload keeps it.
import type { ReactNode } from 'react'
import { useStore } from '../store'
import { closeFileSheet } from '../lib/router'
import { FileViewer } from './FileViewer'

export function FileViewerHost(): ReactNode {
  const path = useStore((s) => s.viewingFile)
  return path ? <FileViewer key={path} path={path} onClose={closeFileSheet} /> : null
}
