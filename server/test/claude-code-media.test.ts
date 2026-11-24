// media.test.ts — transcript multimedia: the parser emits image METADATA
// (never the base64) and media.ts / the /media/:ref routes re-extract the
// heavy payload from the JSONL on demand.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { TranscriptAccumulator, pngDims, imagesOf, toolResultsOf } from '../src/harnesses/claude-code/parser.js'
import { extractImage } from '../src/harnesses/claude-code/media.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'

// A genuinely local request (loopback Host, no forwarding/tunnel headers)
// no longer requires a token — see isLocalRequest in server.ts. These 401
// assertions must look REMOTE (public host) so they keep exercising the
// guard without weakening it.
const REMOTE = { host: 'silos.example.com' }

// a REAL 128x80 PNG (465 bytes) generated with zlib+struct — not a mock:
// the dims tests read its actual IHDR and the extraction tests compare bytes.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAABQCAIAAABeYuqzAAABmElEQVR42u3b11ECQABFUSqxki1niyCJoGIiKJLMiSDBAKjYnuwtgvHjzpwO7uebl9kJWeSQRwFF7KKEvSSWUcE+DnCIKo5wnIQTnOIMNdTRQBPnSbxAC5doo4Mueugn4QrXuMEt7nCPBzwm8QnPeMEAQ4wwxmsSJphihjne8I4PfCZxgSVW+MI3frDG70bGAAYwgAEMYAADGMAABjCAAQxgAAMYwAAGMIABDGCAbQSIWeSQRwFF7KKEvSSUUcE+DnCIKo5wnMQTnOIMNdTRQBPnSbhAC5doo4Mueugn8QrXuMEt7nCPBzwm4QnPeMEAQ4wwxmsSJ5hihjne8I4PfCZhgSVW+MI3frDG74YBDGAAAxjAAAYwgAEMYAADGMAABjCAAQxgAAMYwABbCeAg4yJmAAMYwAAGMIABDGAAAxjAAAYwgAEMYAADGMAABvAf4CDjImYAAxjAAAYwgAEMYAADGMAABjCAAQxgAAMYwAAG8B/gIOMiZgADGMAABjCAAQxgAAMYwAAGMIABDGAAAxjAAAb47wH+AOkw3lnH+r5zAAAAAElFTkSuQmCC'

const uuid = '11111111-2222-3333-4444-555555555555'

const imgBlock = { type: 'image', source: { type: 'base64', data: PNG_B64, media_type: 'image/png' } }

// an SVG with a script — real adversarial content the raster allowlist
// must neutralize on both layers.
const SVG_B64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')
const svgBlock = { type: 'image', source: { type: 'base64', data: SVG_B64, media_type: 'image/svg+xml' } }

function lines(entries: unknown[]): string[] {
  return entries.map((e) => JSON.stringify(e))
}

describe('pngDims', () => {
  it('reads the real PNG IHDR', () => expect(pngDims(PNG_B64)).toEqual({ w: 128, h: 80 }))
  it('base64 that is not a PNG -> null', () => expect(pngDims(Buffer.from('x'.repeat(64)).toString('base64'))).toBeNull())
  it('too short -> null', () => expect(pngDims('abc')).toBeNull())
})

describe('imagesOf / toolResultsOf — metadata, never the base64', () => {
  it('a direct image block -> metadata with dims', () => {
    const out = imagesOf([imgBlock, { type: 'text', text: 'look' }])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ mediaType: 'image/png', w: 128, h: 80 })
    expect(out[0]!.bytes).toBe(Math.floor(PNG_B64.length * 0.75))
  })
  it('an image nested in a tool_result', () => {
    const out = toolResultsOf([{ type: 'tool_result', tool_use_id: 'tu1', content: [imgBlock] }])
    expect(out[0]!.images).toHaveLength(1)
    expect(out[0]!.text).toBe('')
  })
  it('a source without a usable base64 is skipped (never a crash)', () => {
    expect(imagesOf([{ type: 'image', source: { type: 'url', url: 'https://x' } }])).toEqual([])
  })

  // a scriptable media_type never turns into a turn image — the raster
  // allowlist discards it in the parser (belt).
  it('image/svg+xml produces no metadata (raster allowlist)', () => {
    expect(imagesOf([svgBlock])).toEqual([])
    const out = toolResultsOf([{ type: 'tool_result', tool_use_id: 'tu1', content: [svgBlock] }])
    expect(out[0]!.images).toEqual([])
  })

  // blockIdx counts ALL image blocks (including discarded ones) — that's
  // what keeps the ref aligned with nthImage in media.ts when the allowlist
  // skipped one along the way.
  it("a block dropped by the allowlist does not shift the next one's index", () => {
    const out = toolResultsOf([{ type: 'tool_result', tool_use_id: 'tu1', content: [svgBlock, imgBlock] }])
    expect(out[0]!.images).toHaveLength(1)
    expect(out[0]!.images[0]).toMatchObject({ mediaType: 'image/png', blockIdx: 1 })
  })
})

describe('TranscriptAccumulator — multimedia', () => {
  it('an image pasted by the user -> turn.images with ref u.<uuid>.<n>', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(lines([{ type: 'user', uuid, message: { role: 'user', content: [imgBlock, { type: 'text', text: 'what is this?' }] } }]))
    expect(turns).toHaveLength(1)
    expect(turns[0]!.images).toEqual([{ ref: `u.${uuid}.0`, mediaType: 'image/png', bytes: Math.floor(PNG_B64.length * 0.75), w: 128, h: 80 }])
    expect(turns[0]!.text).toBe('what is this?')
  })

  it('a user turn that is ONLY an image is not discarded as noise', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(lines([{ type: 'user', uuid, message: { role: 'user', content: [imgBlock] } }]))
    expect(turns).toHaveLength(1)
    expect(turns[0]!.images).toHaveLength(1)
    expect(turns[0]!.text).toBe('')
  })

  it('a user entry without a uuid: the image cannot be referenced -> no images (documented)', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(lines([{ type: 'user', message: { role: 'user', content: [imgBlock, { type: 'text', text: 'hey' }] } }]))
    expect(turns).toHaveLength(1)
    expect(turns[0]!.images).toBeUndefined()
  })

  it('an image from a tool_result -> toolUses[].images with ref t.<toolUseId>.<n>', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(
      lines([
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.png' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [imgBlock] }] } },
      ]),
    )
    expect(turns).toHaveLength(1)
    const d = turns[0]!.toolUses![0]!
    expect(d.images).toEqual([{ ref: 't.tu1.0', mediaType: 'image/png', bytes: Math.floor(PNG_B64.length * 0.75), w: 128, h: 80 }])
  })

  it('a JPEG without a readable header: dims from the toolUseResult.file.dimensions fallback', () => {
    const jpegB64 = Buffer.from('\xff\xd8\xff' + 'x'.repeat(200), 'binary').toString('base64')
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(
      lines([
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: {} }] } },
        {
          type: 'user',
          toolUseResult: { type: 'image', file: { dimensions: { originalWidth: 1536, originalHeight: 1008, displayWidth: 768, displayHeight: 504 } } },
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'image', source: { type: 'base64', data: jpegB64, media_type: 'image/jpeg' } }] },
            ],
          },
        },
      ]),
    )
    expect(turns[0]!.toolUses![0]!.images![0]).toMatchObject({ ref: 't.tu2.0', mediaType: 'image/jpeg', w: 768, h: 504 })
  })

  // with an svg ahead of it, the png's ref points at ITS OWN block
  // (t.<id>.1) — never at the filtered array's index, which would resolve
  // to the svg.
  it('svg + png in the same tool_result -> a single TurnImage with a ref to the real block', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(
      lines([
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu7', name: 'Read', input: {} }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu7', content: [svgBlock, imgBlock] }] } },
      ]),
    )
    const imgs = turns[0]!.toolUses![0]!.images!
    expect(imgs).toHaveLength(1)
    expect(imgs[0]!.ref).toBe('t.tu7.1')
    expect(imgs[0]!.mediaType).toBe('image/png')
  })

  it('defensive cap: more than 12 images in one tool_result -> 12', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(
      lines([
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'X', input: {} }] } },
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: Array.from({ length: 15 }, () => imgBlock) }] },
        },
      ]),
    )
    expect(turns[0]!.toolUses![0]!.images).toHaveLength(12)
  })
})

describe('extractImage — on-demand re-extraction from the JSONL', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deck-media-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function write(entries: unknown[]): string {
    const p = join(dir, 's.jsonl')
    writeFileSync(p, lines(entries).join('\n') + '\n')
    return p
  }

  it('ref t.<id>.<n> returns the EXACT bytes from the JSONL', async () => {
    const p = write([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [imgBlock] }] } },
    ])
    const out = await extractImage(p, 't.tu1.0')
    expect(out).not.toBeNull()
    expect(out!.mediaType).toBe('image/png')
    expect(out!.buf.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
  })

  it('ref u.<uuid>.<n> — a direct image from a user entry (and does not confuse parentUuid)', async () => {
    const p = write([
      { type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'user', uuid: 'aaaa1111-0000-0000-0000-000000000000', parentUuid: uuid, message: { role: 'user', content: [imgBlock] } },
    ])
    // the requested uuid belongs to the SECOND entry — the first entry's line doesn't contain it
    const out = await extractImage(p, 'u.aaaa1111-0000-0000-0000-000000000000.0')
    expect(out).not.toBeNull()
    expect(out!.buf.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
    // and the entry WITHOUT an image at that uuid honestly returns null
    expect(await extractImage(p, `u.${uuid}.0`)).toBeNull()
  })

  // a hand-built ref pointing at a non-raster block comes back as
  // octet-stream (never with its scriptable content-type), and the
  // legitimate png ref alongside it stays exact.
  it('an svg block by direct ref -> application/octet-stream; the png beside it stays exact', async () => {
    const p = write([{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [svgBlock, imgBlock] }] } }])
    const svg = await extractImage(p, 't.tu1.0')
    expect(svg!.mediaType).toBe('application/octet-stream')
    const png = await extractImage(p, 't.tu1.1')
    expect(png!.mediaType).toBe('image/png')
    expect(png!.buf.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
  })

  // the early return (image found) used to leave the createReadStream fd
  // alive — one extra fd per call, never reclaimed by GC -> EMFILE on a
  // long-lived server. With an explicit destroy() the /proc/self/fd count
  // stays flat.
  it('N extractions with an early return do not leak file descriptors', async () => {
    const p = write([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [imgBlock] }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'unconsumed tail' }] } },
    ])
    const fds = (): number => readdirSync('/proc/self/fd').length
    // warm-up (node's lazy handles/pools don't count as a leak)
    await extractImage(p, 't.tu1.0')
    const before = fds()
    for (let i = 0; i < 25; i++) {
      const out = await extractImage(p, 't.tu1.0') // found -> early return
      expect(out).not.toBeNull()
    }
    // margin of 2: other runtime handles may open/close concurrently, but
    // a real leak would show up as +25 here.
    expect(fds()).toBeLessThanOrEqual(before + 2)
  })

  it('an out-of-range index or a malformed ref -> null', async () => {
    const p = write([{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [imgBlock] }] } }])
    expect(await extractImage(p, 't.tu1.5')).toBeNull()
    expect(await extractImage(p, 'zzz')).toBeNull()
    expect(await extractImage(p, 't.missing.0')).toBeNull()
  })
})

describe('/media/:ref routes', () => {
  let app: FastifyInstance
  let base: string
  const TOKEN = 'testtoken'

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'deck-media-api-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    mkdirSync(join(root, '-tmp-px'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    const entries = [
      { type: 'user', uuid, cwd: '/tmp/px', message: { role: 'user', content: [imgBlock, { type: 'text', text: 'look at this' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/shot.png' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [imgBlock] }] } },
      // an adversarial tool_result with an svg — the parser gives it no
      // TurnImage, and the route neutralizes it to octet-stream if
      // someone builds the ref by hand.
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: [svgBlock] }] } },
    ]
    writeFileSync(join(root, '-tmp-px', 'sx.jsonl'), lines(entries).join('\n') + '\n')
    // a subagent with its own image (real-corpus images live mostly under
    // subagents/*.jsonl — the path matters)
    mkdirSync(join(root, '-tmp-px', 'sx', 'subagents'), { recursive: true })
    writeFileSync(
      join(root, '-tmp-px', 'sx', 'subagents', 'agent-abcdef1234567890.jsonl'),
      lines([
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu9', name: 'Read', input: {} }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: [imgBlock] }] } },
      ]).join('\n') + '\n',
    )
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    const store = new SessionStore(root, dataDir)
    const native = new NativeStore(join(dataDir, 'native.json'))
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    app = buildServer({
      index,
      registry,
      store,
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: TOKEN,
      liveMs: 120_000,
    })
  })

  afterEach(async () => {
    await app.close()
    rmSync(base, { recursive: true, force: true })
  })

  const get = (url: string) => app.inject({ url, headers: { 'x-token': TOKEN } })

  it('detail turns carry metadata, never base64', async () => {
    const body = (await get('/api/sessions/-tmp-px/sx')).json()
    expect(body.turns[0].images).toEqual([{ ref: `u.${uuid}.0`, mediaType: 'image/png', bytes: Math.floor(PNG_B64.length * 0.75), w: 128, h: 80 }])
    expect(body.turns[1].toolUses[0].images[0].ref).toBe('t.tu1.0')
    expect(JSON.stringify(body)).not.toContain(PNG_B64.slice(0, 40))
  })

  it('GET media with a user ref and a tool ref -> real bytes + immutable + nosniff', async () => {
    for (const ref of [`u.${uuid}.0`, 't.tu1.0']) {
      const res = await get(`/api/sessions/-tmp-px/sx/media/${ref}`)
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('image/png')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['cache-control']).toContain('immutable')
      expect(res.rawPayload.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
    }
  })

  // the detail view exposes no TurnImage for the svg, and a hand-built
  // ref never comes back with a scriptable content-type.
  it('svg: no TurnImage in the detail view; a hand-built ref -> octet-stream + nosniff', async () => {
    const body = (await get('/api/sessions/-tmp-px/sx')).json()
    // the tu2 tool_use (last detail) exists but WITHOUT images
    const svgDetail = body.turns.flatMap((t: { toolUses?: { images?: unknown[] }[] }) => t.toolUses ?? []).at(-1)
    expect(svgDetail.images).toBeUndefined()
    const res = await get('/api/sessions/-tmp-px/sx/media/t.tu2.0')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('media from a subagent', async () => {
    const res = await get('/api/sessions/-tmp-px/sx/subagents/abcdef1234567890/media/t.tu9.0')
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
  })

  it('malformed ref -> 400; nonexistent ref -> 404; no token -> 401', async () => {
    expect((await get('/api/sessions/-tmp-px/sx/media/..%2Fetc')).statusCode).toBe(400)
    expect((await get('/api/sessions/-tmp-px/sx/media/t.nobody.0')).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/sessions/-tmp-px/sx/media/t.tu1.0`, headers: REMOTE })).statusCode).toBe(401)
  })
})
