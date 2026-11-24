// context-column-processes.test.tsx — the conversation's Processes block
// (folded by default): absent with none, one folded line
// with some, and Stop dispatching the kernel-verb stop-process with the
// record's key, the server's words (or refusal) said on the row.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ContextColumn } from '../src/components/ContextColumn'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'
import type { ConversationProcess, SessionView } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const meta: SessionView = {
  id: 's1',
  folder: 'f',
  title: 'Session',
  skills: [],
  cwd: null,
  mtime: 0,
  size: 0,
  turnCount: 0,
  live: false,
  worktree: false,
  native: true,
  agentId: 'a1',
}
const proc = (over: Partial<ConversationProcess> = {}): ConversationProcess => ({
  id: '21-210',
  key: 'platform/21-210',
  state: 'left',
  stateLabel: 'left running',
  command: 'node /srv/app/node_modules/.bin/vite --port 5193',
  startedAt: '2026-11-20T08:00:00.000Z',
  origin: 'conversation',
  stoppable: true,
  ports: '5193',
  cpu: 2.4,
  memoryMb: 16,
  processes: 2,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.patchPrefsContextScope.mockResolvedValue({})
  useStore.setState({
    agents: [],
    automations: [],
    automationsPending: [],
    selected: { folder: 'f', id: 's1' },
    detail: { meta, turns: [], total: 0 },
    siloTick: 0,
    nowTick: Date.now(),
    page: null,
  })
})

describe('the Processes block', () => {
  it('absent when the conversation left nothing running', async () => {
    mockedApi.processes.mockResolvedValue([])
    render(<ContextColumn />)
    await waitFor(() => expect(mockedApi.processes).toHaveBeenCalledWith('f', 's1'))
    expect(screen.queryByText('Processes')).toBeNull()
  })

  it('one folded line: its count and its ports, closed', async () => {
    mockedApi.processes.mockResolvedValue([proc(), proc({ id: '33-330', key: 'platform/33-330', command: 'npm test', ports: undefined })])
    render(<ContextColumn />)
    const title = await screen.findByText('Processes')
    const details = title.closest('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')!.textContent).toContain(':5193')
    expect(details.querySelector('summary')!.textContent).toContain('2')
  })

  it("Stop, confirmed, sends the record's key and name; the row says the answer", async () => {
    mockedApi.processes.mockResolvedValue([proc()])
    mockedApi.silos.kernelVerb.mockResolvedValue({ says: 'Stopped vite — 2 processes.', name: 'stop-process', key: 'platform/21-210', outcome: 'stopped' })
    render(<ContextColumn />)
    fireEvent.click(await screen.findByRole('button', { name: /^Stop node/ }))
    expect(mockedApi.silos.kernelVerb).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Stop it?'))
    expect(mockedApi.silos.kernelVerb).toHaveBeenCalledWith('system', { key: 'platform/21-210', name: 'stop-process' })
    expect(await screen.findByText('Stopped vite — 2 processes.')).toBeInTheDocument()
  })

  it('a refusal is said on the row, verbatim', async () => {
    mockedApi.processes.mockResolvedValue([proc()])
    mockedApi.silos.kernelVerb.mockRejectedValue(new Error("this Silos can't stop here — the kernel has no stop-process on this machine"))
    render(<ContextColumn />)
    fireEvent.click(await screen.findByRole('button', { name: /^Stop node/ }))
    fireEvent.click(screen.getByText('Stop it?'))
    expect(await screen.findByText("this Silos can't stop here — the kernel has no stop-process on this machine")).toBeInTheDocument()
  })

  it('no Stop on what Silos may not stop', async () => {
    mockedApi.processes.mockResolvedValue([proc({ stoppable: false, origin: 'other-user' })])
    render(<ContextColumn />)
    await screen.findByText('Processes')
    expect(screen.queryByRole('button', { name: /^Stop / })).toBeNull()
  })
})
