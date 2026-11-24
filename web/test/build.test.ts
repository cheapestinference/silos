// the stale-tab banner's brain: pure comparison between the id this bundle
// was built with (lib/build.ts ownBuild, stamped by vite.config.ts) and the
// id the server says it is serving (/api/overview `build`).
import { describe, it, expect } from 'vitest'
import { updateAvailable } from '../src/lib/build'

describe('updateAvailable', () => {
  it('true only when both ids exist and differ', () => {
    expect(updateAvailable('2026-08-25T16:00:00.000Z', '2026-08-25T17:00:00.000Z')).toBe(true)
    expect(updateAvailable('same', 'same')).toBe(false)
  })

  it('a dev bundle never offers a reload (HMR keeps it current; the proxy would always mismatch)', () => {
    expect(updateAvailable('dev', 'anything')).toBe(false)
  })

  it('an old server (no build field yet) or an unstamped bundle stays quiet', () => {
    expect(updateAvailable('abc', undefined)).toBe(false)
    expect(updateAvailable(null, 'abc')).toBe(false)
  })
})
