// conversation-refs.spec.ts — a session name (`silos-3d`) or id written in a
// message reads as the conversation's TITLE and opens it.
// Seeds two conversations in the isolated harness plus a Claude Code lock
// naming one of them, as a live `claude` would write it.
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer } from './helpers'

const SHOTS = process.env.REFS_SHOTS_DIR
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const TARGET = '5e5e5e5e-aaaa-4bbb-8ccc-0123456789ab'
const WRITER = '1a2b3c4d-1111-4222-8333-444455556666'
let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
  const project = readdirSync(srv.root).find((d) => existsSync(join(srv.root, d, 's1.jsonl')))!
  const cwd = '/tmp/e2e-refs'
  const lines = (id: string, title: string, user: string, said: string) =>
    [
      { type: 'user', cwd, timestamp: '2026-11-07T10:00:00.000Z', message: { role: 'user', content: user } },
      { type: 'ai-title', aiTitle: title, sessionId: id },
      { type: 'assistant', cwd, timestamp: '2026-11-07T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: said }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  writeFileSync(
    join(srv.root, project, `${TARGET}.jsonl`),
    lines(TARGET, 'The console drops with «reconnecting»', 'the bottom terminal keeps reconnecting', 'Found it: a half-open socket.'),
  )
  writeFileSync(
    join(srv.root, project, `${WRITER}.jsonl`),
    lines(
      WRITER,
      'Who is on what',
      'who is working on what?',
      `Nobody is on the role pack. silos-3d is on the console reconnect loop (conversation \`${TARGET}\`), and silos-99 no longer exists.`,
    ),
  )
  // a live claude's lock naming TARGET, as ~/.claude/sessions/<pid>.json
  mkdirSync(join(srv.home, '.claude', 'sessions'), { recursive: true })
  writeFileSync(join(srv.home, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: TARGET, name: 'silos-3d', cwd }))
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test('the name and the id read as the title; a click opens that conversation; an unknown name stays as written', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await expect
    .poll(async () => (await (await fetch(`${srv.url}/api/conversation-refs?ids=${WRITER}&token=${srv.token}`)).json()).refs[WRITER]?.title, {
      timeout: 15_000,
    })
    .toBe('Who is on what')
  const project = readdirSync(srv.root).find((d) => existsSync(join(srv.root, d, `${WRITER}.jsonl`)))!
  const owner = (await (await fetch(`${srv.url}/api/conversation-refs?ids=${WRITER}&token=${srv.token}`)).json()).refs[WRITER].agentId
  await page.goto(`${srv.url}/agent/${owner}/c/${project}/${WRITER}?token=${srv.token}`)
  const main = page.locator('main')
  await main.getByRole('button', { name: /^Chat/ }).click()
  const refs = main.getByTestId('conversation-ref')
  await expect(refs).toHaveCount(2)
  await expect(refs.first()).toHaveText('The console drops with «reconnecting»')
  await expect(main.getByText(/silos-99 no longer exists/)).toBeVisible()
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'chat-refs.png') })
  await refs.first().click()
  await expect(page).toHaveURL(new RegExp(`/c/${project}/${TARGET}`))
  await context.close()
})
