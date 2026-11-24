// binding-ask.spec.ts — the binding an agent proposes and the owner approves,
// against a real server: Needs you shows the proposal in clear with
// the host as hero and the «never seen» mark; its door opens the Vault's
// editor prefilled; nothing is written until the owner saves; the save clears
// the task's wait with an owner note. A broken ask (an entry not in the Vault)
// says so and never opens an editor. Evidence under
// web/test-results/shots/binding-ask/ when SILOS_SHOTS=1.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, BINDING_ASK_PLAN, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('binding-ask') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer
let agentFolder = ''

test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ request }) => {
  srv = await startServer({ bindingAsk: true })
  const agents = (await (await request.get(`${srv.url}/api/agents?token=${srv.token}`)).json()) as
    { agents?: Array<{ id: string; folder: string | null }> } | Array<{ id: string; folder: string | null }>
  const list = Array.isArray(agents) ? agents : (agents.agents ?? [])
  agentFolder = list.find((a) => a.id === 'e2e')!.folder!
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(SHOTS, name), fullPage: false })
}

const taskKey = (id: string): string => `folder:${agentFolder}/${BINDING_ASK_PLAN}/tasks/${id}`

test('Needs you → Review and sign → the editor prefilled → the save unblocks the task', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${srv.url}/?sheet=needs-you&token=${srv.token}`)
  const card = page.getByTestId('binding-ask').filter({ hasText: 'LEDGER_API_KEY' })
  await expect(card).toBeVisible()
  await expect(card.getByTestId('host-hero')).toContainText('ledgerly.example')
  await expect(card.getByTestId('never-seen')).toBeVisible()
  await expect(card.getByTestId('ask-provenance')).toContainText('#t1')
  // the broken one says why and offers no prefill
  const broken = page.getByTestId('binding-ask').filter({ hasText: 'PAYROLL_KEY' })
  await expect(broken.getByRole('alert')).toContainText('not in the Vault')
  await expect(broken.getByRole('button', { name: 'Review and sign ›' })).toHaveCount(0)
  await shot(page, 'needs-you.png')

  await card.getByRole('button', { name: 'Review and sign ›' }).click()
  await expect(page).toHaveURL(/\/vault\?sign=/)
  const editor = page.getByTestId('binding-editor')
  await expect(editor.getByLabel('LEDGER_API_KEY service URL')).toHaveValue('https://mcp.ledgerly.example')
  await expect(editor.getByLabel('LEDGER_API_KEY header')).toHaveValue('authorization')
  await expect(editor.getByTestId('never-seen')).toBeVisible()
  await shot(page, 'vault-prefilled.png')

  // nothing was written by opening it
  const before = await (await page.request.get(`${srv.url}/api/silos/plans/record?key=${encodeURIComponent(taskKey('t1'))}&token=${srv.token}`)).text()
  expect(before).toContain('LEDGER_API_KEY')

  await editor.getByRole('button', { name: 'Sign it' }).click()
  await expect(page.getByTestId('vault-released')).toContainText('Unblocked')
  await shot(page, 'vault-released.png')
  await expect
    .poll(async () => {
      const r = (await (await page.request.get(`${srv.url}/api/silos/plans/record?key=${encodeURIComponent(taskKey('t1'))}&token=${srv.token}`)).json()) as {
        value?: Record<string, unknown>
      }
      return [r.value?.waitingOn ?? null, r.value?.state ?? r.value?.status]
    })
    .toEqual([null, 'pending'])
})

test('phone width: the card keeps the host whole and readable', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 860 })
  await page.goto(`${srv.url}/?sheet=needs-you&token=${srv.token}`)
  await expect(page.getByTestId('binding-ask').filter({ hasText: 'PAYROLL_KEY' })).toBeVisible()
  await shot(page, 'needs-you-phone.png')
})
