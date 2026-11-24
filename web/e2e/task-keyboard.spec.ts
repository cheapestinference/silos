// task-keyboard.spec.ts — keyboard and task-page details against a REAL
// server, over the tasks + hierarchy seed:
//   keyboard  j k Enter Esc d n g ? in Tasks, the Needs you sheet and a task's page,
//             never while typing; the ring only when the keyboard put it there
//   held      the order does not move under the cursor; Esc lets it settle
//   new       an agent's note turns a row semibold, on every surface; opening clears
//             it; the mark is on the server, not in the browser or the plan
//   card      a reference's hover card
//   org       a dot beside the agent working now
//   pulse     the subtitle counts what the list shows
// Serial: these change the plans on disk, as an agent and as the owner.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, openNeedsYou, touchTasksLive, type E2EServer } from './helpers'

let srv: E2EServer

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ tasks: true, taskMode: true, hierarchy: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1440, height: 900 } })

interface PlanFile {
  tasks: Array<{ id: string; status: string; notes?: unknown[] }>
}
const planPath = (slug: string, agent: string): string => {
  const agents = JSON.parse(readFileSync(join(srv.dataDir, 'agents.json'), 'utf8')) as { agents: Array<{ id: string; folder: string }> }
  return join(agents.agents.find((a) => a.id === agent)!.folder, 'plans', `${slug}.plan.json`)
}
const readPlan = (slug: string, agent: string): PlanFile => JSON.parse(readFileSync(planPath(slug, agent), 'utf8')) as PlanFile
// an agent writes in its plan, the way team-plan does
const agentNote = (slug: string, agent: string, id: string, text: string): void => {
  const plan = readPlan(slug, agent)
  const t = plan.tasks.find((x) => x.id === id)!
  t.notes = [...(t.notes ?? []), { at: new Date().toISOString(), by: agent, text }]
  writeFileSync(planPath(slug, agent), JSON.stringify(plan, null, 2) + '\n')
}

const row = (page: Page, ref: string) => page.locator(`main [data-task="${ref}"]`)
const refsOf = async (page: Page): Promise<string[]> => {
  const rows = page.locator('main [data-testid="task-row"]')
  await expect(rows.first()).toBeVisible()
  return rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-task') ?? ''))
}
const ringed = (page: Page) => page.locator('[data-nav-row][data-cursor="key"]')
const LIST = '/tasks?view=open&layout=list&agent=e2e'

test('the subtitle counts what the list shows', async ({ page }) => {
  await page.goto(`${srv.url}${LIST}&token=${srv.token}`)
  const refs = await refsOf(page)
  await expect(page.getByTestId('tasks-pulse')).toContainText(`${refs.length} open in 1 plan`)
})

test('j k and Enter: the ring walks the rows, Enter opens, Esc comes back to the same row', async ({ page }) => {
  await page.goto(`${srv.url}${LIST}&token=${srv.token}`)
  const refs = await refsOf(page)
  await expect(ringed(page)).toHaveCount(0)
  await page.keyboard.press('j')
  await expect(ringed(page)).toHaveAttribute('data-task', refs[0]!)
  await page.keyboard.press('j')
  await page.keyboard.press('ArrowDown')
  await expect(ringed(page)).toHaveAttribute('data-task', refs[2]!)
  await page.keyboard.press('k')
  await expect(ringed(page)).toHaveAttribute('data-task', refs[1]!)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('task-back')).toContainText('Tasks')
  await page.keyboard.press('Escape')
  await expect(ringed(page)).toHaveAttribute('data-task', refs[1]!)
  // Esc lets go of the row; a second has nowhere to go from a plain view
  await page.keyboard.press('Escape')
  await expect(ringed(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/tasks\?/)
})

test('the hover never paints the ring, and a resting mouse settles nothing', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?view=mine&layout=list&agent=__you__&token=${srv.token}`)
  const refs = await refsOf(page)
  const before = JSON.stringify(readPlan('docs-site', 'web'))
  await row(page, refs[0]!).hover()
  await expect(ringed(page)).toHaveCount(0)
  await page.keyboard.press('d')
  await page.waitForTimeout(150)
  expect(JSON.stringify(readPlan('docs-site', 'web'))).toBe(before)
  await expect(row(page, refs[0]!)).toBeVisible()
})

test('typing never fires: a note takes its letters; n opens it, Esc leaves it, the page stays', async ({ page }) => {
  await page.goto(`${srv.url}${LIST}&token=${srv.token}`)
  const refs = await refsOf(page)
  await row(page, refs[0]!).click()
  const walk = page.getByTestId('task-neighbours')
  await expect(walk).toContainText(`1 of ${refs.length}`)
  const box = page.getByTestId('task-note-box')
  await expect(box).toBeVisible()
  await page.keyboard.press('n')
  await expect(box).toBeFocused()
  await expect(box).toHaveValue('')
  await page.keyboard.type('jkdng?')
  await expect(box).toHaveValue('jkdng?')
  await expect(walk).toContainText(`1 of ${refs.length}`)
  await expect(page.getByTestId('key-help')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(box).not.toBeFocused()
  await expect(page.getByTestId('task-title')).toBeVisible()
  await box.fill('')
  await page.keyboard.press('Escape') // leaves the box again
  await page.keyboard.press('Escape') // and now back
  await expect(page).toHaveURL(/\/tasks\?/)
})

test('g h, g t, and ? with Esc closing only the list of keys', async ({ page }) => {
  await page.goto(`${srv.url}${LIST}&token=${srv.token}`)
  await refsOf(page)
  await page.keyboard.press('?')
  await expect(page.getByTestId('key-help')).toBeVisible()
  // nothing walks under it
  await page.keyboard.press('j')
  await expect(ringed(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('key-help')).toHaveCount(0)
  await expect(page).toHaveURL(/\/tasks\?/)
  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(page.getByTestId('home-needs-you')).toBeVisible()
  const inbox = await openNeedsYou(page)
  await expect(inbox).toBeVisible()
  await page.keyboard.press('g')
  await page.keyboard.press('t')
  await expect(page).toHaveURL(/\/tasks/)
})

test("held: an agent's note does not move the rows under the cursor, it turns its row semibold; Esc lets the order settle", async ({ page }) => {
  await page.goto(`${srv.url}${LIST}&token=${srv.token}`)
  const refs = await refsOf(page)
  const last = refs[refs.length - 1]!
  await page.keyboard.press('j')
  await expect(ringed(page)).toHaveAttribute('data-task', refs[0]!)
  agentNote('public-launch', 'e2e', last.split('#')[1]!, 'Looked at it. Next: nothing until Monday.')
  // the note arrived (the weight says so) and nothing moved
  await expect(row(page, last)).toHaveAttribute('data-new', 'true', { timeout: 15_000 })
  await expect(row(page, last).locator('button').first().locator('span.font-semibold')).toBeVisible()
  expect(await refsOf(page)).toEqual(refs)
  await expect(ringed(page)).toHaveAttribute('data-task', refs[0]!)
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await refsOf(page))[0]).toBe(last)
})

test('new to you: every surface, cleared by opening, and the mark outlives the browser', async ({ page, context }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('silos.sidebar.list', 'tasks')
  })
  await page.goto(`${srv.url}${LIST}&token=${srv.token}`)
  const refs = await refsOf(page)
  const fresh = page.locator('main [data-task][data-new="true"]')
  await expect(fresh).toHaveCount(1)
  const ref = await fresh.getAttribute('data-task')
  expect(refs[0]).toBe(ref)
  await row(page, ref!).click()
  await expect(page.getByTestId('task-title')).toBeVisible()
  await expect
    .poll(
      () =>
        (JSON.parse(readFileSync(join(srv.dataDir, 'task-seen.json'), 'utf8')) as { seen: Record<string, unknown> }).seen[
          `folder:${planPath('public-launch', 'e2e').replace('/plans/public-launch.plan.json', '')}/public-launch/tasks/${ref!.split('#')[1]}`
        ],
    )
    .toBeTruthy()
  // a mark is never written into the plan
  expect(readFileSync(planPath('public-launch', 'e2e'), 'utf8')).not.toContain('seen')
  // another browser, with nothing stored: still seen
  await context.clearCookies()
  await page.evaluate(() => window.localStorage.clear())
  await page.goto(`${srv.url}${LIST}&token=${srv.token}`)
  await refsOf(page)
  await expect(fresh).toHaveCount(0)
})

test("new to you reaches Needs you, and the owner's own note does not count", async ({ page }) => {
  agentNote('public-launch', 'e2e', 'l3', 'The draft is ready for you.')
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const tile = page.getByTestId('home-needs-you')
  await expect(tile.locator('[data-task-words][data-new="true"]', { hasText: 'Proofread the post' })).toBeVisible({ timeout: 15_000 })
  const inbox = await openNeedsYou(page)
  const line = inbox.locator('li', { hasText: 'Proofread the post' })
  await expect(line.locator('[data-new="true"]')).toBeVisible()
  await line.getByRole('button', { name: 'Open task' }).click()
  await expect(page.getByTestId('task-title')).toHaveText('Proofread the post')
  // writes its own note: still not new when it goes back
  const box = page.getByTestId('task-note-box')
  await box.fill('Reading it tonight.')
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByTestId('task-activity')).toContainText('Reading it tonight.')
  await page.getByTestId('task-back').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('sheet-needs-you')).toBeVisible()
  await expect(inbox.locator('li', { hasText: 'Proofread the post' }).locator('[data-new="true"]')).toHaveCount(0)
})

test('the Needs you sheet: j and k walk its rows, Esc closes the sheet', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const inbox = await openNeedsYou(page)
  await expect(inbox.locator('li').first()).toBeVisible()
  await page.keyboard.press('j')
  await expect(ringed(page)).toBeVisible()
  const first = await ringed(page).getAttribute('data-nav-row')
  await page.keyboard.press('j')
  await expect(ringed(page)).not.toHaveAttribute('data-nav-row', first!)
  await page.keyboard.press('k')
  await expect(ringed(page)).toHaveAttribute('data-nav-row', first!)
  // Esc belongs to the sheet: it closes
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('sheet-needs-you')).toHaveCount(0)
})

test('the card on a reference: hover Blocked by, state and last note; Esc takes it away and stays', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?view=open&layout=list&agent=e2e&token=${srv.token}`)
  await row(page, 'public-launch#l7').click()
  await expect(page.getByTestId('task-title')).toHaveText('Publish on the blog')
  const peek = page.getByTestId('task-peek')
  await expect(peek).toHaveCount(0)
  await page.locator('main aside [data-testid="task-link"]').first().hover()
  await expect(peek).toBeVisible()
  await expect(peek).toContainText('Fix the RSS feed')
  await expect(peek).toContainText('public-launch#l8')
  await page.keyboard.press('Escape')
  await expect(peek).toHaveCount(0)
  await expect(page.getByTestId('task-title')).toHaveText('Publish on the blog')
})

test('a plan#id inside a note is a door with its card; one no task has stays plain text', async ({ page }) => {
  agentNote('public-launch', 'e2e', 'l10', 'Needs public-launch#l8 first, and nothing-here#z9 is not a task.')
  await page.goto(`${srv.url}/tasks?view=done&layout=list&agent=e2e&token=${srv.token}`)
  await row(page, 'public-launch#l10').click()
  const door = page.getByTestId('note-task-ref')
  await expect(door).toHaveText('public-launch#l8', { timeout: 15_000 })
  await expect(page.getByTestId('task-activity')).toContainText('nothing-here#z9 is not a task')
  await door.hover()
  await expect(page.getByTestId('task-peek')).toContainText('Fix the RSS feed')
  await door.click()
  await expect(page.getByTestId('task-title')).toHaveText('Fix the RSS feed')
})

test('Org: a dot beside the agent working now, none beside the others', async ({ page }) => {
  touchTasksLive(srv.root)
  await page.goto(`${srv.url}/map/org?token=${srv.token}`)
  await expect(page.locator('[data-testid="org-node"][data-agent="e2e"]').getByTestId('org-working')).toBeVisible()
  await expect(page.locator('[data-testid="org-node"][data-agent="finance"]').getByTestId('org-working')).toHaveCount(0)
})

test("d settles a task of yours, the row keeps its gap and the cursor goes on; never an agent's", async ({ page }) => {
  // an agent's task: nothing happens to its file
  await page.goto(`${srv.url}/tasks?view=open&layout=list&agent=web&token=${srv.token}`)
  await refsOf(page)
  const before = JSON.stringify(readPlan('docs-site', 'web').tasks.map((t) => t.status))
  await page.keyboard.press('j')
  await expect(ringed(page)).toBeVisible()
  await page.keyboard.press('d')
  await page.waitForTimeout(150)
  expect(JSON.stringify(readPlan('docs-site', 'web').tasks.map((t) => t.status))).toBe(before)
  await page.keyboard.press('Escape')

  // the owner's: done on disk, its row dimmed in its place, then gone
  await page.goto(`${srv.url}/tasks?view=mine&layout=list&agent=__you__&token=${srv.token}`)
  const refs = await refsOf(page)
  expect(refs.length).toBeGreaterThan(1)
  await page.keyboard.press('j')
  await page.keyboard.press('d')
  await expect(ringed(page)).toHaveAttribute('data-task', refs[1]!)
  await expect(row(page, refs[0]!)).toHaveAttribute('data-gone', 'true')
  const [slug, id] = refs[0]!.split('#') as [string, string]
  const owner = slug === 'docs-site' ? 'web' : 'e2e'
  expect(readPlan(slug, owner).tasks.find((t) => t.id === id)!.status).toBe('done')
  await expect(row(page, refs[0]!)).toHaveCount(0, { timeout: 8_000 })
  await expect(ringed(page)).toHaveAttribute('data-task', refs[1]!)
})

test("in the sheet, d is the row's own Done; a row with no Done settles nothing", async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await openNeedsYou(page)
  const sheet = page.getByTestId('sheet-needs-you')
  const total = await sheet.locator('[data-nav-row]').count()
  // walk to the row that has a Done of its own
  let done = false
  for (let i = 0; i < total && !done; i++) {
    await page.keyboard.press('j')
    done = (await ringed(page).locator('[data-nav-done]').count()) > 0
  }
  expect(done).toBe(true)
  const key = (await ringed(page).getAttribute('data-nav-row'))!
  await page.keyboard.press('d')
  await expect(sheet.locator(`[data-nav-row="${key}"]`)).toHaveAttribute('data-gone', 'true')
  await expect(sheet.locator(`[data-nav-row="${key}"]`)).toHaveCount(0, { timeout: 8_000 })
})
