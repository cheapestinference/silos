// subagents.spec.ts — the background census in the context column: a session
// whose main turn is CLOSED but whose subagents dir keeps fresh transcripts
// must read Working — n agents at work, list the census (skill run with its
// children nested), and open a row's transcript. Real Chromium against a
// seeded server (no SDK, no real ~/.claude).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { startServer, agentRow, cleanupTempDirs, type E2EServer } from './helpers'

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test('census: Working over live background agents, nested block, transcript on click', async ({ page }) => {
  // seed AFTER start: the watcher indexes the new session like a real one.
  const projectDir = join(srv.root, '-tmp-e2e-project')
  const now = new Date().toISOString()
  const s9 = [
    { type: 'user', cwd: '/tmp/e2e-project', timestamp: now, message: { role: 'user', content: 'run the big review' } },
    { type: 'ai-title', aiTitle: 'Background review', sessionId: 's9' },
    { type: 'assistant', cwd: '/tmp/e2e-project', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'Launched.' }] } },
    { type: 'system', subtype: 'turn_duration', timestamp: now, durationMs: 1000 },
  ]
  writeFileSync(join(projectDir, 's9.jsonl'), s9.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const subDir = join(projectDir, 's9', 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(
    join(subDir, 'agent-aaaaaaaaaaaaaaaa.jsonl'),
    JSON.stringify({ type: 'user', timestamp: now, message: { role: 'user', content: 'orchestrate' } }) + '\n',
  )
  writeFileSync(
    join(subDir, 'agent-aaaaaaaaaaaaaaaa.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: '/code-review max — first pass', spawnDepth: 1 }),
  )
  writeFileSync(join(subDir, 'agent-aaaaaaaaaaaaaaaa.forked-skill.json'), JSON.stringify({ skillName: 'code-review', effort: 'max' }))
  writeFileSync(
    join(subDir, 'agent-bbbbbbbbbbbbbbbb.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: now, message: { role: 'user', content: 'find bugs' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: now,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'pledge' } }] },
      }),
    ].join('\n') + '\n',
  )
  writeFileSync(
    join(subDir, 'agent-bbbbbbbbbbbbbbbb.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Finder: cross-file', parentAgentId: 'aaaaaaaaaaaaaaaa', spawnDepth: 2 }),
  )

  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
  await page
    .getByRole('button', { name: agentRow('E2E') })
    .first()
    .click()
  await page.locator('aside').first().getByText('Background review').first().click()

  const column = page.getByRole('complementary').last()
  await expect(column.getByText('Working')).toBeVisible()
  await expect(column.getByText(/2 subagents at work/)).toBeVisible()
  await expect(column.getByText('/code-review max — first pass')).toBeVisible()
  await expect(column.getByText('Finder: cross-file')).toBeVisible()
  await expect(column.getByText(/Grep — pledge/)).toBeVisible()

  // a row opens ITS transcript (the subagent viewer modal)
  await column.getByText('Finder: cross-file').click()
  await expect(page.getByRole('dialog', { name: /Subagent · Finder: cross-file/ })).toBeVisible()
})
