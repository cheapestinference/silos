// safe-file.ts — the ONE way Silos reads or writes a file inside a folder it
// does not own outright: an agent's state dir above all (the agent's Bash is
// not fenced, so it can plant links there), and the record files of a silo.
// Sixth review round: containedDir/containedAgentDir answered a PATH, and the
// use that followed opened whatever sat at that path a moment later — a link
// at watch-state.json made the resident's tick overwrite another file, a link
// at status.log.jsonl made it append to one, a linked silo-drafts/ read
// another agent's draft, and a directory swapped between the check and the
// open still led wherever the agent liked.
//
// The rule, for the whole class:
//   - the directory is a VERIFIED REAL dir (contained-dir.ts gives it) and is
//     PINNED: opened once (O_DIRECTORY|O_NOFOLLOW) and every name is looked up
//     inside that very inode, then checked to still live at the verified path;
//   - the file is opened with O_NOFOLLOW (a link at the name never opens) and
//     O_NONBLOCK (a FIFO at the name never freezes the server);
//   - after the open, the fd is checked against the name: a fresh lstat of
//     <dir>/<name> is a regular file with the SAME dev+ino as the fd — so
//     whatever was swapped in between the check and the use fails here;
//   - a file with more than one hard link is refused (a hard link into
//     another agent's state is that agent's file under a second name);
//   - bytes go through the fd only. Writes: a fresh temp file created
//     O_EXCL|O_NOFOLLOW in the pinned dir, verified, written, fsync'd, then
//     renamed onto the name — and the name re-verified to be that inode
//     (fail closed). Appends: O_APPEND|O_NOFOLLOW, verified before a byte;
//   - a path already verified is never resolved again by path (seventh
//     review round): a subdir of it is reached inside the pin
//     (subdirContained), never through a fresh containedDir/realpath of it;
//   - every read names its cap and never reads past it, even when the file
//     grows after its size was checked; a log is read from its tail;
//   - no error carries a /proc/self/fd path: failures speak of the lexical
//     path (fsErr), the shapes a planted entry takes as ContainmentError.
//
// Pinning: Node has no openat, so on Linux a name inside the pinned dir is
// reached as /proc/self/fd/<dirfd>/<name> (the kernel resolves the dir fd,
// whatever happens to the path meanwhile) and the dir's place is read back
// from /proc/self/fd/<dirfd>. Without /proc the same steps run on the path
// (realpath of the dir == the dir, before and after; inode comparison of the
// name) — portable, and every check-then-use the reviewer reproduced fails,
// but a swapper fast enough to flip a directory between two of those checks
// is only closed where /proc pins the dir. (Measured: a renameat2 swap loop
// against list/setState leaked on the path-only checks; none with the pin.)
//
// Refusals are ContainmentError in plain words. Callers keep their tolerance:
// a refused read reads as missing, a refused write is a logged refusal or a
// 409 at a route — never a crash.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ContainmentError, containedAgentDir } from './contained-dir.js'

export { ContainmentError }

/** writeContained `exclusive`: the name already exists (nothing replaced). */
export class AlreadyExistsError extends ContainmentError {}

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_APPEND, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = constants

// Test seams: `afterOpen` is called right after a file is opened and before
// it is verified — where a swap by a racing agent would land; `afterVerify`
// right after a read's fd is verified and its size checked — where a file
// that keeps growing would land; `noPin` runs the portable path-only checks
// even where /proc exists. Never set in production.
export const safeFileHooks: { afterOpen: ((path: string) => void) | null; afterVerify: ((path: string) => void) | null; noPin: boolean } = {
  afterOpen: null,
  afterVerify: null,
  noPin: false,
}

let procOk: boolean | null = null
function canPin(): boolean {
  if (safeFileHooks.noPin || O_DIRECTORY === undefined) return false
  if (procOk === null) {
    try {
      procOk = statSync('/proc/self/fd').isDirectory()
    } catch {
      procOk = false
    }
  }
  return procOk
}

function checkName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new ContainmentError(`invalid file name ${JSON.stringify(name)}`)
  }
}

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code

// A verified directory, pinned where the platform allows it.
interface Pinned {
  dir: string
  at(name: string): string // the path that reaches <name> INSIDE the pinned dir
  list(): string[]
  verify(): void // the dir is still the real directory at `dir`
  close(): void
}

// The directory is still the real directory it was resolved to: no component
// of it became a link (or vanished) since. Throws ContainmentError otherwise.
function verifyPath(dir: string): void {
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    throw new ContainmentError(`${dir} moved while Silos was using it — nothing was read or written`)
  }
  if (real !== dir) throw new ContainmentError(`${dir} became a link while Silos was using it — nothing was read or written through it`)
}

// null = the directory is not there
function pin(dir: string): Pinned | null {
  if (!canPin()) {
    try {
      if (!lstatSync(dir).isDirectory()) throw new ContainmentError(`${dir} is not a directory`)
    } catch (err) {
      if (code(err) === 'ENOENT') return null
      throw err
    }
    verifyPath(dir)
    return {
      dir,
      at: (name) => join(dir, name),
      list: () => readdirSync(dir),
      verify: () => verifyPath(dir),
      close: () => {},
    }
  }
  let fd: number
  try {
    fd = openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  } catch (err) {
    const c = code(err)
    if (c === 'ENOENT') return null
    if (c === 'ELOOP') throw new ContainmentError(`${dir} became a link — nothing was read or written through it`)
    if (c === 'ENOTDIR') throw new ContainmentError(`${dir} is not a directory`)
    throw err
  }
  const self = `/proc/self/fd/${fd}`
  const p: Pinned = {
    dir,
    at: (name) => `${self}/${name}`,
    list: () => readdirSync(self),
    verify: () => {
      let now: string
      try {
        now = readlinkSync(self)
      } catch {
        throw new ContainmentError(`${dir} moved while Silos was using it`)
      }
      if (now !== dir) throw new ContainmentError(`${dir} is not where Silos verified it (it is ${now} now) — nothing was read or written`)
    },
    close: () => closeSync(fd),
  }
  try {
    p.verify()
  } catch (err) {
    p.close()
    throw err
  }
  return p
}

function withPin<T>(dir: string, onMissing: T, fn: (p: Pinned) => T): T {
  const p = pin(dir)
  if (p === null) return onMissing
  try {
    return fn(p)
  } finally {
    p.close()
  }
}

// A crash between the exclusive write's link and its unlink leaves the file
// with two names: <name> and our own temp `.<name>.<12 hex>.tmp` beside it
// (writeContained). That second name is Silos' own leftover, never another
// agent's file: same pinned dir, same inode, our temp pattern — it is
// removed (only inside the pinned dir) and the file reads as single-named.
// Anything else with two names stays refused.
function dropOwnTempTwin(p: Pinned, name: string, st: Stats): boolean {
  const base = basename(name)
  const pat = new RegExp(`^\\.${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]{12}\\.tmp$`)
  let names: string[]
  try {
    names = readdirSync(p.at('.'))
  } catch {
    return false
  }
  for (const n of names) {
    if (!pat.test(n)) continue
    let t: Stats
    try {
      t = lstatSync(p.at(n))
    } catch {
      continue
    }
    if (!t.isFile() || t.dev !== st.dev || t.ino !== st.ino) continue
    try {
      unlinkSync(p.at(n))
    } catch {
      return false
    }
    return true
  }
  return false
}

// The fd is the regular, single-link file at <name> in the pinned dir, now.
function verifyFd(fd: number, p: Pinned, name: string): Stats {
  const what = join(p.dir, name)
  const st = fstatSync(fd)
  if (!st.isFile()) throw new ContainmentError(`${what} is not a regular file — Silos won't read or write it`)
  if (st.nlink > 1 && !(st.nlink === 2 && dropOwnTempTwin(p, name, st)))
    throw new ContainmentError(`${what} has more than one name (a hard link) — Silos won't read or write it`)
  let now: Stats
  try {
    now = lstatSync(p.at(name))
  } catch {
    throw new ContainmentError(`${what} moved while Silos was using it`)
  }
  if (!now.isFile() || now.dev !== st.dev || now.ino !== st.ino) throw new ContainmentError(`${what} was swapped while Silos was using it — refused`)
  p.verify()
  return st
}

// Every fs failure inside the layer, in plain words about the LEXICAL path:
// an fs error names the path it was given — inside a pinned dir that is
// /proc/self/fd/<n>/<name>, which means nothing to a person and must never
// reach a route's answer (seventh review round: a directory at the name
// surfaced as a raw EISDIR on /proc/self/fd/23/log). The shapes a planted
// entry can take are ContainmentError; anything else keeps its errno code
// (a caller that tolerates ENOENT still can) with the plain path.
function fsErr(err: unknown, what: string): never {
  if (err instanceof ContainmentError) throw err
  const c = code(err)
  if (c === 'ELOOP' || c === 'EMLINK') throw new ContainmentError(`${what} is a link — Silos won't read or write through it`)
  if (c === 'ENOTDIR') throw new ContainmentError(`${what}: a component on the way is not a directory`)
  if (c === 'ENXIO') throw new ContainmentError(`${what} is not a regular file — Silos won't read or write it`)
  if (c === 'EISDIR' || c === 'ENOTEMPTY') throw new ContainmentError(`${what} is a directory — Silos won't read, write or remove it as a file`)
  if (c === undefined) throw err
  const plain = new Error(`${what}: ${c}`) as NodeJS.ErrnoException
  plain.code = c
  throw plain
}

// Reads at most `limit` bytes from `position` (null = the fd's offset): a
// file that keeps growing after its size was checked is never read further
// than the cap (seventh review round: a 3 GB sparse status.json grown after
// the check cost 6.2 GB of memory).
function readUpTo(fd: number, limit: number, position: number | null): Buffer {
  const chunks: Buffer[] = []
  let total = 0
  const buf = Buffer.allocUnsafe(Math.max(1, Math.min(limit, 1 << 20)))
  let pos = position
  while (total < limit) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, limit - total), pos)
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
    total += n
    if (pos !== null) pos += n
  }
  return Buffer.concat(chunks, total)
}

function writeAll(fd: number, data: string | Buffer): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  let off = 0
  while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off)
}

/**
 * Every read names its cap — there is no unbounded read in the layer (a file
 * in an agent's state is whatever size the agent made it). `tail`: a file
 * longer than the cap is not refused; its LAST `maxBytes` are read
 * (`truncated` says so) — for a log the reader only needs the end of.
 */
export interface ReadOptions {
  maxBytes: number
  tail?: boolean
}

/**
 * Reads `<dir>/<name>` where `dir` is a verified real directory. null = no
 * such file (or no such directory). Throws ContainmentError when the name is
 * a link, a hard link, not a regular file, larger than `maxBytes` (unless
 * `tail`), or was swapped between the open and the check.
 */
export function readContained(dir: string, name: string, opts: ReadOptions): { data: Buffer; stat: Stats; truncated: boolean } | null {
  checkName(name)
  return withPin(dir, null, (p) => {
    let fd: number
    try {
      fd = openSync(p.at(name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    } catch (err) {
      if (code(err) === 'ENOENT') return null
      fsErr(err, join(dir, name))
    }
    try {
      safeFileHooks.afterOpen?.(join(dir, name))
      const st = verifyFd(fd, p, name)
      const max = opts.maxBytes
      if (opts.tail) {
        safeFileHooks.afterVerify?.(join(dir, name))
        const from = Math.max(0, st.size - max)
        return { data: readUpTo(fd, max, from), stat: st, truncated: from > 0 }
      }
      const tooBig = (): never => {
        throw new ContainmentError(`${join(dir, name)} is larger than ${max >= 1024 ? `${Math.round(max / 1024)} KB` : `${max} bytes`} — not read`)
      }
      if (st.size > max) tooBig()
      safeFileHooks.afterVerify?.(join(dir, name))
      // one byte past the cap says the file grew past it since the check
      const data = readUpTo(fd, max + 1, null)
      if (data.length > max) tooBig()
      return { data, stat: st, truncated: false }
    } finally {
      closeSync(fd)
    }
  })
}

export function readContainedText(dir: string, name: string, opts: ReadOptions): string | null {
  const r = readContained(dir, name, opts)
  return r === null ? null : r.data.toString('utf8')
}

/** Tolerant read: missing OR refused reads as null — the readers' old tolerance. */
export function readContainedTextOrNull(dir: string | null, name: string, opts: ReadOptions): string | null {
  if (dir === null) return null
  try {
    return readContainedText(dir, name, opts)
  } catch {
    return null
  }
}

/**
 * Writes `<dir>/<name>` atomically (temp + rename) where `dir` is a verified
 * real directory. A link or hard link already at the name is REPLACED (the
 * rename swaps the name, never writes through it). Throws ContainmentError
 * when the directory was swapped at any point — never a write elsewhere.
 * `exclusive`: the name must not exist yet (a new message, a reply).
 */
export function writeContained(dir: string, name: string, data: string | Buffer, opts: { mode?: number; exclusive?: boolean } = {}): void {
  checkName(name)
  const p = pin(dir)
  if (p === null) throw new ContainmentError(`${dir} is gone — nothing was written`)
  try {
    const tmpName = `.${basename(name)}.${randomBytes(6).toString('hex')}.tmp`
    let fd: number
    try {
      fd = openSync(p.at(tmpName), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, opts.mode ?? 0o600)
    } catch (err) {
      fsErr(err, join(dir, tmpName))
    }
    let placed = false
    try {
      safeFileHooks.afterOpen?.(join(dir, tmpName))
      const st = verifyFd(fd, p, tmpName)
      writeAll(fd, data)
      fsyncSync(fd)
      p.verify()
      if (opts.exclusive) {
        // link, not rename: EEXIST is atomic — the name is never replaced
        try {
          linkSync(p.at(tmpName), p.at(name))
        } catch (err) {
          if (code(err) === 'EEXIST') throw new AlreadyExistsError(`${join(dir, name)} already exists`)
          fsErr(err, join(dir, name))
        }
        placed = true
        try {
          unlinkSync(p.at(tmpName))
        } catch (err) {
          fsErr(err, join(dir, tmpName))
        }
      } else {
        try {
          renameSync(p.at(tmpName), p.at(name))
        } catch (err) {
          fsErr(err, join(dir, name))
        }
        placed = true
      }
      // fail closed: the name must now be the very inode just written, in the
      // same verified directory
      let now: Stats
      try {
        now = lstatSync(p.at(name))
      } catch {
        throw new ContainmentError(`${join(dir, name)} moved while Silos was writing it`)
      }
      if (now.dev !== st.dev || now.ino !== st.ino) throw new ContainmentError(`${join(dir, name)} was swapped while Silos was writing it — refused`)
      p.verify()
    } catch (err) {
      // our own temp file: removed only inside the pinned dir (never
      // through a path that may have been swapped meanwhile)
      if (!placed) {
        try {
          if (canPin()) unlinkSync(p.at(tmpName))
          else if (realpathSync(dir) === dir) unlinkSync(p.at(tmpName))
        } catch {
          /* gone already */
        }
      }
      throw err
    } finally {
      closeSync(fd)
    }
  } finally {
    p.close()
  }
}

/**
 * Appends to `<dir>/<name>` (created when missing) where `dir` is a verified
 * real directory. The fd is verified (regular, single link, the name's inode,
 * the dir still where it was verified) before a single byte is written.
 */
export function appendContained(dir: string, name: string, data: string | Buffer, opts: { mode?: number } = {}): void {
  checkName(name)
  const p = pin(dir)
  if (p === null) throw new ContainmentError(`${dir} is gone — nothing was written`)
  try {
    let fd: number
    try {
      fd = openSync(p.at(name), O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, opts.mode ?? 0o600)
    } catch (err) {
      fsErr(err, join(dir, name))
    }
    try {
      safeFileHooks.afterOpen?.(join(dir, name))
      verifyFd(fd, p, name)
      writeAll(fd, data)
    } finally {
      closeSync(fd)
    }
  } finally {
    p.close()
  }
}

/**
 * The names in a verified real directory ([] when it is missing or refused).
 * Names only — every entry is then read through readContained, which
 * verifies it.
 */
export function listContained(dir: string | null): string[] {
  if (dir === null) return []
  try {
    return withPin(dir, [] as string[], (p) => {
      const names = p.list()
      p.verify()
      return names
    })
  } catch {
    return []
  }
}

/**
 * Removes `<dir>/<name>` from a verified real directory — the name, never a
 * link's target. Missing = nothing to do.
 */
export function removeContained(dir: string, name: string): void {
  checkName(name)
  withPin(dir, undefined, (p) => {
    p.verify()
    try {
      unlinkSync(p.at(name))
    } catch (err) {
      if (code(err) !== 'ENOENT') fsErr(err, join(dir, name))
    }
  })
}

/**
 * The directory `<dir>/<name>` where `dir` is a VERIFIED real directory —
 * looked up (and, with `create`, made) inside the pinned `dir`, never by
 * resolving `dir` again (seventh review round: launch.ts re-resolved the
 * agent's verified state dir with containedDir, and a swap in between wrote
 * the briefing and the role prompt into another agent's opencode/). The name
 * must be a real directory: a link there — even one that stays inside — is
 * refused, it is Silos' own subdir. null = missing (create false). The
 * answer is a verified real dir for the rest of the layer.
 */
export function subdirContained(dir: string, name: string, opts: { create: boolean; mode?: number }): string | null {
  checkName(name)
  const p = pin(dir)
  if (p === null) {
    if (!opts.create) return null
    throw new ContainmentError(`${dir} is gone — nothing was created`)
  }
  try {
    const what = join(dir, name)
    let st: Stats | null = null
    try {
      st = lstatSync(p.at(name))
    } catch (err) {
      if (code(err) !== 'ENOENT') fsErr(err, what)
    }
    if (st === null) {
      if (!opts.create) return null
      p.verify()
      try {
        mkdirSync(p.at(name), { mode: opts.mode ?? 0o700 })
      } catch (err) {
        if (code(err) !== 'EEXIST') fsErr(err, what)
      }
      try {
        st = lstatSync(p.at(name))
      } catch (err) {
        fsErr(err, what)
      }
    }
    if (st.isSymbolicLink()) throw new ContainmentError(`${what} is a link — Silos won't read or write through it`)
    if (!st.isDirectory()) throw new ContainmentError(`${what} is not a directory`)
    p.verify()
    return what
  } finally {
    p.close()
  }
}

// ── an agent's state dir ────────────────────────────────────────────────────

/**
 * The verified real directory `<base>/<agentId>/<segments…>` (contained-dir.ts
 * containedAgentDir): rooted at the AGENT's dir, never the whole base; the
 * agent dir itself is never a link. null = not there (create false).
 */
export function agentDir(base: string, agentId: string, segments: readonly string[], opts: { create: boolean; mode?: number }): string | null {
  return containedAgentDir(base, agentId, segments, { create: opts.create, mode: opts.mode ?? 0o700 })
}
