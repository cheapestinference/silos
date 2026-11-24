// FileRefLink.tsx — a path written in a message, opening the file viewer in
// one click once the file service confirms it is a file
// (lib/file-refs.ts). Not a file (or not yet known) → the text as written
// (in code style when it came as code). Relative paths resolve against the
// open conversation's cwd.
import type { ReactNode } from 'react'
import { openFileViewer, pathOfToken, resolvePath, useFileRef } from '../lib/file-refs'
import { useStore } from '../store'

const CODE = 'break-words rounded bg-panel px-1 font-mono text-[0.9em]'

// `fallback`: what shows when it is not a file (a markdown link keeps being the link it was)
export function FileRefLink({
  token,
  code = false,
  children,
  fallback,
}: {
  token: string
  code?: boolean
  children?: ReactNode
  fallback?: ReactNode
}): ReactNode {
  const cwd = useStore((s) => s.detail?.meta.cwd ?? null)
  const path = pathOfToken(token)
  const abs = path ? resolvePath(path, cwd) : null
  const file = useFileRef(abs)
  const label = children ?? token
  if (!file && fallback !== undefined) return fallback
  if (!file) return code ? <code className={CODE}>{label}</code> : <>{label}</>
  return (
    <button
      type="button"
      data-testid="file-ref"
      title={`Open ${file.path}`}
      onClick={(e) => {
        e.preventDefault()
        openFileViewer(file.path)
      }}
      className={`inline rounded-sm text-left underline decoration-ink-3/60 decoration-1 underline-offset-[3px] hover:text-terracotta hover:decoration-terracotta focus-visible:outline-2 focus-visible:outline-terracotta ${code ? CODE : 'text-ink'}`}
    >
      {label}
    </button>
  )
}
