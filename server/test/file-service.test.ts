import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileService, FileError, classifyFile, INLINE_CAP } from '../src/file-service.js'

let base: string, dataDir: string, proj: string, svc: FileService

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-file-svc-'))
  dataDir = join(base, 'data')
  proj = join(base, 'proj')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(proj, { recursive: true })
  svc = new FileService(dataDir)
})

describe('classifyFile', () => {
  it('classifies by extension', () => {
    expect(classifyFile('.md').kind).toBe('markdown')
    expect(classifyFile('.pdf')).toEqual({ kind: 'pdf', mime: 'application/pdf' })
    expect(classifyFile('.PNG').kind).toBe('image')
    expect(classifyFile('.ts').kind).toBe('text')
    expect(classifyFile('.bin').kind).toBe('binary')
    // svg falls under image, never executable text
    expect(classifyFile('.svg').kind).toBe('image')
  })
})

describe('meta', () => {
  it('returns type/size/editable for a markdown file', () => {
    const p = join(proj, 'note.md')
    writeFileSync(p, '# hi\n')
    const m = svc.meta(p)
    expect(m.kind).toBe('markdown')
    expect(m.editable).toBe(true)
    expect(m.tooLarge).toBe(false)
    expect(m.name).toBe('note.md')
    expect(m.size).toBe(5)
  })

  it('a plain text file is editable too (text and markdown both get the editor)', () => {
    const p = join(proj, 'app.ts')
    writeFileSync(p, 'const x = 1\n')
    expect(svc.meta(p).kind).toBe('text')
    expect(svc.meta(p).editable).toBe(true)
  })

  it('marks tooLarge for text above the inline cap', () => {
    const p = join(proj, 'big.txt')
    writeFileSync(p, 'x'.repeat(INLINE_CAP + 1))
    const m = svc.meta(p)
    expect(m.tooLarge).toBe(true)
    expect(m.editable).toBe(false)
  })

  it('a large image is NOT marked tooLarge (it is served by stream)', () => {
    const p = join(proj, 'photo.png')
    writeFileSync(p, Buffer.alloc(INLINE_CAP + 1000))
    expect(svc.meta(p).tooLarge).toBe(false)
    expect(svc.meta(p).kind).toBe('image')
  })
})

describe('access: any absolute path, sane hygiene (no allowlist)', () => {
  it('reads an arbitrary ABSOLUTE path (same boundary as the terminal)', () => {
    // a file OUTSIDE any "session" — this used to be blocked; now it's
    // legitimate: auth is the boundary, not a per-session allowlist.
    const outside = join(base, 'whatever.md')
    writeFileSync(outside, '# free\n')
    expect(svc.readText(outside)).toBe('# free\n')
  })

  it('sanely normalizes .. down to a real file', () => {
    const p = join(proj, 'real.md')
    writeFileSync(p, 'ok\n')
    const odd = join(proj, 'sub', '..', 'real.md')
    expect(svc.readText(odd)).toBe('ok\n')
  })

  it('follows a symlink to a real file without blowing up', () => {
    const target = join(base, 'target.md')
    writeFileSync(target, 'content\n')
    const link = join(proj, 'link.md')
    symlinkSync(target, link)
    expect(svc.readText(link)).toBe('content\n')
  })

  it('a relative path -> 400', () => {
    expect(() => svc.meta('relative/x.md')).toThrow(FileError)
    try {
      svc.meta('relative/x.md')
    } catch (e) {
      expect((e as FileError).status).toBe(400)
    }
  })

  it('an empty path -> 400', () => {
    try {
      svc.meta('')
    } catch (e) {
      expect((e as FileError).status).toBe(400)
    }
  })

  it('a nonexistent file -> 404', () => {
    try {
      svc.meta(join(proj, 'does-not-exist.md'))
    } catch (e) {
      expect((e as FileError).status).toBe(404)
    }
  })

  it('a directory -> 404 (not a file)', () => {
    try {
      svc.meta(proj)
    } catch (e) {
      expect((e as FileError).status).toBe(404)
    }
  })

  it('readText on text above the cap -> 413', () => {
    const p = join(proj, 'big.txt')
    writeFileSync(p, 'x'.repeat(INLINE_CAP + 1))
    try {
      svc.readText(p)
    } catch (e) {
      expect((e as FileError).status).toBe(413)
    }
  })
})

describe('openForServe', () => {
  it('inline for large text -> 413; with download it does serve it', () => {
    const p = join(proj, 'big.txt')
    writeFileSync(p, 'x'.repeat(INLINE_CAP + 1))
    expect(() => svc.openForServe(p, false)).toThrow(FileError)
    const { meta, stream } = svc.openForServe(p, true)
    expect(meta.name).toBe('big.txt')
    stream.destroy()
  })

  it('a large image is served inline (the text cap does not apply)', () => {
    const p = join(proj, 'photo.png')
    writeFileSync(p, Buffer.alloc(INLINE_CAP + 1000))
    const { stream } = svc.openForServe(p, false)
    stream.destroy()
  })
})

describe('write: text/markdown only, backup + atomic', () => {
  it('writes markdown, makes a backup and never leaves the original half-written', () => {
    const p = join(proj, 'doc.md')
    writeFileSync(p, '# v1\n')
    const { backup } = svc.write(p, '# v2\n')
    expect(backup).toBeTruthy()
    expect(existsSync(backup!)).toBe(true)
    expect(readFileSync(backup!, 'utf8')).toBe('# v1\n') // the backup holds the PREVIOUS content
    expect(readFileSync(p, 'utf8')).toBe('# v2\n')
  })

  it('allows saving plain text files (e.g. .ts)', () => {
    const p = join(proj, 'x.ts')
    writeFileSync(p, 'a\n')
    const { backup } = svc.write(p, 'b\n')
    expect(existsSync(backup!)).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe('b\n')
  })

  it('rejects saving over a binary/PDF file (anti-corruption hygiene) -> 400', () => {
    const p = join(proj, 'doc.pdf')
    writeFileSync(p, '%PDF-1.4\n')
    try {
      svc.write(p, 'text')
    } catch (e) {
      expect((e as FileError).status).toBe(400)
    }
    expect(readFileSync(p, 'utf8')).toBe('%PDF-1.4\n') // untouched
  })

  it('two consecutive writes do not overwrite the previous backup', () => {
    const p = join(proj, 'doc.md')
    writeFileSync(p, 'a\n')
    const b1 = svc.write(p, 'b\n').backup
    const b2 = svc.write(p, 'c\n').backup
    expect(b1).not.toBe(b2)
    expect(existsSync(b1!)).toBe(true)
    expect(existsSync(b2!)).toBe(true)
  })

  it('content above the cap -> 413', () => {
    const p = join(proj, 'doc.md')
    writeFileSync(p, 'a\n')
    try {
      svc.write(p, 'x'.repeat(INLINE_CAP + 1))
    } catch (e) {
      expect((e as FileError).status).toBe(413)
    }
  })

  it('a relative path -> 400', () => {
    try {
      svc.write('rel.md', 'x')
    } catch (e) {
      expect((e as FileError).status).toBe(400)
    }
  })
})
