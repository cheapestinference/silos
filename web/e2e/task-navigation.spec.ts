// task-navigation.spec.ts — moving through tasks against a REAL server,
// over the tasks + hierarchy seed:
//   palette   ⌘K finds a task by plan#id; an operator offers its view
//   address   a view is a URL, a reload keeps it; Org's counter opens it filtered
//   origin    the back link and Esc return to the list a task came from, on a
//             refresh too; previous/next walk it; Done and next settles and moves
//   glyph     a stuck blocked task wears the accent, its cause on hover
//   inbox     Needs you leads with the task's title and its plan#id
// Serial: the last test changes the server (Done and next).
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, openNeedsYou, type E2EServer } from './helpers'

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

const row = (page: Page, ref: string) => page.locator('main').locator(`[data-task="${ref}"]`)
// the rows the view drew, once the plans are read
const refsOf = async (page: Page): Promise<string[]> => {
  const rows = page.locator('main [data-testid="task-row"]')
  await expect(rows.first()).toBeVisible()
  return rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-task') ?? ''))
}
const palette = async (page: Page, q: string) => {
  await page.keyboard.press('Control+k')
  await page.getByRole('textbox', { name: 'search' }).fill(q)
}

test('⌘K: plan#id goes straight to the task; #id finds it; Enter opens it', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByTestId('home-needs-you')).toBeVisible()
  await palette(page, 'public-launch#l8')
  await expect(page.getByTestId('palette-task').first()).toContainText('Fix the RSS feed')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('task-title')).toHaveText('Fix the RSS feed')
  await palette(page, '#l5')
  await expect(page.getByTestId('palette-task').first()).toHaveAttribute('data-task', 'public-launch#l5')
  await page.keyboard.press('Escape')
})

test('⌘K: an operator lists tasks alone and offers its view', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByTestId('home-needs-you')).toBeVisible()
  await palette(page, 'is:untouched')
  await expect(page.locator('[data-testid="palette-task"][data-task="public-launch#l5"]')).toBeVisible()
  await page.getByTestId('palette-task-view').click()
  await expect(page).toHaveURL(/\/tasks\?view=untouched$/)
  await expect(page.getByTestId('preset-untouched')).toHaveAttribute('aria-selected', 'true')
  await palette(page, 'owner:web')
  await page.getByTestId('palette-task-view').click()
  await expect(page).toHaveURL(/\/tasks\?view=open&agent=web$/)
  await expect(row(page, 'docs-site#d2')).toBeVisible()
  await expect(row(page, 'docs-site#d1')).toHaveCount(0)
})

test('a view is an address: it survives a reload, and the URL wins over what is remembered', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('preset-done').click()
  await expect(page).toHaveURL(/view=done/)
  // a link to another view does not touch what is remembered
  await page.goto(`${srv.url}/tasks?view=open&layout=board&agent=web`)
  await expect(page.getByTestId('preset-open')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('layout-board')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('board-col-blocked')).toContainText('Embed the demo in the README')
  await expect(page.locator('main').getByText('Write the launch post')).toHaveCount(0)
  await page.reload()
  await expect(page).toHaveURL(/view=open&layout=board&agent=web/)
  await page.goto(`${srv.url}/tasks`)
  await expect(page.getByTestId('preset-done')).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('preset-open').click()
  await page.getByTestId('layout-list').click()
})

test("Org's counter opens the tasks it counted, and the view says the way back", async ({ page }) => {
  await page.goto(`${srv.url}/map/org?token=${srv.token}`)
  await page.locator('[data-testid="org-node"][data-agent="web"]').getByTestId('org-open-tasks').click()
  await expect(page).toHaveURL(/\/tasks\?view=open&agent=web&from=org$/)
  await expect(page.getByTestId('tasks-back')).toHaveText('Org')
  // a task from there: the view is its way back, and the view keeps Org's
  await row(page, 'docs-site#d2').click()
  await expect(page.getByTestId('task-back')).toContainText('Tasks · Open · Web')
  await page.getByTestId('task-back').click()
  await expect(page.getByTestId('tasks-back')).toHaveText('Org')
  await page.getByTestId('tasks-back').click()
  await expect(page).toHaveURL(/\/map\/org$/)
})

test("a plan's name in the sidebar opens its open tasks; the chevron only folds", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('silos.sidebar.list', 'tasks')
    window.localStorage.setItem('silos.sidebar.tasks.expanded', '[]')
  })
  await page.goto(`${srv.url}/tasks?view=mine&token=${srv.token}`)
  const docs = page.locator('[data-testid="sidebar-plan"][data-plan="docs-site"]')
  await docs.getByTestId('sidebar-plan-fold').click()
  await expect(page).toHaveURL(/view=mine/)
  await docs.getByTestId('sidebar-plan-fold').click()
  await docs.getByTestId('sidebar-plan-open').click()
  await expect(page).toHaveURL(/view=open&plan=/)
  await expect(docs).toHaveAttribute('data-open', 'true')
  await expect(row(page, 'docs-site#d2')).toBeVisible()
  await expect(row(page, 'public-launch#l8')).toHaveCount(0)
})

test('the origin: Needs you is the way back, Esc too, and a refresh keeps it', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const inbox = await openNeedsYou(page)
  await inbox.locator('li', { hasText: 'Choose the docs theme' }).getByRole('button', { name: 'Open task' }).click()
  await expect(page.getByTestId('task-back')).toHaveText('Needs you')
  await page.reload()
  await expect(page.getByTestId('task-back')).toHaveText('Needs you')
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/\?sheet=needs-you$/)
  await expect(page.getByTestId('sheet-needs-you')).toBeVisible()
  // Esc closes the sheet, and the address follows
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('sheet-needs-you')).toHaveCount(0)
  await expect(page.locator('main')).toBeVisible()
})

test('previous and next walk the list it came from, by button and by key; typing never walks', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?view=untouched&layout=list&token=${srv.token}`)
  const refs = await refsOf(page)
  expect(refs.length).toBeGreaterThan(1)
  await row(page, refs[0]!).click()
  const walk = page.getByTestId('task-neighbours')
  await expect(walk).toContainText(`1 of ${refs.length}`)
  await expect(page.getByTestId('task-prev')).toBeDisabled()
  await page.getByTestId('task-next').click()
  await expect(walk).toContainText(`2 of ${refs.length}`)
  await page.keyboard.press('[')
  await expect(walk).toContainText(`1 of ${refs.length}`)
  await page.keyboard.press('j')
  await expect(walk).toContainText(`2 of ${refs.length}`)
  await page.getByTestId('task-note-box').focus()
  await page.keyboard.type('k]')
  await expect(walk).toContainText(`2 of ${refs.length}`)
  await page.getByTestId('task-note-box').fill('')
  await page.getByTestId('task-back').click()
  await expect(page).toHaveURL(/view=untouched/)
})

test("a conversation's task door comes back to the conversation", async ({ page }) => {
  await page.goto(`${srv.url}/agent/e2e/c/${encodeURIComponent('-tmp-e2e-tasks')}/tasks-live-1?token=${srv.token}`)
  await page.getByTestId('conversation-task').click()
  await expect(page.getByTestId('task-title')).toHaveText('Write the launch post')
  await expect(page.getByTestId('task-back')).toContainText('Launch post draft')
  await expect(page.getByTestId('task-neighbours')).toHaveCount(0)
  await page.getByTestId('task-back').click()
  await expect(page).toHaveURL(/\/c\/-tmp-e2e-tasks\/tasks-live-1/)
})

test('a stuck blocked task wears the accent with its cause; the Blocked column says how many need you', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?view=open&layout=board&agent=web&token=${srv.token}`)
  const card = page.getByTestId('board-col-blocked').locator('[data-task="public-launch#l5"]')
  const glyph = card.locator('[data-glyph="blocked"]')
  await expect(glyph).toHaveAttribute('data-attention', 'true')
  await expect(glyph).toHaveAttribute('title', /dropped/)
  await expect(page.getByTestId('board-blocked-need')).toBeVisible()
})

test("Needs you leads with the task: the tile's line and the sheet's row", async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const tile = page.getByTestId('home-needs-you')
  await expect(tile).toContainText('Proofread the post')
  await expect(tile).not.toContainText('Yours in the plan')
  const inbox = await openNeedsYou(page)
  const gate = inbox.locator('li', { hasText: 'Choose the docs theme' })
  await expect(gate.getByTestId('task-row-facts')).toContainText('docs-site#d1')
  await expect(gate.locator('[data-glyph]')).toHaveAttribute('data-glyph', 'pending')
})

test("Done and next settles the owner's task and opens the next one", async ({ page }) => {
  await page.goto(`${srv.url}/tasks?view=mine&layout=list&agent=__you__&token=${srv.token}`)
  const refs = await refsOf(page)
  expect(refs.length).toBe(2)
  await row(page, refs[0]!).click()
  const firstTitle = await page.getByTestId('task-title').textContent()
  await page.locator('main aside').getByTestId('task-done-next').click()
  await expect(page.getByTestId('task-title')).not.toHaveText(firstTitle!)
  await expect(page.getByTestId('task-back')).toContainText('Tasks · Yours')
  // the last one has nothing next: plain Done
  await expect(page.locator('main aside').getByTestId('task-done-next')).toHaveCount(0)
  await page.getByTestId('task-back').click()
  await expect(row(page, refs[0]!)).toHaveCount(0)
  await expect(row(page, refs[1]!)).toBeVisible()
})
