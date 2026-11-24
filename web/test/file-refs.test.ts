import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/lib/api'
import { fileErrorWords, findPaths, pathOfToken, remarkFileRefs, resolvePath, usedFileDoor } from '../src/lib/file-refs'
import type { FileMeta } from '../src/lib/types'

describe('file refs', () => {
  it('finds absolute, relative and bare-with-extension paths, dropping :line and a full stop', () => {
    const text = 'Wrote /srv/project/context/agent/report.md. See web/src/App.tsx:42 and CLAUDE.md, also ./notes.txt'
    expect(findPaths(text).map((f) => f.path)).toEqual(['/srv/project/context/agent/report.md', 'web/src/App.tsx', 'CLAUDE.md', './notes.txt'])
  })
  it('leaves words, URLs and folders alone', () => {
    expect(findPaths('Node.js e.g. and/or https://github.com/a/b.md /tmp my-app-3f v1.2')).toEqual([])
  })
  it('reads non-ASCII names', () => {
    expect(findPaths('see context/reports/résumé-2025.pdf today').map((f) => f.path)).toEqual(['context/reports/résumé-2025.pdf'])
  })
  it('a token with its line suffix keeps the token whole for the link text', () => {
    const [f] = findPaths('at server/src/x.ts:10:4')
    expect(f).toMatchObject({ token: 'server/src/x.ts:10:4', path: 'server/src/x.ts' })
    expect(pathOfToken('server/src/x.ts:10:4')).toBe('server/src/x.ts')
  })
  it('resolves relative paths against the cwd, never without one', () => {
    expect(resolvePath('../b/c.md', '/srv/a')).toBe('/srv/b/c.md')
    expect(resolvePath('./c.md', '/srv')).toBe('/srv/c.md')
    expect(resolvePath('c.md', null)).toBeNull()
    expect(resolvePath('/x/y.md', null)).toBe('/x/y.md')
  })
  it('the remark plugin turns paths in text into file links, outside links', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'open plans/a.plan.json now' },
            { type: 'link', url: 'x', children: [{ type: 'text', value: 'b/c.md' }] },
          ],
        },
      ],
    }
    remarkFileRefs()(tree)
    const p = tree.children[0]!.children
    expect(p.map((n) => n.type)).toEqual(['text', 'link', 'text', 'link'])
    expect((p[1] as { url: string }).url).toBe('#silos-file:plans%2Fa.plan.json')
    expect((p[3] as { url: string }).url).toBe('x')
  })
  it('a used file opens in the one viewer when it is there — memory notes, relative paths, not-yet-answered alike', () => {
    const meta = {
      path: '/home/user/.claude/projects/-home-user-app/memory/note.md',
      name: 'note.md',
      ext: '.md',
      kind: 'markdown',
      mime: 'text/plain',
      size: 1,
      tooLarge: false,
      editable: true,
    } as FileMeta
    expect(usedFileDoor(meta.path, '/home/user/app', meta)).toEqual({ kind: 'open', path: meta.path })
    expect(usedFileDoor('out/report.pdf', '/home/user/app', undefined)).toEqual({ kind: 'open', path: '/home/user/app/out/report.pdf' })
    expect(usedFileDoor('/home/user/app/gone.png', '/home/user/app', null)).toEqual({ kind: 'gone', path: '/home/user/app/gone.png' })
    expect(usedFileDoor('out/report.pdf', null, undefined)).toEqual({ kind: 'unreachable' })
  })
  it('a failure to open a file is said in words: never the server message, never a code', () => {
    for (const [status, server] of [
      [404, 'file not found'],
      [400, 'an absolute path is required'],
      [500, 'boom'],
      [413, 'too large'],
    ] as const) {
      const words = fileErrorWords(new ApiError(server, status, {}))
      expect(words).not.toContain(server)
      expect(words).not.toMatch(/\d{3}/)
    }
    expect(fileErrorWords(new ApiError('x', 404, {}))).not.toBe(fileErrorWords(new ApiError('x', 400, {})))
    expect(fileErrorWords(new Error('memory path not allowed'))).not.toMatch(/memory|allowed/)
  })
})
