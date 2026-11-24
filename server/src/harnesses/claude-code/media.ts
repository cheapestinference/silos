// media.ts — on-demand extraction of images from the JSONL.
//
// THE DATA'S PATH (why this file exists): an image's base64 is heavy (real
// corpus p50 is 64KB, max 413KB decoded) and the JSONL already stores it —
// duplicating it across turns (API/WS/the web store/the index cache) would
// multiply memory at every layer. The parser emits ONLY metadata with a
// stable `ref`, and this function re-extracts the exact block when the
// browser's <img> requests it (lazy). The file is streamed line by line and
// only the candidate line gets parsed (a cheap substring filter before
// JSON.parse) — memory bounded to the size of ONE line, not the file.
//
// Ref formats (see parser.ts, where they're minted):
//   t.<toolUseId>.<n> — nth image in the content of the tool_result with that id
//   u.<uuid>.<n>      — nth image DIRECTLY on the user entry with that uuid
// Both ids are immutable once written (the JSONL is append-only — read-only
// over foreign data), so the response is cacheable as immutable.
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { conversationalMessage } from './parser.js'

export const MEDIA_REF_RE = /^([tu])\.([A-Za-z0-9_-]{1,64})\.(\d{1,3})$/

// Defensive cap on the decoded size — the real corpus max is 413KB; 10MB
// leaves generous headroom without letting an adversarial line blow up the server.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export interface ExtractedImage {
  buf: Buffer
  mediaType: string
}

interface ImageBlock {
  type?: unknown
  source?: { type?: unknown; data?: unknown; media_type?: unknown }
}

// Security: allowlist of RASTER types — an exact mirror of RASTER_TYPES in
// parser.ts (which already prevents an svg from becoming a TurnImage). This
// is the layer that backs up that guarantee: even if someone hand-crafts a
// ref pointing at an image/svg+xml block in the JSONL, the response comes
// out as application/octet-stream (+ nosniff in serveMedia) — an SVG served
// as image/svg+xml and navigated to directly would be a DOCUMENT in Silos'
// own origin, with script access to the localStorage token and the transcripts.
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function decode(block: ImageBlock): ExtractedImage | null {
  const src = block.source
  if (!src || src.type !== 'base64' || typeof src.data !== 'string' || src.data === '') return null
  if (src.data.length > (MAX_IMAGE_BYTES * 4) / 3) return null
  let buf: Buffer
  try {
    buf = Buffer.from(src.data, 'base64')
  } catch {
    return null
  }
  if (buf.length === 0) return null
  const declared = typeof src.media_type === 'string' ? src.media_type : 'image/png'
  const mediaType = RASTER_TYPES.has(declared) ? declared : 'application/octet-stream'
  return { buf, mediaType }
}

// nth image block from a list of blocks (the content of a user entry or a
// tool_result) — the SAME order and counting criterion as the parser
// (image blocks with an unusable source don't count differently: the ref's
// index was minted over type:'image' blocks in order, so counting here
// matches, and if the nth one fails to decode an honest null is returned).
function nthImage(blocks: unknown, n: number): ExtractedImage | null {
  if (!Array.isArray(blocks)) return null
  let seen = 0
  for (const b of blocks) {
    if (!b || typeof b !== 'object' || (b as { type?: unknown }).type !== 'image') continue
    if (seen === n) return decode(b as ImageBlock)
    seen++
  }
  return null
}

// Looks up the ref in the JSONL and returns the decoded image, or null if
// it's not there (stale ref, rotated file, corrupt line…). The substring
// filter (the ref's id) avoids JSON.parse on lines that can't contain the
// block — the scan is O(file bytes) but parsing only touches the candidate
// line.
export async function extractImage(filePath: string, ref: string): Promise<ExtractedImage | null> {
  const m = MEDIA_REF_RE.exec(ref)
  if (!m) return null
  const [, kind, id, idxStr] = m
  const idx = Number.parseInt(idxStr!, 10)
  const needle = `"${id}"`

  // rl.close() does NOT destroy the underlying createReadStream when the
  // stream wasn't fully consumed (reproduced on Node 22) — and this
  // function's common case is exactly that (returning from inside the for
  // await once the image is found). Without the explicit destroy() call,
  // this leaked ONE fd per extraction (GC never reclaimed them) → EMFILE on
  // the long-running local server, breaking ALL session reads, not just media.
  const input = createReadStream(filePath)
  const rl = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.includes(needle)) continue
      let e: Record<string, unknown>
      try {
        e = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const content = conversationalMessage(e)?.content
      if (kind === 'u') {
        // direct image on a user entry identified by uuid
        if (e.uuid !== id) continue
        return nthImage(content, idx)
      }
      // kind === 't': image inside the tool_result with that tool_use_id
      if (!Array.isArray(content)) continue
      for (const b of content) {
        if (!b || typeof b !== 'object' || (b as { type?: unknown }).type !== 'tool_result') continue
        if ((b as { tool_use_id?: unknown }).tool_use_id !== id) continue
        return nthImage((b as { content?: unknown }).content, idx)
      }
    }
  } finally {
    rl.close()
    input.destroy()
  }
  return null
}
