// terminal-file-links.ts — in the real console, a path the TUI prints
// (`web/src/App.tsx:12`, `/home/…/report.md`) becomes a link once the file
// service confirms it is a file: underlined on hover, a click opens the file
// viewer (lib/file-refs.ts). Relative paths resolve against the
// conversation's cwd. The console's text is never rewritten.
import type { IDisposable, ILink, Terminal } from '@xterm/xterm'
import { cachedFile, ensureFiles, findPaths, openFileViewer, resolvePath } from './file-refs'
import { lineText } from './terminal-conversation-links'

export function registerFileLinks(term: Terminal, cwd: () => string | null | undefined): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const read = lineText(term, bufferLineNumber - 1)
      const base = cwd()
      const found = read
        ? findPaths(read.text)
            .map((f) => ({ ...f, abs: resolvePath(f.path, base) }))
            .filter((f) => f.abs !== null)
        : []
      if (!read || found.length === 0) {
        callback(undefined)
        return
      }
      void ensureFiles(found.map((f) => f.abs!)).then(() => {
        const links: ILink[] = []
        for (const f of found) {
          const file = cachedFile(f.abs!)
          if (!file) continue
          const start = read.cellOf[f.index]
          const end = read.cellOf[f.index + f.token.length - 1]
          if (start === undefined || end === undefined) continue
          links.push({
            range: { start: { x: start + 1, y: bufferLineNumber }, end: { x: end + 1, y: bufferLineNumber } },
            text: f.token,
            decorations: { underline: true, pointerCursor: true },
            activate: () => openFileViewer(file.path),
          })
        }
        callback(links.length > 0 ? links : undefined)
      })
    },
  })
}
