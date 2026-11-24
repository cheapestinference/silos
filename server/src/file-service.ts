// File viewer/editor: serves ANY absolute path an AUTHENTICATED request
// asks for — the same trust boundary the PTY terminal (node-pty) already
// has, which gives full filesystem read/write as the user. The REAL access
// control is auth (local = no auth by design; remote/cloudflared = login),
// not a per-session allowlist: restricting the viewer to paths "touched by
// the session" wouldn't add security against a terminal that already
// reaches everything, only inconsistency.
//
// What this class IS responsible for (hygiene, not access control):
//   - requiring an ABSOLUTE path (normalizes . and .. safely; never crashes),
//   - honest errors (404 missing, 413 over the inline cap),
//   - an inline-view cap (~2 MB for text/markdown → download only beyond that),
//   - NEVER dumping a file's bytes to logs (the caller streams, never logs),
//   - writes with the SAME discipline as memory-service: backup BEFORE
//     overwriting (never overwrites an existing backup) + atomic
//     tmp+rename, so the original is never left half-written. Writing is
//     limited to text/markdown: that's anti-corruption hygiene (a text PUT
//     over a PDF would destroy it), not an access barrier.
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

// Inline-view cap for text/markdown (RENDERED/EDITED in the browser): above
// this, the viewer offers download only. Images and PDFs are always served
// by stream (never materialized in JS), so this cap doesn't apply to them.
export const INLINE_CAP = 2 * 1024 * 1024 // 2 MB

export type FileKind = 'markdown' | 'pdf' | 'image' | 'text' | 'binary'

export interface FileMeta {
  path: string // the resolved REAL path (realpath) — what the caller streams
  name: string
  ext: string
  kind: FileKind
  mime: string
  size: number
  // true only for text/markdown above the inline cap: no view, download
  // only. Images/PDF/binary never set it (they're viewed/streamed as a blob).
  tooLarge: boolean
  editable: boolean // text/markdown under the cap → view/edit toggle + save
}

// An error with an HTTP code so the router can translate it without guessing from the text.
export class FileError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'FileError'
  }
}

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx'])

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
}

// Recognized text/code extensions — a highlighted view (read-only, except
// markdown which is also editable). A pragmatic, non-exhaustive list:
// whatever doesn't fall here or in image/pdf/markdown is treated as binary
// (download only).
const TEXT_EXT = new Set([
  '.txt',
  '.text',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.ndjson',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.cfg',
  '.conf',
  '.properties',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.swift',
  '.m',
  '.mm',
  '.php',
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.jl',
  '.dart',
  '.scala',
  '.clj',
  '.ex',
  '.exs',
  '.erl',
  '.hs',
  '.elm',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.dockerfile',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.vue',
  '.svelte',
  '.astro',
])

// Extension → kind + mime. .svg falls under image (viewed as an image); it
// is never declared as executable text for serving.
export function classifyFile(rawExt: string): { kind: FileKind; mime: string } {
  const ext = rawExt.toLowerCase()
  if (MARKDOWN_EXT.has(ext)) return { kind: 'markdown', mime: 'text/plain; charset=utf-8' }
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf' }
  if (IMAGE_MIME[ext]) return { kind: 'image', mime: IMAGE_MIME[ext]! }
  if (TEXT_EXT.has(ext)) return { kind: 'text', mime: 'text/plain; charset=utf-8' }
  return { kind: 'binary', mime: 'application/octet-stream' }
}

// An entry in a directory listing for the explorer.
export interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: number
}

export class FileService {
  constructor(private dataDir: string) {}

  // Lists a folder for the explorer — same model as meta/read: serves ANY
  // absolute path to an authenticated request (auth IS the boundary, like
  // the PTY terminal). Folders first, then files, alphabetically. Broken
  // entries (dead symlink, permission) are skipped, they don't break the listing.
  listDir(rawPath: string): { path: string; entries: DirEntry[] } {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new FileError('path required', 400)
    if (!isAbsolute(rawPath)) throw new FileError('an absolute path is required', 400)
    let real: string
    try {
      real = realpathSync(resolve(rawPath))
    } catch {
      throw new FileError('folder not found', 404)
    }
    let st
    try {
      st = statSync(real)
    } catch {
      throw new FileError('folder not found', 404)
    }
    if (!st.isDirectory()) throw new FileError('not a folder', 400)
    const entries: DirEntry[] = []
    for (const name of readdirSync(real)) {
      let s
      try {
        s = statSync(join(real, name)) // follows symlinks; skips broken entries
      } catch {
        continue
      }
      entries.push({ name, type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs })
    }
    entries.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
    return { path: real, entries }
  }

  // Resolves an absolute path to its realpath, requiring it to be an
  // existing regular file. NO allowlist: auth is already the boundary. The
  // only thing rejected is what makes no sense (relative/empty path) or
  // doesn't exist.
  private resolveFile(rawPath: string): string {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new FileError('path required', 400)
    if (!isAbsolute(rawPath)) throw new FileError('an absolute path is required', 400)
    const abs = resolve(rawPath) // deterministically normalizes . and ..
    let real: string
    try {
      real = realpathSync(abs) // follows symlinks — not a barrier, just an honest resolution
    } catch {
      throw new FileError('file not found', 404)
    }
    let st
    try {
      st = statSync(real)
    } catch {
      throw new FileError('file not found', 404)
    }
    if (!st.isFile()) throw new FileError('not a file', 404)
    return real
  }

  // Metadata for the viewer to decide how to render (never reads the bytes).
  meta(rawPath: string): FileMeta {
    const real = this.resolveFile(rawPath)
    const st = statSync(real)
    const ext = extname(real).toLowerCase()
    const { kind, mime } = classifyFile(ext)
    const isText = kind === 'markdown' || kind === 'text'
    const tooLarge = isText && st.size > INLINE_CAP
    return {
      path: real,
      name: basename(real),
      ext,
      kind,
      mime,
      size: st.size,
      tooLarge,
      editable: (kind === 'markdown' || kind === 'text') && !tooLarge,
    }
  }

  // Path + stream to serve bytes. `download` ignores the inline cap
  // (downloading a large file is legitimate) and forces the download
  // content-type in the caller. Without download, text/markdown above the
  // cap is rejected (413): that view materializes in the browser and must
  // not blow it up.
  openForServe(rawPath: string, download: boolean): { meta: FileMeta; stream: ReturnType<typeof createReadStream> } {
    const meta = this.meta(rawPath)
    if (!download && meta.tooLarge) {
      throw new FileError('file too large for inline view — use download', 413)
    }
    return { meta, stream: createReadStream(meta.path) }
  }

  // Write with memory-service discipline: backup BEFORE + atomic
  // tmp+rename. Text/markdown only (anti-corruption hygiene). The file
  // must already exist (the viewer opened it) — new files aren't created
  // through here.
  write(rawPath: string, content: string): { backup: string | null } {
    if (typeof content !== 'string') throw new FileError('content required', 400)
    const real = this.resolveFile(rawPath)
    const ext = extname(real).toLowerCase()
    const { kind } = classifyFile(ext)
    if (kind !== 'markdown' && kind !== 'text') {
      throw new FileError('only text or markdown files can be saved', 400)
    }
    if (Buffer.byteLength(content, 'utf8') > INLINE_CAP) {
      throw new FileError('content exceeds the save cap', 413)
    }
    const backup = this.backupBeforeWrite(real)
    const tmp = join(dirname(real), `.${basename(real)}.tmp-${randomBytes(4).toString('hex')}`)
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, real) // atomic: the original is never left half-written
    return { backup }
  }

  // Backup BEFORE overwriting — never overwrites an existing backup
  // (numeric suffix if the timestamp collides, same as memory-service). The
  // segment is a hash of the source directory: a safe, stable folder name.
  private backupBeforeWrite(real: string): string {
    const seg = createHash('sha1').update(dirname(real)).digest('hex').slice(0, 16)
    const dir = join(this.dataDir, 'file-backups', seg)
    mkdirSync(dir, { recursive: true })
    const base = basename(real)
    const stamp = new Date().toISOString().replace(/:/g, '-')
    let dest = join(dir, `${base}.${stamp}`)
    let n = 1
    while (existsSync(dest)) {
      dest = join(dir, `${base}.${stamp}-${n}`)
      n += 1
    }
    copyFileSync(real, dest)
    return dest
  }

  // Direct read into a string (tests/internal use only — the real path is
  // openForServe via stream). Applies the same inline cap.
  readText(rawPath: string): string {
    const meta = this.meta(rawPath)
    if (meta.tooLarge) throw new FileError('file too large for inline view', 413)
    return readFileSync(meta.path, 'utf8')
  }
}
