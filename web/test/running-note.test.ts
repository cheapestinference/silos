// running-note.test.ts — lib/running.ts: the account a conversation RUNS on
// (its live processes) beside the one it is SET to, by email, and "open
// twice" when two claudes hold it.
import { describe, it, expect } from 'vitest'
import { accountWho, runningNote } from '../src/lib/running'
import type { ProviderView, SessionRunning } from '../src/lib/types'

const acct = (id: string, email: string): ProviderView =>
  ({
    id,
    kind: 'claude-account',
    label: id,
    account: { name: id === 'default' ? 'default' : id.slice(8), email, displayName: 'sam', plan: null, loggedIn: true },
  }) as unknown as ProviderView
const providers = [acct('default', 'owner@example.com'), acct('account:kai', 'second@example.com')]
const run = (over: Partial<SessionRunning>): SessionRunning => ({ pid: 1, providerId: 'default', configDir: null, silos: true, tmux: 'silos-x', ...over })

describe('runningNote — only the Silos console the owner is looking at', () => {
  it('nothing to say when its console runs on the account it is set to, in chat mode, or for a key', () => {
    expect(runningNote([run({ providerId: 'account:kai' })], providers, 'account:kai')).toBeNull()
    expect(runningNote([], providers, 'account:kai')).toBeNull()
    expect(runningNote(undefined, providers, null)).toBeNull()
    expect(runningNote([run({ providerId: 'default' })], providers, 'default')).toBeNull()
    const key = { id: 'k1', kind: 'anthropic-compatible', label: 'gw' } as unknown as ProviderView
    expect(runningNote([run({ providerId: 'default' })], [...providers, key], 'k1')).toBeNull()
  })

  it('its console on another account: both by EMAIL (the display name «sam» repeats)', () => {
    expect(runningNote([run({ providerId: 'default' })], providers, 'account:kai')).toEqual({
      runsOn: 'owner@example.com',
      runsOnId: 'default',
      setTo: 'second@example.com',
    })
  })

  it('a claude started outside Silos on the same conversation is not this view: ignored', () => {
    expect(runningNote([run({ providerId: 'default', silos: false, tmux: 'claude-other-9' })], providers, 'account:kai')).toBeNull()
    expect(
      runningNote(
        [run({ pid: 1, providerId: 'account:kai' }), run({ pid: 2, providerId: 'default', silos: false, tmux: 'claude-other-9' })],
        providers,
        'account:kai',
      ),
    ).toBeNull()
  })

  it('an unknown config dir is said as unknown', () => {
    // never passed off as one of the known accounts
    expect(accountWho(providers, null)).not.toContain('@')
  })
})
