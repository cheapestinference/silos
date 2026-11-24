// task-fit.spec.ts — the first day and the task-fit surfaces of the web:
//   first day  an install with no task: Tasks says «Nothing here yet. Give an agent something to do.», and
//              ⌘K «new task: …» creates the project's plans/tasks.plan.json
//   moves      «Moves on its own» on the task page and New task's sentence
//              under «For»
//   unlink     «Unlink…» only on a CURRENT conversation of a task
//   home lines the quiet task lines (waitsStart, comingToYou, idle) and the
//              sidebar's ◷/⟳ marks — fed by the server; injected here where
//              the seeded server predates them
// Screenshots when TASK_FIT_SHOTS names a folder.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, TASKS_PLAN_SLUG, type E2EServer } from './helpers'

const SHOTS = process.env.TASK_FIT_SHOTS ?? null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS, name) })
}

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 860 } })
test.afterAll(() => cleanupTempDirs())

test.describe('the first day', () => {
  let srv: E2EServer
  test.beforeAll(async () => {
    srv = await startServer()
  })
  test.afterAll(async () => {
    await srv.stop()
  })

  test('no task yet: New task is in the header and the empty list says how to start; ⌘K creates the standing list', async ({ page }) => {
    // the install as the first day finds it: no plan task anywhere (the
    // seeded server has some — the reading is emptied; the writes are real)
    let empty = true
    await page.route(/\/api\/silos\/plans\/records/, async (route) => {
      if (!empty) return route.continue()
      await route.fulfill({
        json: {
          silo: { id: 'plans', name: 'Plans', state: 'active', freshness: null },
          kind: { name: 'plan/task', states: [], columns: [], facets: [] },
          total: 0,
          matching: 0,
          offset: 0,
          limit: 200,
          said: null,
          unreadable: { count: 0, items: [] },
          records: [],
        },
      })
    })
    await page.goto(`${srv.url}/tasks?token=${srv.token}`)
    await expect(page.getByTestId('tasks-empty')).toContainText('Nothing here yet. Give an agent something to do.')
    await expect(page.getByTestId('new-task')).toBeVisible()
    await shot(page, 'tasks-empty.png')
    await page.keyboard.press('Control+k')
    await page.getByRole('textbox', { name: 'search' }).fill('new task: Renew the domain @e2e')
    await page.keyboard.press('Enter')
    const dialog = page.getByTestId('new-task-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'What to do' })).toHaveValue('Renew the domain')
    empty = false
    await dialog.getByTestId('give-later').click()
    await expect(page).toHaveURL(/\/task\//)
    await expect(page.getByTestId('task-title')).toHaveText('Renew the domain')
    const r = await fetch(`${srv.url}/api/agents?token=${srv.token}`)
    const body = (await r.json()) as { agents: Array<{ folder: string | null }> }
    const folders = [...new Set(body.agents.flatMap((a) => (a.folder ? [a.folder] : [])))]
    const lists = folders.map((f) => join(f, 'plans', 'tasks.plan.json')).filter((f) => existsSync(f))
    expect(lists.some((f) => readFileSync(f, 'utf8').includes('Renew the domain'))).toBe(true)
    await shot(page, 'first-task-page.png')
  })
})

test.describe('with tasks', () => {
  let srv: E2EServer
  let agentFolder = ''
  test.beforeAll(async () => {
    srv = await startServer({ tasks: true, taskMode: true })
    const r = await fetch(`${srv.url}/api/agents?token=${srv.token}`)
    const body = (await r.json()) as { agents: Array<{ id: string; folder: string | null }> }
    agentFolder = body.agents.find((a) => a.id === 'e2e')!.folder!
  })
  test.afterAll(async () => {
    await srv.stop()
  })

  // what a server with the task-fit surfaces adds, for the seeded one that predates it
  async function inject(page: Page): Promise<void> {
    await page.route(/\/api\/agents(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const res = await route.fetch()
      const body = (await res.json()) as { agents: Array<Record<string, unknown>> }
      // the derived control: web On its own, the rest told
      const moves: Record<string, Record<string, unknown>> = { web: { controlNow: 'own' }, e2e: { controlNow: 'told' } }
      for (const a of body.agents) Object.assign(a, moves[String(a.id)] ?? { controlNow: 'told' })
      await route.fulfill({ response: res, json: body })
    })
    await page.route(/\/api\/board(\?.*)?$/, async (route) => {
      const res = await route.fetch()
      const body = (await res.json()) as { inbox?: Array<Record<string, unknown>> }
      const key = (id: string): string => `folder:${agentFolder}/${TASKS_PLAN_SLUG}/tasks/${id}`
      // the lines are the test's: the seeded server's own task lines (which
      // now follow web's real control) give way to them
      body.inbox = [
        ...(body.inbox ?? []).filter((r) => r.kind !== 'taskLine'),
        {
          kind: 'taskLine',
          line: 'waitsStart',
          count: 2,
          keys: [key('l7'), key('l3')],
          door: '/tasks?view=start',
          key: 'line:waitsStart',
          urgency: 'routine',
          at: 0,
          voice: '',
          clears: '',
        },
        {
          kind: 'taskLine',
          line: 'comingToYou',
          count: 1,
          keys: [key('l3')],
          door: '/tasks?view=mine',
          items: [{ key: key('l3'), ref: `${TASKS_PLAN_SLUG}#l3`, title: 'Proofread the post', owner: 'owner', says: 'after Write the launch post' }],
          key: 'line:comingToYou',
          urgency: 'routine',
          at: 0,
          voice: '',
          clears: '',
        },
        {
          kind: 'taskLine',
          line: 'idle',
          count: 1,
          keys: [key('l8')],
          door: '/tasks?view=idle',
          key: 'line:idle',
          urgency: 'routine',
          at: 0,
          voice: '',
          clears: '',
        },
        {
          kind: 'tasksStalled',
          count: 3,
          keys: [],
          door: '/tasks?view=untouched',
          agentIds: ['e2e'],
          key: 'tasksStalled',
          urgency: 'due',
          at: Date.now() - 600_000,
          voice: '3 tasks stalled',
          clears: '',
        },
      ]
      await route.fulfill({ response: res, json: body })
    })
  }

  test("Home: the quiet task lines and the sidebar's marks", async ({ page }) => {
    await inject(page)
    await page.goto(`${srv.url}/?token=${srv.token}`)
    await expect(page.getByTestId('agent-moves').first()).toBeVisible()
    await shot(page, 'home-lines.png')
    // the tasks nobody is on: a line of the Working now sheet, opened from the pulse
    await page.getByTestId('pulse-working').or(page.getByTestId('working-now-door')).click()
    await expect(page.getByTestId('working-idle-row')).toHaveText('1 task not started — nobody is on it ›')
    await page.keyboard.press('Escape')
    // your own tasks' list holds the quiet lines: waiting for you to start, coming to you
    await page.getByTestId('yours-all').or(page.getByTestId('yours-more')).first().click()
    await expect(page.getByTestId('yours-lines')).toBeVisible()
    await expect(page.getByTestId('yours-waits-start-row').first()).toHaveText('2 tasks not started — they open with you ›')
    await page.getByTestId('yours-coming-fold').getByRole('button').first().click()
    await expect(page.getByTestId('yours-coming-fold')).toContainText('after Write the launch post')
    await shot(page, 'home-yours-sheet.png')
  })

  test('New task says what assigning will do; the task page carries «Moves on its own» and «Unlink…» on its current rows', async ({ page }) => {
    await inject(page)
    await page.goto(`${srv.url}/tasks?token=${srv.token}`)
    await page.getByTestId('new-task').click()
    const dialog = page.getByTestId('new-task-dialog')
    await dialog.getByLabel('What to do').fill('Write the changelog')
    await dialog.locator('#nt-owner').selectOption('e2e')
    // what will happen, said under «For» and on the button
    await expect(page.getByTestId('give-line')).toBeVisible()
    await expect(page.getByTestId('give-primary')).toHaveText(/^(Give to E2E|Give and open (console|chat) ›)$/)
    await shot(page, 'new-task-moves.png')
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    await page.goto(`${srv.url}/task/${encodeURIComponent(`folder:${agentFolder}/${TASKS_PLAN_SLUG}`)}/l8?token=${srv.token}`)
    await expect(page.getByTestId('task-title')).toHaveText('Fix the RSS feed')
    await expect(page.locator('[data-testid="task-moves"]:visible')).toBeVisible()
    const unlink = page.getByTestId('task-unlink')
    if ((await unlink.count()) > 0) {
      await unlink.first().click()
      await expect(page.getByTestId('unlink-sheet')).toBeVisible()
    }
    await shot(page, 'task-page-moves-unlink.png')
  })
})
