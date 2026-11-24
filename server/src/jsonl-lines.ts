// jsonl-lines.ts — a JSONL file's complete lines, read in
// bounded slices with the event loop released between them.
//
// Why (21-11): the server is one event loop that also relays the owner's
// live consoles, and a long agent session's transcript is tens of MB. Read
// and parsed in one go (the whole file on the first read after a restart),
// it froze every terminal for seconds. Every whole-file or large-range read
// of a transcript goes through here instead: each slice is about
// SLICE_BYTES, cut at a newline BYTE (a line is never split, and a
// multi-byte character never straddles two slices: 0x0a never appears
// inside one), decoded ONCE, handed to the caller synchronously, and then
// the loop runs (setImmediate) before the next slice. A single line longer
// than a slice is one slice of its own — it can't be parsed in pieces — so
// a slice costs at most SLICE_BYTES of lines or one line. setImmediate is
// enough: timers and I/O run between two slices (measured 21-11: a 5 ms
// timer's worst lateness is one slice's cost, with setImmediate or
// setTimeout(0) alike) — what bounds a stretch is the slice's cost, so the
// slice is small (real lines parse at ~80 ms/MB through both accumulators).
//
// A range of at most one slice is read synchronously with no yield — the
// common incremental refresh of a live transcript (a few KB) costs what it
// always did.
import { openSync, readSync, closeSync } from 'node:fs'
import { open } from 'node:fs/promises'

/** Bytes per slice handed to the caller between two releases of the loop. */
export const SLICE_BYTES = 128 * 1024
// bytes per disk read (sliced in memory afterwards)
const READ_BYTES = 4 * 1024 * 1024

/** One turn of the event loop: timers, I/O and sockets run before the caller goes on. */
export const releaseLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export interface SliceOpts {
  /** At `to`, also hand the unterminated remainder (no final newline) as a
   *  last line — a whole-file read; its bytes are not counted as consumed. */
  partialTail?: boolean
}

/**
 * Hand the complete lines of `path`'s bytes [from, to) to `onSlice`, slice by
 * slice (see the header). `bytes` = what that slice consumed, its final
 * newline included — the caller advances its offset by it in the same
 * synchronous step it feeds the lines, so offset and fed state always agree.
 * Returns the bytes consumed in all (a newline boundary). Rejects when the
 * file can't be opened or read.
 */
export async function sliceLines(
  path: string,
  from: number,
  to: number,
  onSlice: (lines: string[], bytes: number) => void,
  opts: SliceOpts = {},
): Promise<number> {
  if (to <= from) return 0
  if (to - from <= SLICE_BYTES) return feedSmall(path, from, to, onSlice, opts)
  const fh = await open(path, 'r')
  let consumed = 0
  try {
    let pos = from
    let carry: Buffer = Buffer.alloc(0)
    while (pos < to) {
      const want = Math.min(READ_BYTES, to - pos)
      const buf = Buffer.allocUnsafe(want)
      const { bytesRead } = await fh.read(buf, 0, want, pos)
      if (bytesRead === 0) break // the file shrank under us: what was read stands
      pos += bytesRead
      const data = carry.length === 0 ? buf.subarray(0, bytesRead) : Buffer.concat([carry, buf.subarray(0, bytesRead)])
      let start = 0
      for (;;) {
        // the slice ends at the last newline within SLICE_BYTES — a heavy
        // line crossing that mark goes alone in the next slice — or, when
        // the first line alone is longer, right after it
        let end = data.lastIndexOf(0x0a, Math.min(start + SLICE_BYTES, data.length) - 1)
        if (end < start) end = data.indexOf(0x0a, start)
        if (end < start) break // no complete line left: carried into the next read
        onSlice(data.toString('utf8', start, end).split('\n'), end + 1 - start)
        consumed += end + 1 - start
        start = end + 1
        await releaseLoop()
      }
      carry = data.subarray(start)
    }
    if (opts.partialTail && carry.length > 0) onSlice([carry.toString('utf8')], 0)
  } finally {
    await fh.close()
  }
  return consumed
}

function feedSmall(path: string, from: number, to: number, onSlice: (lines: string[], bytes: number) => void, opts: SliceOpts): number {
  const fd = openSync(path, 'r')
  let buf: Buffer
  try {
    const raw = Buffer.allocUnsafe(to - from)
    buf = raw.subarray(0, readSync(fd, raw, 0, raw.length, from))
  } finally {
    closeSync(fd)
  }
  const cut = buf.lastIndexOf(0x0a)
  if (cut !== -1) onSlice(buf.toString('utf8', 0, cut).split('\n'), cut + 1)
  if (opts.partialTail && cut + 1 < buf.length) onSlice([buf.toString('utf8', cut + 1)], 0)
  return cut + 1
}

/** A whole file's lines, slice by slice — the trailing line with no newline
 *  included (what `readFileSync(path).split('\n')` saw, minus the freeze). */
export async function sliceWholeFile(path: string, onSlice: (lines: string[]) => void): Promise<void> {
  const fh = await open(path, 'r')
  let size: number
  try {
    size = (await fh.stat()).size
  } finally {
    await fh.close()
  }
  await sliceLines(path, 0, size, (lines) => onSlice(lines), { partialTail: true })
}
