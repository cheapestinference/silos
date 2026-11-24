// mission.spec.ts — the Automations facet over a seeded heartbeat (the old
// mission banner went with the old beat). Was: the agent dossier + Chat banner + Automations facet
// against seeded MISSION state (helpers.ts: seedMission — a second
// autonomy agent, this one in runmode.kind 'mission': a real responsibility
// (agents.json), a real runmode.json/status.json under the harness's
// agent-state dir, a materialized auto-resp-<id> automation whose
// thread.sessionId points at a REAL seeded conversation, and a seeded
// plans/*.plan.json (1 done / 2 pending). Sibling of dossier.spec.ts, which
// covers the STANDING runmode over the same /api/agents/:id/autonomy view
// model — this file covers the mission branch: the MissionBanner in Chat.tsx
// once that conversation is open (the InChargeOf card it was reached from
// is gone), and that the
// beat (auto-resp-*) stays OUT of Machinery's Automations pointer rows
// (its home is the «In charge of» card).
//
// Imports test/expect from helpers (not '@playwright/test'): the
// MissionBanner only mounts in the chat view, which is gated behind
// silos.chatMode — helpers' `test` seeds that into localStorage before the
// app boots, same idiom as every other banner-adjacent spec.
import { test, expect, startServer, agentRow, cleanupTempDirs, type E2EServer } from './helpers'

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.beforeEach(async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
})

test("Now › Automations: the heartbeat is NOT a pointer row (it is the control block's own lines)", async ({ page }) => {
  await page
    .getByRole('button', { name: agentRow('Mission') })
    .first()
    .click()
  const main = page.locator('main')
  // its automations are a row of the control block, on Now: the row
  // renders, but the agent's only automation is its beat, so none lists
  await expect(main.getByTestId('agent-automations')).toBeVisible()
  await expect(main.getByTestId('automation-item')).toHaveCount(0)
  await expect(main.getByText('chosen by Mission')).toHaveCount(0)
})
