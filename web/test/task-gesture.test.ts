// task-gesture.test.ts — the ONE implementation of the owner's gestures on a
// task: act(key, verb, args) is POST /api/tasks/act
// with what the surface painted; the owner's own change is marked seen there
// (F14); a refusal is the server's own words (C15c).
import { describe, expect, it, vi } from 'vitest'
import { act, actError, stateIn } from '../src/lib/task-gesture'
import { ApiError } from '../src/lib/api'

const seen = vi.hoisted(() => vi.fn())
vi.mock('../src/hooks/useTaskSeen', () => ({ markTaskSeen: seen }))

const answer = (state: string) => ({
  key: 'k',
  record: {
    tasks: [
      { id: 't1', state },
      { id: 't2', state: 'pending' },
    ],
  },
  already: false,
  holds: [],
})

describe('act', () => {
  it('sends the verb with its arguments in one request and marks the task seen in the state it was left', async () => {
    const send = vi.fn(async () => answer('done'))
    const r = await act('folder:/p/ship/tasks/t1', 'done', { state: 'pending' }, { act: send })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ key: 'folder:/p/ship/tasks/t1', verb: 'done', state: 'pending' })
    expect(r.already).toBe(false)
    expect(seen).toHaveBeenCalledWith('folder:/p/ship/tasks/t1', 'done')
  })
  it("a refusal is thrown, nothing is marked; its words are the server's", async () => {
    seen.mockClear()
    const send = vi.fn(async () => {
      throw new ApiError('it asks something else now', 409, {})
    })
    await expect(act('k/tasks/t1', 'answer', { text: 'Yes', asked: 'Ship?' }, { act: send })).rejects.toThrow('it asks something else now')
    expect(seen).not.toHaveBeenCalled()
    expect(actError(new ApiError('it changed — it is in progress now', 409, {}))).toBe('it changed — it is in progress now')
  })
  it("the task's state is read from the plan the answer carries", () => {
    expect(stateIn(answer('cancelled'), 'k/tasks/t1')).toBe('cancelled')
    expect(stateIn(answer('done'), 'k/tasks/t9')).toBeNull()
  })
})
