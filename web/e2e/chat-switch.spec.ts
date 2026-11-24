// chat-switch.spec.ts — switching conversations in chat mode replaces the
// transcript; it never stacks the previous one. Real-bundle regression for
// a real bug: Transcript and Composer shared one key
// (`folder/id`) as siblings, so React left the old Transcript's DOM behind
// on every switch — conversations piled up in the same view until a full
// reload. The jsdom twin is web/test/chat-switch.test.tsx; this spec also
// covers live JSONL growth (delta refetch dedupe) across switches.
import { test, expect } from './helpers'
import { startServer, cleanupTempDirs, type E2EServer } from './helpers'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test('switching conversations in chat: the previous transcript never lingers', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  // open UX conversation
  await page.locator('aside').first().getByText('Greeting helper').first().click()
  await expect(page.locator('main').getByText('add a helper to format greetings')).toBeVisible()
  // open API conversation
  await page.locator('aside').first().getByText('Flaky test triage').first().click()
  await expect(page.locator('main').getByText('trace the flaky test and fix it')).toBeVisible()
  // the UX conversation's content must be gone
  await expect(page.locator('main').getByText('add a helper to format greetings')).toHaveCount(0)
})

test('live JSONL growth: turns appear once, and never survive a switch', async ({ page }) => {
  const apiFile = join(srv.root, '-tmp-e2e-api', 'api1.jsonl')
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await page.locator('aside').first().getByText('Flaky test triage').first().click()
  await expect(page.locator('main').getByText('trace the flaky test and fix it')).toBeVisible()

  // simulate a live console writing new exchanges while the view is open
  for (let i = 1; i <= 3; i++) {
    const lines = [
      { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: `live follow-up ${i}` } },
      { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `live reply ${i}` }] } },
    ]
    appendFileSync(apiFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    await expect(page.locator('main').getByText(`live reply ${i}`)).toBeVisible({ timeout: 10_000 })
  }
  // no duplicates: each live turn appears exactly once
  for (let i = 1; i <= 3; i++) {
    await expect(page.locator('main').getByText(`live reply ${i}`)).toHaveCount(1)
    await expect(page.locator('main').getByText(`live follow-up ${i}`)).toHaveCount(1)
  }
  // the original turns didn't duplicate either
  await expect(page.locator('main').getByText('trace the flaky test and fix it')).toHaveCount(1)

  // now switch away: none of the api conversation's content may linger
  await page.locator('aside').first().getByText('Greeting helper').first().click()
  await expect(page.locator('main').getByText('add a helper to format greetings')).toBeVisible()
  await expect(page.locator('main').getByText('live reply 1')).toHaveCount(0)
  await expect(page.locator('main').getByText('trace the flaky test and fix it')).toHaveCount(0)

  // and back again: still exactly one copy of everything
  await page.locator('aside').first().getByText('Flaky test triage').first().click()
  await expect(page.locator('main').getByText('trace the flaky test and fix it')).toHaveCount(1)
  await expect(page.locator('main').getByText('live reply 3')).toHaveCount(1)
})
