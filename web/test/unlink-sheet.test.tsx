// unlink-sheet.test.tsx — «Unlink…» on a task's last current conversation
// sends ONE release; «blocked» names on whom in that same
// request — nothing written before it, nothing after.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UnlinkSheet } from '../src/components/tasks/UnlinkSheet'
import { api } from '../src/lib/api'
import type { TaskView } from '../src/lib/tasks'

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>()
  return { ...real, api: { tasksRelease: vi.fn(), silos: { setField: vi.fn() } } }
})
vi.mock('../src/hooks/useTasks', () => ({ refreshTasks: vi.fn(), refreshTasksBySession: vi.fn() }))
const mocked = vi.mocked(api, { deep: true })

const task = { key: 'folder:/p/alpha/p/tasks/t1', owner: 'writer', state: 'in_progress', currentConversations: ['s1'], waitingOn: null } as unknown as TaskView

beforeEach(() => {
  vi.clearAllMocks()
})

describe('UnlinkSheet — one release', () => {
  it('blocked on someone: the release carries the wait; no set-field', async () => {
    mocked.tasksRelease.mockResolvedValue({ released: true, disposed: 'blocked', wait: { owner: 'sam', action: 'sign it' } })
    const done = vi.fn()
    render(<UnlinkSheet task={task} sessionId="s1" title="the draft" agents={[]} onCancel={() => {}} onDone={done} />)
    fireEvent.click(screen.getByTestId('unlink-as-blocked'))
    fireEvent.click(screen.getByLabelText('on someone else'))
    fireEvent.change(screen.getByLabelText('Who it waits on'), { target: { value: 'sam' } })
    fireEvent.change(screen.getByLabelText('What it waits for'), { target: { value: 'sign it' } })
    fireEvent.click(screen.getByTestId('unlink-confirm'))
    await waitFor(() =>
      expect(mocked.tasksRelease).toHaveBeenCalledWith({ key: task.key, session: 's1', state: 'blocked', wait: { owner: 'sam', action: 'sign it' } }),
    )
    expect(mocked.silos.setField).not.toHaveBeenCalled()
    await waitFor(() => expect(done).toHaveBeenCalledWith('Unlinked — it is blocked now.'))
  })
  it('blocked — on you: «unblock it» unless you say what', async () => {
    mocked.tasksRelease.mockResolvedValue({ released: true, disposed: 'blocked' })
    render(<UnlinkSheet task={task} sessionId="s1" title="" agents={[]} onCancel={() => {}} onDone={() => {}} />)
    fireEvent.click(screen.getByTestId('unlink-as-blocked'))
    fireEvent.click(screen.getByTestId('unlink-confirm'))
    await waitFor(() =>
      expect(mocked.tasksRelease).toHaveBeenCalledWith({ key: task.key, session: 's1', state: 'blocked', wait: { owner: 'owner', action: 'unblock it' } }),
    )
  })
})
