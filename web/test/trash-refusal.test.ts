import { describe, it, expect } from 'vitest'
import { ApiError } from '../src/lib/api'
import { trashRefusalOf } from '../src/lib/trash-refusal'

describe('trashRefusalOf — the 409 that names a claude outside Silos', () => {
  const body = {
    error: 'a claude started outside Silos still holds this conversation — tmux "claude-retry-1" (pid 7), idle for 12 h — close it before trashing',
    holders: [{ pid: 7, tmux: 'claude-retry-1', name: 'p-91', cwd: '/p' }],
    canClose: true,
  }

  it('reads the message, the holders and canClose', () => {
    const r = trashRefusalOf(new ApiError(body.error, 409, body))
    expect(r).toEqual({ message: body.error, holders: [{ pid: 7, tmux: 'claude-retry-1', name: 'p-91' }], canClose: true })
  })

  it('is null for any other failure (a 409 without holders, a 500, a plain Error)', () => {
    expect(trashRefusalOf(new ApiError('a turn is in progress', 409, { error: 'a turn is in progress' }))).toBeNull()
    expect(trashRefusalOf(new ApiError('boom', 500, body))).toBeNull()
    expect(trashRefusalOf(new Error('x'))).toBeNull()
  })
})
