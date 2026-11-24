// role-pack.spec.ts — a role as a unit that copies, against a real Silos:
// «Save as role pack» on an
// agent downloads the file; New agent › From a role pack shows what
// installing does and Install makes a NEW agent with its skills, its
// automation and its secret. Seeded, isolated harness only; the automation
// made is paused at once. Screenshots only when ROLEPACK_SHOTS_DIR is set.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer } from './helpers'

const SHOTS = process.env.ROLEPACK_SHOTS_DIR
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

let srv: E2EServer
const api = (path: string, init?: RequestInit) =>
  fetch(`${srv.url}${path}${path.includes('?') ? '&' : '?'}token=${srv.token}`, { ...init, headers: { 'content-type': 'application/json' } })

test.beforeAll(async () => {
  srv = await startServer()
  // the UX agent's role: a mission, one skill, one automation, a secret scoped to it
  await api('/api/agents/ux', {
    method: 'PATCH',
    body: JSON.stringify({ mission: { text: 'Keep the UI exquisite: one pass a week over the screenshots', never: ['ship a screen unreviewed'] } }),
  })
  const skill = join(srv.dataDir, 'agent-state', 'ux', 'plugin', 'skills', 'ui-review')
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: ui-review\ndescription: review a screen against the design rules\n---\nCheck spacing, type scale and contrast.\n',
  )
  // a skill in the agent's FOLDER (not its own): the export offers it
  const agentsRes = (await (await api('/api/agents')).json()) as { agents?: { id: string; folder: string }[] } | { id: string; folder: string }[]
  const uxFolder = (Array.isArray(agentsRes) ? agentsRes : agentsRes.agents!).find((a) => a.id === 'ux')!.folder
  mkdirSync(join(uxFolder, '.claude', 'skills', 'brand-voice'), { recursive: true })
  writeFileSync(
    join(uxFolder, '.claude', 'skills', 'brand-voice', 'SKILL.md'),
    '---\nname: brand-voice\ndescription: how this product writes\n---\nShort, plain, active voice.\n',
  )
  await api('/api/vault', {
    method: 'POST',
    body: JSON.stringify({ name: 'FIGMA_TOKEN', value: 'figd-e2e-0123456789abcdef', scope: { type: 'agents', agentIds: ['ux'] } }),
  })
  const made = await (
    await api('/api/automations', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Weekly UI pass',
        agentId: 'ux',
        prompt: 'Review last week’s screenshots.',
        trigger: { kind: 'cron', expr: '0 9 * * 1' },
        paused: true,
      }),
    })
  ).json()
  expect(made.automation?.id).toBeTruthy()
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test('Save as role pack, then New agent › From a role pack: consequences, Install, a new agent with its role', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()

  // export from the agent's page
  await page.goto(`${srv.url}/agent/ux?token=${srv.token}`)
  await page.goto(`${srv.url}/agent/ux/settings?token=${srv.token}`)
  const downloading = page.waitForEvent('download')
  await page.getByTestId('save-role-pack').click()
  // the folder's skills are offered first when it has any: take them
  const offer = page.getByTestId('save-role-pack-skills')
  if (
    await offer.waitFor({ state: 'visible', timeout: 3000 }).then(
      () => true,
      () => false,
    )
  ) {
    await shot(page, 'export-folder-skills')
    await offer.getByRole('checkbox', { name: /brand-voice/ }).check()
    await page.getByTestId('save-role-pack-download').click()
  }
  const download = await downloading
  await expect(offer).toBeHidden()
  const file = join(srv.home, 'ux.role-pack.json')
  await download.saveAs(file)
  const pack = JSON.parse(readFileSync(file, 'utf8'))
  expect(pack).toMatchObject({
    kind: 'silos.role-pack',
    name: 'UX',
    mission: { text: 'Keep the UI exquisite: one pass a week over the screenshots', never: ['ship a screen unreviewed'] },
  })
  expect(pack.secrets).toContainEqual({ name: 'FIGMA_TOKEN', why: '' })
  expect(JSON.stringify(pack)).not.toContain('figd-e2e')
  expect(pack.skills.map((x: { name: string }) => x.name).sort()).toEqual(['brand-voice', 'ui-review'])
  await expect(page.getByTestId('save-role-pack-said')).toHaveText('Saved')

  // install it as a new agent
  await page.getByRole('button', { name: 'new', exact: true }).click()
  await page.getByRole('menu', { name: 'New' }).getByText('New agent', { exact: true }).click()
  await expect(page.getByTestId('from-role-pack')).toBeVisible()
  await page.getByTestId('role-pack-file').setInputFiles(file)
  await expect(page.getByTestId('role-pack-install')).toBeVisible()
  await page.getByLabel('Name').fill('UX demo')
  await page.getByLabel('Folder it works in').fill(join(srv.home, 'demo-folder'))
  await expect(page.getByTestId('pack-consequences')).toContainText('ui-review')
  await expect(page.getByTestId('pack-consequences')).toContainText('Weekly UI pass')
  await expect(page.getByTestId('pack-consequences')).toContainText('FIGMA_TOKEN')
  // its mission is read whole before Install (it starts every conversation)
  await expect(page.getByTestId('pack-mission')).toContainText('Keep the UI exquisite')
  await expect(page.getByTestId('pack-mission')).toContainText('Never: ship a screen unreviewed')
  // what the agent will read is readable before Install
  await page.getByTestId('pack-consequences').getByRole('button', { name: 'Read' }).first().click()
  await expect(page.getByTestId('pack-consequences')).toContainText('Check spacing, type scale and contrast.')
  await page.getByTestId('pack-secret-FIGMA_TOKEN').fill('figd-demo-9999999999')
  await shot(page, 'install-consequences')
  await page.getByTestId('pack-install').click()
  await expect(page.getByTestId('role-pack-installed')).toBeVisible()
  await expect(page.getByTestId('role-pack-installed')).toContainText('FIGMA_TOKEN stored in the Vault for it')
  await shot(page, 'install-report')

  // the new agent, as installed
  const agents = (await (await api('/api/agents')).json()) as { agents: { id: string; pack?: unknown; mission?: { text: string } }[] } | { id: string }[]
  const list = Array.isArray(agents) ? agents : agents.agents
  const demo = list.find((a) => a.id === 'ux-demo') as { pack?: unknown; mission?: { text: string } } | undefined
  expect(demo?.pack).toEqual({ id: pack.id, packVersion: pack.packVersion })
  expect(demo?.mission?.text).toBe('Keep the UI exquisite: one pass a week over the screenshots')
  const autos = (await (await api('/api/automations')).json()).automations as { id: string; agentId: string; name: string }[]
  const weekly = autos.find((a) => a.agentId === 'ux-demo' && a.name === 'Weekly UI pass')
  expect(weekly).toBeTruthy()
  await api(`/api/automations/${weekly!.id}`, { method: 'PATCH', body: JSON.stringify({ paused: true }) })
  await context.close()
})
