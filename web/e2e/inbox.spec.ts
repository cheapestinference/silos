// inbox.spec.ts — the server-composed Needs you
// against a REAL server: the harness seeds 'Weekly digest' (agent UX) with a
// run the API refused (400) — a failure that enters at once. Home draws the
// row the server composed; it opens the automation's one home; Seen acks THAT
// run and survives a reload (needs-you-acks.json). Serial: Seen changes the
// server. Evidence screenshots in web/test-results/shots/needs-you/ when
// SILOS_SHOTS=1.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, E2E_PROPOSAL_ID, openNeedsYou, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('needs-you') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ proposals: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1440, height: 900 } })

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.screenshot({
    path: join(SHOTS, name),
    maskColor: '#8f8d86',
    mask: [page.getByRole('button', { name: 'Settings' }).locator('xpath=..')],
  })
}

test('GET /api/board carries the inbox the server composed, with its urgency and its Seen', async () => {
  const res = await fetch(`${srv.url}/api/board?token=${srv.token}`)
  const body = (await res.json()) as { inbox: Array<{ kind: string; urgency: string; voice: string; ack?: { kind: string; key: string; version: string } }> }
  const failed = body.inbox.find((r) => r.kind === 'failedRun')
  expect(failed).toMatchObject({
    urgency: 'due',
    voice: 'Weekly digest failed — the API rejected the request (400) · UX',
    ack: { kind: 'run', key: 'auto-digest', version: 'run-digest-400' },
  })
})

test('Home: the failed run is a Needs you row that opens its automation', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const inbox = await openNeedsYou(page)
  const row = inbox.getByText('Weekly digest', { exact: false }).first()
  await expect(row).toBeVisible()
  await expect(inbox.getByText(/the API rejected the request \(400\)/)).toBeVisible()
  await expect(inbox.getByText(/^UX · failed · /)).toBeVisible()
  await shot(page, 'home-failed-run-row.png')
  await row.click()
  await expect(page).toHaveURL(/\/automation\/auto-digest$/)
})

test('Seen acks THAT run: the row leaves and stays gone after a reload', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const inbox = await openNeedsYou(page)
  await expect(inbox.getByText(/the API rejected the request \(400\)/)).toBeVisible()
  const item = inbox.locator('li', { hasText: 'Weekly digest' })
  await item.getByRole('button', { name: 'Seen' }).click()
  await expect(inbox.getByText(/the API rejected the request \(400\)/)).toHaveCount(0)
  await page.reload()
  await expect(page.locator('main').getByTestId('pulse')).toBeVisible()
  await expect(page.locator('main').getByTestId('home-needs-you')).not.toContainText('Weekly digest')
  // the open sheet is an address (/?sheet=needs-you): a reload keeps it open
  const sheet = page.getByTestId('sheet-needs-you')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText(/the API rejected the request \(400\)/)).toHaveCount(0)
})

// An agent's automation proposal: the UX agent
// proposed a command; Home shows all of it and only «Review ›»; the editor
// opens on the proposal and its create resolves it; the proposal
// leaves the inbox for good.
test('a proposed command: Review opens the editor, Create makes it and resolves the proposal; the row is gone', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const inbox = await openNeedsYou(page)
  const item = inbox.locator('li', { hasText: 'Refresh screenshots' })
  await expect(item).toBeVisible()
  await expect(item.getByText(/^UX · suggests · /)).toBeVisible()
  await expect(inbox.getByTestId('proposal-command')).toContainText('/usr/bin/true shots')
  await expect(item.getByText('“the screenshots must be refreshed before each review”')).toBeVisible()
  await expect(item.getByRole('button', { name: 'Accept' })).toHaveCount(0)
  await shot(page, 'home-automation-proposal-row.png')
  await item.getByRole('button', { name: 'Review ›' }).click()
  await expect(page.getByTestId('editor-review')).toBeVisible()
  await page.getByRole('button', { name: 'Create automation' }).click()
  await expect(page).toHaveURL(/\/automation\/[0-9a-f-]{36}$/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.locator('main').getByText('Refresh screenshots').first()).toBeVisible()
  const res = await fetch(`${srv.url}/api/automations/${id}?token=${srv.token}`)
  expect(((await res.json()) as { automation: { run: { kind: string; argv: string[] } } }).automation.run).toMatchObject({
    kind: 'command',
    argv: ['/usr/bin/true', 'shots'],
  })
  const list = await fetch(`${srv.url}/api/proposals?token=${srv.token}`)
  expect(
    ((await list.json()) as { proposals: Array<{ id: string; state: string; result?: string }> }).proposals.find((p) => p.id === E2E_PROPOSAL_ID),
  ).toMatchObject({ state: 'accepted', result: 'edited and saved by the owner' })
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.locator('main').getByTestId('pulse')).toBeVisible()
  await expect(page.locator('main').getByTestId('home-needs-you')).not.toContainText('Refresh screenshots')
  await expect((await openNeedsYou(page)).getByText('Refresh screenshots')).toHaveCount(0)
})
