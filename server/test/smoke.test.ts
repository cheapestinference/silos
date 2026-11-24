import { describe, it, expect } from 'vitest'
import type { Agent } from '../src/types.js'

describe('scaffold', () => {
  it('the types compile and vitest runs', () => {
    const a: Agent = { id: 'master', name: 'Master', emoji: '🎛️', role: 'default', folder: null, skills: [] }
    expect(a.id).toBe('master')
  })
})
