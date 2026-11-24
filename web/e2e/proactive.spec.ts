// proactive.spec.ts — the proactive mode end to end
// against a REAL seeded server and a STUB claude on PATH (HOME and TMPDIR
// isolated: no real claude, no real account). Web is On its own (its
// mission, its territory on). On its page the owner picks Proactive on the
// ladder, «Make Web proactive» opens prefilled and says its rounds; made,
// the switch says Proactive and its row its count. «Run now» on Automations
// runs a round on the stub, which creates ONE task of its own from its
// mission through the API (its bearer, its turn): it shows in Decided with
// Undo; undone, the next round's same task is refused («this was undone»)
// and never comes back.
// Screenshots (the ladder in its three positions, the sheet, the rows —
// light and dark) under $SILOS_Q4_SHOTS when it is set.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer } from './helpers'

const SHOTS = process.env.SILOS_Q4_SHOTS ?? null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const TITLE = 'Renew the expiring domain'

let srv: E2EServer & { stubLog?: string }

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ taskMode: true, stubClaude: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1280, height: 900 } })

async function shot(page: Page, name: string, target?: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(250)
  if (target) await page.getByTestId(target).screenshot({ path: join(SHOTS, name) })
  else await page.screenshot({ path: join(SHOTS, name) })
}
// what the stub's rounds answered, in order: 2xx created, 409 refused
const rounds = (): Array<{ status?: number; body?: string; error?: string }> => {
  const f = `${srv.stubLog}.rounds`
  return existsSync(f)
    ? readFileSync(f, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { status?: number; body?: string })
    : []
}
const api = async <T>(path: string): Promise<T> => (await (await fetch(`${srv.url}${path}`, { headers: { 'x-token': srv.token } })).json()) as T
// the heartbeat's run is over: its last fire is no longer running
async function roundOver(after: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const v = await api<{ last: { at: string } | null }>('/api/agents/web/heartbeat')
        return v.last ? Date.parse(v.last.at) >= after : false
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true)
}
// Now: how its unattended work went (Decided, its rounds)
async function openWeb(page: Page): Promise<void> {
  await page.goto(`${srv.url}/agent/web?token=${srv.token}`)
  await expect(page.getByTestId('control')).toBeVisible({ timeout: 15_000 })
}
// its Automations tab: where the ladder, its rhythm and Proactive are set
async function openWebSet(page: Page): Promise<void> {
  await page.goto(`${srv.url}/agent/web/control?token=${srv.token}`)
  await expect(page.getByTestId('control-own')).toBeVisible({ timeout: 15_000 })
}
async function runNow(page: Page): Promise<number> {
  const at = Date.now() - 1000
  await page.goto(`${srv.url}/automations?token=${srv.token}`)
  const row = page.getByTestId('beat-row-web')
  await expect(row).toContainText('Web’s heartbeat · every 3 hours from')
  await shot(page, 'automations-beat-row.png', 'automations-beat-door')
  await row.getByTestId('beat-row-web-run').click()
  await expect(row.getByRole('alert')).toHaveCount(0)
  return at
}

test('Proactive on the ladder: the sheet, a round creates a task, Decided with Undo — undone, it never comes back', async ({ page }) => {
  test.setTimeout(180_000)
  await openWebSet(page)
  const control = page.getByTestId('control')
  await expect(page.getByTestId('control-own')).toHaveAttribute('aria-checked', 'true')
  await shot(page, 'ladder-own-light.png', 'control')

  // Proactive opens «Make Web proactive», prefilled: every 3 hours · 08:00–20:00
  await page.getByTestId('control-proactive').click()
  const sheet = page.getByTestId('proactive-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('heading')).toHaveText('Make Web proactive')
  await expect(page.getByTestId('proactive-sheet-rounds')).toHaveText(/^≈ \d+ rounds a day, from 08:\d\d — each one is a turn$/)
  await expect(page.getByTestId('proactive-sheet-holds')).toContainText('What holds it: its territory, its Never lines')
  await shot(page, 'sheet-light.png')
  await page.getByTestId('proactive-sheet-make').click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByTestId('control-proactive')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('control-sentence')).toContainText('Goes looking for work.')
  await expect(page.getByTestId('control-proactive-row')).toContainText('Up to 5 tasks a day from its mission')
  await shot(page, 'ladder-proactive-light.png', 'control')
  // the marker on the sidebar: Proactive, apart from On its own's ⟳
  await expect(page.locator('[data-testid="agent-moves"][data-position="proactive"]').first()).toBeAttached()

  // a round (Run now on Automations) creates ONE task of its own from its mission
  const first = await runNow(page)
  await expect.poll(() => rounds().length, { timeout: 60_000 }).toBe(1)
  expect(rounds()[0]!.status).toBeLessThan(300)
  await roundOver(first)

  // Decided, with Undo
  await openWeb(page)
  const decided = page.getByTestId('control-decided')
  await expect(decided).toContainText(`Web decided: ${TITLE}`)
  await expect(page.getByTestId('control-made')).toContainText(/decided one thing/)
  // «decided one thing ›» opens what it decided, where its Undo is
  await page.getByTestId('control-made-door').click()
  await expect(decided).toBeFocused()
  await shot(page, 'rows-after-round-light.png', 'control')
  const row = decided.getByTestId('control-decided-row').filter({ hasText: TITLE })
  await row.getByRole('button', { name: 'Undo' }).click()
  await page.getByTestId('control-decided-undo-confirm').click()
  await expect(decided.getByText(`Web decided: ${TITLE}`)).toHaveCount(0)

  // the next round makes the same task: refused — what the owner undid stays undone
  const second = await runNow(page)
  await expect.poll(() => rounds().length, { timeout: 60_000 }).toBe(2)
  expect(rounds()[1]!.status).toBe(409)
  expect(rounds()[1]!.body).toContain('this was undone')
  await roundOver(second)
  await openWeb(page)
  await expect(page.getByTestId('control-made')).toBeVisible()
  await expect(page.getByTestId('control')).not.toContainText(`Web decided: ${TITLE}`)
  expect(control).toBeTruthy()

  // From Proactive, «On its own»: proactive: null — no sheet; then Only when told
  await openWebSet(page)
  await page.getByTestId('control-own').click()
  await expect(page.getByTestId('control-own')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('proactive-sheet')).toHaveCount(0)
  await expect(page.getByTestId('control-proactive-row')).toHaveCount(0)
  await page.getByTestId('control-told').click()
  await expect(page.getByTestId('control-told')).toHaveAttribute('aria-checked', 'true')
  await shot(page, 'ladder-told-light.png', 'control')
})

// The rows' other variants, painted from the server's own shape (a skipped
// fire by its account's margin; a cut agent), and the dark theme — evidence
// only: nothing here is asserted beyond what makes the shot worth taking.
test("shots: the ladder, the sheet and the rows in dark, and the rows' variants", async ({ page }) => {
  test.skip(!SHOTS, 'screenshots only')
  test.setTimeout(90_000)
  const now = new Date()
  const at = (h: number, m: number): string => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).toISOString()
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 22).toISOString()
  for (const dark of [false, true]) {
    // Web proactive again (the first test, and the loop, leave it Only when told)
    await fetch(`${srv.url}/api/agents/web`, {
      method: 'PATCH',
      headers: { 'x-token': srv.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        control: 'own',
        heartbeat: { period: { every: 3, unit: 'hours', between: { from: '08:00', to: '20:00' } } },
        proactive: { perDay: 5, tools: true },
      }),
    })
    const p = await page.context().newPage()
    if (dark) await p.addInitScript(() => window.localStorage.setItem('silos-dark', '1'))
    const suffix = dark ? 'dark' : 'light'
    let cut = false
    await p.route('**/api/agents/web/heartbeat', async (route) => {
      const res = await route.fetch()
      const v = (await res.json()) as Record<string, unknown> & { proactive: Record<string, unknown> | null }
      v.lastTurn = { at: at(14, 22), kind: 'round', created: ['a', 'b'], proposed: [] }
      v.last = {
        at: at(17, 22),
        kind: 'round',
        skipped: "Web's account is at 88% of its 5-hour window — rounds wait so there is room for you",
        cause: 'headroom',
        tools: true,
        readOutside: [],
        summary: null,
        created: [],
        proposed: [],
        tainted: false,
      }
      v.next = tomorrow
      v.beats = { looks: 0, thinks: 0, rounds: 5 }
      if (v.proactive) v.proactive = { ...v.proactive, today: { ...(v.proactive.today as object), made: 2 }, ...(cut ? { off: 'cut' } : {}) }
      await route.fulfill({ response: res, json: v })
    })
    await p.goto(`${srv.url}/agent/web?token=${srv.token}`)
    await expect(p.getByTestId('control-last')).toContainText('Skipped', { timeout: 15_000 })
    await shot(p, `rows-proactive-${suffix}.png`, 'control')
    await p.goto(`${srv.url}/agent/web/control?token=${srv.token}`)
    await expect(p.getByTestId('control-proactive-row')).toBeVisible({ timeout: 15_000 })
    // the editor in proactive: its consequence in rounds
    await p.getByTestId('control-period-change').click()
    await shot(p, `editor-proactive-${suffix}.png`, 'control')
    await p.getByTestId('control-proactive-change').click()
    await expect(p.getByTestId('proactive-sheet')).toBeVisible()
    await shot(p, `sheet-${suffix}.png`)
    await p.keyboard.press('Escape')
    cut = true
    await p.reload()
    await expect(p.getByTestId('control-proactive-row')).toBeVisible({ timeout: 15_000 })
    await shot(p, `rows-cut-${suffix}.png`, 'control')
    // the ladder's other two positions
    await p.getByTestId('control-own').click()
    await expect(p.getByTestId('control-own')).toHaveAttribute('aria-checked', 'true')
    await shot(p, `ladder-own-${suffix}.png`, 'control')
    await p.getByTestId('control-told').click()
    await expect(p.getByTestId('control-told')).toHaveAttribute('aria-checked', 'true')
    await shot(p, `ladder-told-${suffix}.png`, 'control')
    await p.close()
  }
})
