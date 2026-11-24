// The release manifest must know the tree Silos ships NOW — otherwise the
// copy installed today would look "edited" tomorrow and never update again.
// Fix a failure with: node scripts/skill-releases.mjs
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readReleases } from '../src/skill-install.js'
import { skillTreeHash } from '../src/skill-releases.js'

const SKILLS = fileURLToPath(new URL('../../plugin/skills/', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../../scripts/skill-releases.mjs', import.meta.url))
const sha = (t: string): string => createHash('sha256').update(t).digest('hex')

describe('plugin/skills/releases.json', () => {
  const releases = readReleases(SKILLS)
  for (const d of readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    it(`${d.name}: the shipped skill tree is a known release`, () => {
      expect(releases.get(d.name)?.has(skillTreeHash(join(SKILLS, d.name))!)).toBe(true)
    })
  }
})

// 21-11: a published repo has a squashed or shallow history — the commits
// behind old hashes are gone. The manifest never shrinks: the script unions
// with what it already lists, so an install still on an old release keeps
// following.
describe('scripts/skill-releases.mjs', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    })
  function repo() {
    const root = mkdtempSync(join(tmpdir(), 'deck-rel-'))
    git(root, 'init', '-q')
    const put = (rel: string, text: string): void => {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    const commit = (msg: string): void => {
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', msg)
    }
    const run = (): Record<string, string[]> => {
      execFileSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
      return JSON.parse(readFileSync(join(root, 'plugin', 'skills', 'releases.json'), 'utf8')) as Record<string, string[]>
    }
    return { root, put, commit, run }
  }

  it('a history that lacks the old commits keeps every hash the manifest already listed', () => {
    const { put, commit, run } = repo()
    // the squashed history holds only today's text; the manifest remembers two older ones and a retired skill
    put('plugin/skills/team-plan/SKILL.md', 'v3\n')
    put('plugin/skills/releases.json', JSON.stringify({ 'team-plan': [sha('v1\n'), sha('v2\n')], retired: [sha('gone\n')] }))
    commit('squashed')
    const out = run()
    expect(out['team-plan']).toEqual([sha('v1\n'), sha('v2\n'), sha('v3\n')].sort())
    expect(out.retired).toEqual([sha('gone\n')])
  })

  it('reads every version in the history it has, and an edit since', () => {
    const { put, commit, run } = repo()
    put('plugin/skills/heartbeat/SKILL.md', 'a\n')
    commit('a')
    put('plugin/skills/heartbeat/SKILL.md', 'b\n')
    commit('b')
    put('plugin/skills/heartbeat/SKILL.md', 'c\n') // working tree, not committed
    expect(run().heartbeat).toEqual([sha('a\n'), sha('b\n'), sha('c\n')].sort())
  })

  it('hashes a multi-file skill exactly as the server does — from git objects and from disk', () => {
    const { root, put, commit, run } = repo()
    put('plugin/skills/tool/SKILL.md', '# tool\n')
    put('plugin/skills/tool/scripts/run.sh', 'echo 1\n')
    commit('tool v1')
    const v1 = skillTreeHash(join(root, 'plugin', 'skills', 'tool'))!
    put('plugin/skills/tool/scripts/run.sh', 'echo 2\n')
    commit('tool v2 — only the script changed')
    const v2 = skillTreeHash(join(root, 'plugin', 'skills', 'tool'))!
    expect(v1).not.toBe(v2)
    expect(run().tool).toEqual([v1, v2].sort())
  })

  // only what HEAD's history holds was shipped: a tree on a branch that
  // never merged must not make an operator's identical edit read as a release
  it('a version that lives only on an unmerged branch is not a release', () => {
    const { root, put, commit, run } = repo()
    put('plugin/skills/heartbeat/SKILL.md', 'a\n')
    commit('a')
    const main = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
    git(root, 'checkout', '-q', '-b', 'experiment')
    put('plugin/skills/heartbeat/SKILL.md', 'never merged\n')
    commit('experiment')
    git(root, 'checkout', '-q', main)
    expect(run().heartbeat).toEqual([sha('a\n')])
  })

  it('--reset starts over from the trees on disk: neither the manifest nor the history', () => {
    const { root, put, commit } = repo()
    put('plugin/skills/heartbeat/SKILL.md', 'a\n')
    commit('a')
    put('plugin/skills/heartbeat/SKILL.md', 'b\n')
    put('plugin/skills/releases.json', JSON.stringify({ heartbeat: [sha('older\n')], retired: [sha('gone\n')] }))
    commit('b')
    execFileSync(process.execPath, [SCRIPT, '--root', root, '--reset'], { encoding: 'utf8' })
    expect(JSON.parse(readFileSync(join(root, 'plugin', 'skills', 'releases.json'), 'utf8'))).toEqual({ heartbeat: [sha('b\n')] })
  })
})
