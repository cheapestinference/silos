// E1.1/E1.2: the claim/release curls have ONE source each,
// plugin/context/recipes/{claim,release}.sh. Every place an agent reads them
// quotes that text verbatim, the SessionStart hook emits it from the file,
// and the server's prompts take it from recipeText — never a curl of their own.
import { describe, expect, it, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recipeText } from '../src/harnesses/briefing.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const HOOK = fileURLToPath(new URL('../../plugin/hooks/session-start.sh', import.meta.url))

describe('recipes: one source', () => {
  for (const name of ['claim', 'release'] as const) {
    it(`${name}.sh is the multiline curl with the API default, authorship, the session chain and the markers — no state`, () => {
      const t = recipeText(name)
      expect(t.split('\n').length).toBeGreaterThan(1)
      expect(t).toContain(`\${SILOS_API:-http://127.0.0.1:3210}/api/tasks/${name}`)
      expect(t).toContain('${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"}')
      expect(t).toContain('${SILOS_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-$SILOS_CONSOLE_KEY}}')
      expect(t).toContain('<slug>')
      expect(t).toContain('<id>')
      expect(t).not.toMatch(/"state"/)
    })
    // (the briefing trim, on purpose) an agent without the skill reads the
    // recipes in the file its Tasks rule names, not in the rule itself
    it(`${name}: quoted verbatim in team-plan's SKILL.md and the tasks reference of an agent without the skill`, () => {
      const t = recipeText(name)
      for (const rel of ['plugin/skills/team-plan/SKILL.md', 'plugin/context/reference/tasks.md']) {
        expect(read(rel), rel).toContain(t)
      }
    })
  }
  it('product.md quotes both blocks', () => {
    const doc = read('docs/product.md')
    expect(doc).toContain(recipeText('claim'))
    expect(doc).toContain(recipeText('release'))
  })
  it('fill replaces the markers', () => {
    const t = recipeText('release', { slug: 'tasks', id: 't3' })
    expect(t).toContain('{"plan":"tasks","task":"t3",')
    expect(t).not.toMatch(/<slug>|<id>/)
  })
})

describe('recipes: the /clear hook emits the release recipe from its file', () => {
  let server: Server | null = null
  let home = ''
  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r))
    server = null
    if (home) rmSync(home, { recursive: true, force: true })
  })
  it('the fenced block after /clear is recipeText("release", fill)', async () => {
    home = mkdtempSync(join(tmpdir(), 'recipes-'))
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify(
          (req.url ?? '').startsWith('/api/tasks/by-session')
            ? {
                k1: [
                  // the project's list: said by its project, sent by its file's id
                  { key: 'folder:/p/x/tasks/tasks/t3', ref: 'x#t3', title: 'Ship & tell | now', state: 'in_progress', current: true },
                  // a named plan; a row with no key falls back to the ref
                  { key: 'folder:/p/x/month-end/tasks/t1', ref: 'month-end#t1', title: 'Close', state: 'in_progress', current: true },
                  { ref: 'other#t2', title: 'Other', state: 'in_progress', current: true },
                ],
              }
            : { agents: [] },
        ),
      )
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const ctx = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'sh',
        [HOOK],
        { env: { PATH: process.env.PATH ?? '', HOME: home, SILOS_API: api, SILOS_SESSION_ID: 'k1' }, encoding: 'utf8' },
        (err, out) => {
          if (err) return reject(err)
          resolve(JSON.parse(out).hookSpecificOutput.additionalContext)
        },
      )
      child.stdin!.end(JSON.stringify({ session_id: 'n', cwd: '/p/x', source: 'clear', hook_event_name: 'SessionStart' }))
    })
    const says = (title: string, ref: string, slug: string, id: string) =>
      `This console was working on «${title}» (${ref}). Continue it — or, if you are switching to something else, release it (it goes back to pending; add "state" to say done/blocked/in_review — in_review only with waitingOn naming who reviews it):\n\`\`\`\n${recipeText('release', { slug, id })}\n\`\`\``
    expect(ctx).toContain(says('Ship & tell | now', 'x#t3', 'tasks', 't3'))
    expect(ctx).toContain(says('Close', 'month-end#t1', 'month-end', 't1'))
    expect(ctx).toContain(says('Other', 'other#t2', 'other', 't2'))
  })
})
