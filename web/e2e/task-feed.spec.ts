// task-feed.spec.ts — the task feed against a REAL seeded server.
// Seeded by seedTaskMode: l8's thread
// holds a delivered wake turn — its briefing line in the transcript — and a
// closed two-segment reply. The page's «Notes and activity» must show the
// agent's reply card folded to the LAST segment (the answer), unfold on
// «more», and carry the conversation door. The feed endpoint is the owner's:
// everything here rides the seeded token like the rest of the suite.
// Evidence screenshots under web/test-results/shots/task-feed/ when SILOS_SHOTS=1.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, TASKS_PLAN_SLUG, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('task-feed') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ taskMode: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1440, height: 900 } })

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(SHOTS, name), fullPage: true })
}

let agentFolder = ''
test.beforeAll(async ({ request }) => {
  const agents = (await (await request.get(`${srv.url}/api/agents?token=${srv.token}`)).json()) as
    { agents?: Array<{ id: string; folder: string | null }> } | Array<{ id: string; folder: string | null }>
  const list = Array.isArray(agents) ? agents : (agents.agents ?? [])
  agentFolder = list.find((a) => a.id === 'e2e')!.folder!
})

test("the endpoint serves the wake turn's reply, and the page shows it as a card in the activity", async ({ page, request }) => {
  const key = `folder:${agentFolder}/${TASKS_PLAN_SLUG}/tasks/l8`
  const r = (await (await request.get(`${srv.url}/api/tasks/feed?key=${encodeURIComponent(key)}&token=${srv.token}`)).json()) as {
    items: Array<{ via: string; agent: string | null; texts: string[] }>
  }
  expect(r.items).toHaveLength(1)
  expect(r.items[0]).toMatchObject({ via: 'wake', agent: 'web' })
  expect(r.items[0]!.texts).toHaveLength(2)

  await page.goto(`${srv.url}/task/${encodeURIComponent(`folder:${agentFolder}/${TASKS_PLAN_SLUG}`)}/l8?token=${srv.token}`)
  const reply = page.getByTestId('task-reply')
  await expect(reply).toContainText('Escaped the colons in the feed template')
  await expect(reply).toContainText('Web')
  await expect(reply).not.toContainText('Checking the validator first.') // folded = the answer
  await shot(page, 'task-feed-folded.png')
  await page.getByTestId('task-reply-more').click()
  await expect(reply).toContainText('Checking the validator first.')
  await expect(reply.getByTestId('reply-conversation-door')).toBeVisible()
  await shot(page, 'task-feed-unfolded.png')
})

test('the reply card opens ITS conversation', async ({ page }) => {
  await page.goto(`${srv.url}/task/${encodeURIComponent(`folder:${agentFolder}/${TASKS_PLAN_SLUG}`)}/l8?token=${srv.token}`)
  await page.getByTestId('reply-conversation-door').click()
  await expect(page.getByText('RSS feed escaping').first()).toBeVisible()
})
