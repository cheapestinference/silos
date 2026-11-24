// automations-store.test.ts — the store slice for the automations
// resident (server already live) — loading, optimistic mutations by id,
// upserting via WS ('automation'/'run'), and navigating to the detail page
// (page={kind:'automation'}). See store.ts (loadAutomations…) and
// lib/types.ts (Automation/Run, a mirror of server/src/automations-types.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { Automation, Run } from '../src/lib/types'

vi.mock('../src/lib/api')

const mockedApi = vi.mocked(api, { deep: true })

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto1',
    name: 'Morning standup',
    agentId: 'a1',
    prompt: 'summarize overnight activity',
    trigger: { kind: 'cron', expr: '0 9 * * 1-5' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run1',
    automationId: 'auto1',
    at: '2026-08-19T09:00:00.000Z',
    status: 'ok',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ automations: [], automationsPending: [], automationRuns: [], page: null })
})

describe('loadAutomations', () => {
  it('fetches list()+pending() in parallel and sets them in the store', async () => {
    mockedApi.automations.list.mockResolvedValue([makeAutomation()])
    mockedApi.automations.pending.mockResolvedValue([makeRun({ status: 'waiting_approval' })])
    await useStore.getState().loadAutomations()
    expect(useStore.getState().automations).toHaveLength(1)
    expect(useStore.getState().automationsPending).toHaveLength(1)
  })

  it('a network failure does not break the UI — leaves the lists as they were', async () => {
    useStore.setState({ automations: [makeAutomation()] })
    mockedApi.automations.list.mockRejectedValue(new Error('offline'))
    mockedApi.automations.pending.mockResolvedValue([])
    await useStore.getState().loadAutomations()
    expect(useStore.getState().automations).toHaveLength(1) // untouched
  })
})

describe('loadAutomationRuns', () => {
  it("fetches ONE automation's runs and sets them in automationRuns", async () => {
    mockedApi.automations.runs.mockResolvedValue([makeRun()])
    await useStore.getState().loadAutomationRuns('auto1')
    expect(useStore.getState().automationRuns).toEqual([makeRun()])
    expect(mockedApi.automations.runs).toHaveBeenCalledWith('auto1')
  })
})

describe('mutating an automation', () => {
  it("createAutomation adds the server's response to the list", async () => {
    mockedApi.automations.create.mockResolvedValue(makeAutomation({ id: 'new' }))
    const a = await useStore.getState().createAutomation({
      name: 'x',
      agentId: 'a1',
      prompt: 'p',
      trigger: { kind: 'once', at: '2026-08-20T09:00:00.000Z' },
    })
    expect(a.id).toBe('new')
    expect(useStore.getState().automations.map((x) => x.id)).toEqual(['new'])
  })

  it('updateAutomation replaces by id without touching the others', async () => {
    useStore.setState({ automations: [makeAutomation({ id: 'a' }), makeAutomation({ id: 'b', name: 'B' })] })
    mockedApi.automations.update.mockResolvedValue(makeAutomation({ id: 'a', name: 'A edited' }))
    await useStore.getState().updateAutomation('a', { name: 'A edited' })
    const { automations } = useStore.getState()
    expect(automations.find((x) => x.id === 'a')?.name).toBe('A edited')
    expect(automations.find((x) => x.id === 'b')?.name).toBe('B')
  })

  it('deleteAutomation removes it from automations AND automationsPending', async () => {
    useStore.setState({
      automations: [makeAutomation({ id: 'a' })],
      automationsPending: [makeRun({ id: 'r', automationId: 'a', status: 'waiting_approval' })],
    })
    mockedApi.automations.delete.mockResolvedValue(undefined)
    await useStore.getState().deleteAutomation('a')
    expect(useStore.getState().automations).toEqual([])
    expect(useStore.getState().automationsPending).toEqual([])
  })

  // the fallback goes back to Board/Automations, today's real origin dimension.
  it('deleting the automation whose detail page is open goes back to Board/Automations', async () => {
    useStore.setState({ automations: [makeAutomation({ id: 'a' })], page: { kind: 'automation', id: 'a' } })
    mockedApi.automations.delete.mockResolvedValue(undefined)
    await useStore.getState().deleteAutomation('a')
    expect(useStore.getState().page).toEqual({ kind: 'automations' })
  })

  it("deleting an automation that is NOT the open page's does not touch `page`", async () => {
    useStore.setState({ automations: [makeAutomation({ id: 'a' }), makeAutomation({ id: 'b' })], page: { kind: 'automation', id: 'b' } })
    mockedApi.automations.delete.mockResolvedValue(undefined)
    await useStore.getState().deleteAutomation('a')
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'b' })
  })

  it("runNowAutomation calls the api and refreshes that automation's runs", async () => {
    mockedApi.automations.runNow.mockResolvedValue({ ok: true })
    mockedApi.automations.runs.mockResolvedValue([makeRun()])
    await useStore.getState().runNowAutomation('auto1')
    expect(mockedApi.automations.runNow).toHaveBeenCalledWith('auto1')
    expect(useStore.getState().automationRuns).toEqual([makeRun()])
  })

  it("pauseAutomation/resumeAutomation update the automation with the server's response", async () => {
    useStore.setState({ automations: [makeAutomation({ id: 'a', paused: false })] })
    mockedApi.automations.pause.mockResolvedValue(makeAutomation({ id: 'a', paused: true }))
    await useStore.getState().pauseAutomation('a')
    expect(useStore.getState().automations[0]?.paused).toBe(true)

    mockedApi.automations.resume.mockResolvedValue(makeAutomation({ id: 'a', paused: false }))
    await useStore.getState().resumeAutomation('a')
    expect(useStore.getState().automations[0]?.paused).toBe(false)
  })
})

describe('approving runs (approve/skip)', () => {
  it('approveRun removes the run from automationsPending and refreshes automations', async () => {
    useStore.setState({ automationsPending: [makeRun({ id: 'r1', status: 'waiting_approval' })] })
    mockedApi.automations.approve.mockResolvedValue({ ok: true })
    mockedApi.automations.list.mockResolvedValue([])
    mockedApi.automations.pending.mockResolvedValue([])
    await useStore.getState().approveRun('r1')
    expect(mockedApi.automations.approve).toHaveBeenCalledWith('r1')
    expect(useStore.getState().automationsPending).toEqual([])
  })

  it('skipRun removes the run from automationsPending', async () => {
    useStore.setState({ automationsPending: [makeRun({ id: 'r1', status: 'waiting_approval' })] })
    mockedApi.automations.skip.mockResolvedValue({ ok: true })
    mockedApi.automations.list.mockResolvedValue([])
    mockedApi.automations.pending.mockResolvedValue([])
    await useStore.getState().skipRun('r1')
    expect(mockedApi.automations.skip).toHaveBeenCalledWith('r1')
    expect(useStore.getState().automationsPending).toEqual([])
  })
})

describe('openAutomation', () => {
  it('navigates to page={kind:automation,id} and loads its runs', async () => {
    mockedApi.automations.runs.mockResolvedValue([makeRun()])
    useStore.getState().openAutomation('auto1')
    expect(useStore.getState().page).toEqual({ kind: 'automation', id: 'auto1' })
    await vi.waitFor(() => expect(useStore.getState().automationRuns).toEqual([makeRun()]))
  })
})

describe('applyWs — the "automation" event', () => {
  it('upsert: a new id is added, an existing id is replaced', () => {
    useStore.setState({ automations: [makeAutomation({ id: 'a', name: 'old' })] })
    useStore.getState().applyWs({ ev: 'automation', automation: makeAutomation({ id: 'a', name: 'new' }) })
    expect(useStore.getState().automations).toEqual([makeAutomation({ id: 'a', name: 'new' })])

    useStore.getState().applyWs({ ev: 'automation', automation: makeAutomation({ id: 'b' }) })
    expect(
      useStore
        .getState()
        .automations.map((a) => a.id)
        .sort(),
    ).toEqual(['a', 'b'])
  })
})

describe("applyWs — what moves Home's inbox (inboxTick)", () => {
  it('a run that ended bumps it (a failure may have entered); one still running does not', () => {
    useStore.setState({ inboxTick: 0 })
    useStore.getState().applyWs({ ev: 'run', run: makeRun({ id: 'r1', status: 'running' }) })
    expect(useStore.getState().inboxTick).toBe(0)
    useStore.getState().applyWs({ ev: 'run', run: makeRun({ id: 'r1', status: 'failed' }) })
    expect(useStore.getState().inboxTick).toBe(1)
  })
  it("the server's `inbox` nudge bumps it", () => {
    useStore.setState({ inboxTick: 3 })
    useStore.getState().applyWs({ ev: 'inbox' })
    expect(useStore.getState().inboxTick).toBe(4)
  })
})

describe('applyWs — the "run" event', () => {
  it('a run that moves to waiting_approval enters automationsPending', () => {
    useStore.getState().applyWs({ ev: 'run', run: makeRun({ id: 'r1', status: 'waiting_approval' }) })
    expect(useStore.getState().automationsPending.map((r) => r.id)).toEqual(['r1'])
  })

  it('a run that was ALREADY pending and arrives as waiting_approval again is replaced, not duplicated', () => {
    useStore.setState({ automationsPending: [makeRun({ id: 'r1', status: 'waiting_approval', summary: undefined })] })
    useStore.getState().applyWs({ ev: 'run', run: makeRun({ id: 'r1', status: 'waiting_approval', summary: 'updated' }) })
    expect(useStore.getState().automationsPending).toHaveLength(1)
    expect(useStore.getState().automationsPending[0]?.summary).toBe('updated')
  })

  it('a pending run that resolves (ok/failed/skipped) leaves automationsPending', () => {
    useStore.setState({ automationsPending: [makeRun({ id: 'r1', status: 'waiting_approval' })] })
    useStore.getState().applyWs({ ev: 'run', run: makeRun({ id: 'r1', status: 'ok' }) })
    expect(useStore.getState().automationsPending).toEqual([])
  })

  it('if the open detail page owns the run, it also upserts into automationRuns', () => {
    useStore.setState({ page: { kind: 'automation', id: 'auto1' }, automationRuns: [] })
    useStore.getState().applyWs({ ev: 'run', run: makeRun({ id: 'r1', automationId: 'auto1', status: 'running' }) })
    expect(useStore.getState().automationRuns.map((r) => r.id)).toEqual(['r1'])

    useStore.getState().applyWs({ ev: 'run', run: makeRun({ id: 'r1', automationId: 'auto1', status: 'ok' }) })
    expect(useStore.getState().automationRuns).toHaveLength(1)
    expect(useStore.getState().automationRuns[0]?.status).toBe('ok')
  })

  it('if the open detail page is ANOTHER automation, it does not touch automationRuns', () => {
    useStore.setState({ page: { kind: 'automation', id: 'other' }, automationRuns: [] })
    useStore.getState().applyWs({ ev: 'run', run: makeRun({ id: 'r1', automationId: 'auto1', status: 'running' }) })
    expect(useStore.getState().automationRuns).toEqual([])
  })
})
