// knows-drawer.spec.ts — the Knows Drawer's acceptance flow (spec
// 2026-10-20-knows-drawer, criterion #1: "the 10-second gesture never
// leaves the conversation"). Real Chromium over the seeded harness
// (helpers.ts):
//   The column's agent rows
//   NAVIGATE to the agent page (‹ <conversation> chip, ?from= in the URL)
//   instead of covering the transcript; these specs pin that journey:
//   1. Files row → the agent page → upload → the chip → the conversation
//      with its unsent draft restored;
//   2. Back returns, a refresh keeps the chip;
//   3. the legacy facet-over-conversation deep link redirects.
// `test`/`expect` from helpers seed chat mode: these specs look at the
// transcript beside the drawer, and the console view wakes an
// idle conversation's claude on open instead of showing its transcript.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, startServer, cleanupTempDirs, type E2EServer } from './helpers'

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
  // the column draws a Knows row only for a kind with something in it (no
  // placeholders) — the 'e2e' agent gets one auto-memory note and
  // one shared file so its Memory and Files rows exist
  const agents = JSON.parse(readFileSync(join(srv.dataDir, 'agents.json'), 'utf8')) as { agents: { id: string; folder: string | null }[] }
  const folder = agents.agents.find((a) => a.id === 'e2e')!.folder!
  const memDir = join(srv.root, folder.replace(/[^A-Za-z0-9]/g, '-'), 'memory')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(
    join(memDir, 'project_parser_bug.md'),
    '---\nname: parser-bug\ndescription: the parser bug lives in src/app.ts\n---\n\nThe parser bug lives in src/app.ts.\n',
  )
  mkdirSync(join(folder, 'context', 'shared'), { recursive: true })
  writeFileSync(join(folder, 'context', 'shared', 'brief.md'), '# Brief\n')
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.use({ viewport: { width: 1440, height: 900 } })

// the seeded 'e2e' agent's conversation s1 (helpers.ts seedSessions)
const S1_PATH = '/agent/e2e/c/-tmp-e2e-project/s1'
const S1_LINE = "I'll take a look."

// an agent thing clicked from a
// conversation NAVIGATES to the agent page — which says where you came from
// (‹ <conversation title>, carried in the URL as ?from=) — and the way back
// returns to the conversation with the unsent draft intact.
test('from a conversation the Files row opens the agent page; the return chip brings the conversation back with its draft', async ({ page }) => {
  await page.goto(`${srv.url}${S1_PATH}?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByText(S1_LINE, { exact: true })).toBeVisible()
  // an unsent draft
  const composer = main.getByLabel('message')
  await composer.fill('half a thought, not sent')

  const column = page.getByRole('complementary').last()
  await column.getByRole('button', { name: 'Open files', exact: true }).click()
  // the agent page, on its Files tab, carrying the way back
  await expect(page).toHaveURL(new RegExp(`/agent/e2e/context\\?from=-tmp-e2e-project/s1$`))
  const index = main.getByRole('navigation', { name: /sections/ })
  await expect(index.getByRole('button', { name: /^Files/ })).toHaveAttribute('aria-current', 'page')
  const chip = main.getByTestId('return-chip')
  await expect(chip).toBeVisible()
  // the transcript is not here — this is the agent's page
  await expect(main.getByText(S1_LINE, { exact: true })).toHaveCount(0)

  const library = main.getByTestId('knows-library')
  await library.getByRole('button', { name: 'Upload' }).click()
  // its own file: on the agent page the upload starts on «Agent · E2E» — the
  // narrower reach; sharing in the project is one click away
  const shared = library.getByRole('radio', { name: /^Project · / })
  const priv = library.getByRole('radio', { name: /^Agent · .*E2E/ })
  await expect(priv).toHaveAttribute('aria-checked', 'true')
  await shared.click()
  await expect(shared).toHaveAttribute('aria-checked', 'true')
  await priv.click()
  await expect(priv).toHaveAttribute('aria-checked', 'true')
  await library.getByLabel('Choose a file').setInputFiles({
    name: 'e2e-brief.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# E2E brief\n\nUploaded from the agent page, reached from a conversation.\n'),
  })
  await expect(library.getByRole('region', { name: 'Agent · 🧪 E2E' }).getByText('e2e-brief.md')).toBeVisible()
  await expect(library.getByTestId('scope-filter')).toBeVisible()

  // the way back: the conversation, its draft restored
  await chip.click()
  await expect(page).toHaveURL(new RegExp(`${S1_PATH}$`))
  await expect(main.getByText(S1_LINE, { exact: true })).toBeVisible()
  await expect(main.getByLabel('message')).toHaveValue('half a thought, not sent')
})

test('the browser Back returns to the conversation; a refresh on the agent page keeps the way back', async ({ page }) => {
  await page.goto(`${srv.url}${S1_PATH}?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByText(S1_LINE, { exact: true })).toBeVisible()
  const column = page.getByRole('complementary').last()
  await column.getByRole('button', { name: 'Open memory', exact: true }).click()
  await expect(page).toHaveURL(/\/agent\/e2e\/memory\?from=-tmp-e2e-project\/s1$/)
  await expect(main.getByTestId('return-chip')).toBeVisible()
  // refresh: the chip survives (it rides the URL)
  await page.reload()
  await expect(main.getByTestId('return-chip')).toBeVisible()
  await expect(page).toHaveURL(/\/agent\/e2e\/memory\?from=-tmp-e2e-project\/s1$/)
  // Back → the conversation
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${S1_PATH}$`))
  await expect(main.getByText(S1_LINE, { exact: true })).toBeVisible()
})

test('a deep link to the agent page from a conversation opens that tab, with the conversation as its way back', async ({ page }) => {
  // the seeded 'peers' agent has its own memory.md (helpers.ts seedInterSession)
  await page.goto(`${srv.url}/agent/peers/memory?from=-tmp-e2e-peers/peers1&token=${srv.token}`)
  const main = page.locator('main')
  const index = main.getByRole('navigation', { name: /sections/ })
  await expect(index.getByRole('button', { name: /^Memory/ })).toHaveAttribute('aria-current', 'page')
  const library = main.getByTestId('knows-library')
  // its own memory file is the agent's — shown here, first
  await expect(library.getByText('Its own memory').first()).toBeVisible()
  await expect(library.getByPlaceholder('Search memory')).toBeVisible()
  // its address stays, the conversation as its way back
  await expect(page).toHaveURL(/\/agent\/peers\/memory\?from=-tmp-e2e-peers\/peers1$/)
  await expect(main.getByTestId('return-chip')).toBeVisible()
})
