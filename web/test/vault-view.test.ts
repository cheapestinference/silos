import { describe, it, expect } from 'vitest'
import { effectiveVaultFor } from '../src/lib/vault-view'
import type { VaultEntry } from '../src/lib/types'

const e = (id: string, name: string, scope: VaultEntry['scope']): VaultEntry => ({ id, name, value: 'sk-…1234', scope, createdAt: '2026-08-25T00:00:00Z' })

describe('effectiveVaultFor', () => {
  it('same precedence as the server (agent > project > global), with provenance', () => {
    const out = effectiveVaultFor(
      [
        e('1', 'STRIPE_KEY', { type: 'global' }),
        e('2', 'STRIPE_KEY', { type: 'agents', agentIds: ['finance'] }),
        e('3', 'RAILWAY_TOKEN', { type: 'folder', folder: '/home/u/proj' }),
        e('4', 'OTHER', { type: 'agents', agentIds: ['someone-else'] }),
      ],
      'finance',
      '/home/u/proj/sub',
    )
    expect(out.map((v) => [v.name, v.source])).toEqual([
      ['RAILWAY_TOKEN', 'project'],
      ['STRIPE_KEY', 'agent'],
    ])
    expect(out[1]!.overrides).toEqual(['global'])
    expect(out[1]!.entry.id).toBe('2')
  })
  it('folder scope respects the path boundary (/a/foo never matches /a/foobar)', () => {
    const out = effectiveVaultFor([e('1', 'X', { type: 'folder', folder: '/a/foo' })], 'ag', '/a/foobar')
    expect(out).toEqual([])
  })
  it('a shared visibility list reaches every named agent; the shortest list naming the agent wins the name', () => {
    const shared = [
      e('1', 'LEDGERLY_API_KEY', { type: 'agents', agentIds: ['finance', 'builder'] }),
      e('2', 'LEDGERLY_API_KEY', { type: 'agents', agentIds: ['finance'] }),
    ]
    const finance = effectiveVaultFor(shared, 'finance', null)
    expect(finance[0]!.entry.id).toBe('2')
    const builder = effectiveVaultFor(shared, 'builder', null)
    expect(builder[0]!.entry.id).toBe('1')
    expect(effectiveVaultFor(shared, 'writer', null)).toEqual([])
  })
  it('an agent with no folder still gets global and agent entries', () => {
    const out = effectiveVaultFor(
      [e('1', 'A', { type: 'global' }), e('2', 'B', { type: 'folder', folder: '/x' }), e('3', 'C', { type: 'agents', agentIds: ['master'] })],
      'master',
      null,
    )
    expect(out.map((v) => v.name)).toEqual(['A', 'C'])
  })
})
