// silo-draft-confinement.test.ts — sixth review round: a silo draft is read
// from the author's OWN state through safe-file.ts, and its errors never echo
// the file's content. Reproduced first: POST /api/silos/submissions with an
// agent bearer followed a linked silo-drafts/ — another agent's draft read,
// and with silo-drafts → <dataDir> the JSON parse error leaked the first
// characters of a secret file and 404-vs-400 probed what exists there.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDraft } from '../src/silos/validator.js'

let T: string, base: string, alice: string, bob: string
beforeEach(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'draft-conf-')))
  base = join(T, 'data', 'agent-state')
  alice = join(base, 'alice')
  bob = join(base, 'bob')
  mkdirSync(alice, { recursive: true })
  mkdirSync(join(bob, 'silo-drafts'), { recursive: true })
  writeFileSync(join(bob, 'silo-drafts', 'x.json'), JSON.stringify({ secret: 'BOB DRAFT' }))
})
afterEach(() => rmSync(T, { recursive: true, force: true }))

describe("readDraft reads only the author's own draft", () => {
  it("a linked silo-drafts/ into bob is refused — bob's draft never read as alice's", () => {
    symlinkSync('../bob/silo-drafts', join(alice, 'silo-drafts'))
    const d = readDraft(base, 'alice', 'x')
    expect('value' in d).toBe(false)
    expect(JSON.stringify(d)).not.toContain('BOB DRAFT')
  })

  it('silo-drafts → <dataDir>: no content and no existence probe leaks', () => {
    writeFileSync(join(T, 'data', 'broken.json'), 'sk-live-ABCDEFGHIJKLMNOP not json')
    writeFileSync(join(T, 'data', 'territory.json'), '{"enabled":["finance"],"private":["~/secrets"]}')
    symlinkSync(join(T, 'data'), join(alice, 'silo-drafts'))
    const broken = readDraft(base, 'alice', 'broken')
    const terr = readDraft(base, 'alice', 'territory')
    const none = readDraft(base, 'alice', 'nothing-here')
    for (const d of [broken, terr, none]) {
      expect('value' in d).toBe(false)
      expect(JSON.stringify(d)).not.toMatch(/sk-live|ABCDEF|enabled|private/)
    }
    // the same answer whether the file exists there or not
    expect(broken).toEqual(none)
    expect(terr).toEqual(none)
  })

  it('a link or a hard link at the draft file is refused', () => {
    mkdirSync(join(alice, 'silo-drafts'))
    symlinkSync(join(bob, 'silo-drafts', 'x.json'), join(alice, 'silo-drafts', 'x.json'))
    expect('value' in readDraft(base, 'alice', 'x')).toBe(false)
    rmSync(join(alice, 'silo-drafts', 'x.json'))
    linkSync(join(bob, 'silo-drafts', 'x.json'), join(alice, 'silo-drafts', 'x.json'))
    const d = readDraft(base, 'alice', 'x')
    expect('value' in d).toBe(false)
    expect(JSON.stringify(d)).not.toContain('BOB DRAFT')
  })

  it('the whole agent dir a link to bob: refused', () => {
    rmSync(alice, { recursive: true })
    symlinkSync('bob', alice)
    expect('value' in readDraft(base, 'alice', 'x')).toBe(false)
  })

  it('an own draft that is not JSON says so without echoing a byte of it', () => {
    mkdirSync(join(alice, 'silo-drafts'))
    writeFileSync(join(alice, 'silo-drafts', 'bad.json'), 'sk-live-SECRET {')
    const d = readDraft(base, 'alice', 'bad')
    expect(d).toEqual({ error: 'the draft is not valid JSON' })
  })

  it('a plain own draft reads; a missing one is "no draft"', () => {
    mkdirSync(join(alice, 'silo-drafts'))
    writeFileSync(join(alice, 'silo-drafts', 'ok.json'), '{"a":1}')
    expect(readDraft(base, 'alice', 'ok')).toMatchObject({ value: { a: 1 } })
    expect((readDraft(base, 'alice', 'gone') as { error: string }).error).toMatch(/^no draft/)
  })
})
