// engine-path.test.ts — an engine installed where its own installer puts it
// is found whatever PATH started Silos (a restart with a short PATH once
// made every console say the engine «isn't installed»).
import { describe, expect, it } from 'vitest'
import { completeEnginePath, executableOnPath } from '../src/engine-path.js'
import { registeredHarnesses } from '../src/harnesses/registry.js'

const engine = (id: string, cmd: string, dirs: string[]) => ({ id, binary: { command: () => cmd, installDirs: () => dirs } })
const files =
  (...present: string[]) =>
  (p: string) =>
    present.includes(p)

describe('completeEnginePath', () => {
  it('appends the install directory of an engine PATH does not find', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
    const added = completeEnginePath([engine('a', 'aa', ['/h/.a/bin'])], '/h', env, files('/h/.a/bin/aa'))
    expect(added).toEqual([{ harness: 'a', dir: '/h/.a/bin' }])
    expect(env.PATH).toBe('/usr/bin:/bin:/h/.a/bin')
  })
  it("the user's PATH wins: an engine PATH already finds adds nothing", () => {
    const env: NodeJS.ProcessEnv = { PATH: '/opt/x:/usr/bin' }
    expect(completeEnginePath([engine('a', 'aa', ['/h/.a/bin'])], '/h', env, files('/opt/x/aa', '/h/.a/bin/aa'))).toEqual([])
    expect(env.PATH).toBe('/opt/x:/usr/bin')
  })
  it('not installed anywhere: PATH is left as it was', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(completeEnginePath([engine('a', 'aa', ['/h/.a/bin'])], '/h', env, files())).toEqual([])
    expect(env.PATH).toBe('/usr/bin')
  })
  it('a command given as a path (an override) is left alone', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(completeEnginePath([engine('a', '/custom/aa', ['/h/.a/bin'])], '/h', env, files('/h/.a/bin/aa'))).toEqual([])
    expect(env.PATH).toBe('/usr/bin')
  })
  it('idempotent, each engine its own directory, the first holding directory, no PATH at all', () => {
    const env: NodeJS.ProcessEnv = {}
    const engines = [engine('a', 'aa', ['/h/none', '/h/.a/bin', '/h/later']), engine('b', 'bb', ['/h/.b/bin']), { id: 'c' }]
    const has = files('/h/.a/bin/aa', '/h/later/aa', '/h/.b/bin/bb')
    expect(completeEnginePath(engines, '/h', env, has)).toEqual([
      { harness: 'a', dir: '/h/.a/bin' },
      { harness: 'b', dir: '/h/.b/bin' },
    ])
    expect(env.PATH).toBe('/h/.a/bin:/h/.b/bin')
    expect(completeEnginePath(engines, '/h', env, has)).toEqual([])
    expect(env.PATH).toBe('/h/.a/bin:/h/.b/bin')
  })
  it('two engines sharing one install directory add it once', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    completeEnginePath([engine('a', 'aa', ['/h/bin']), engine('b', 'bb', ['/h/bin'])], '/h', env, files('/h/bin/aa', '/h/bin/bb'))
    expect(env.PATH).toBe('/usr/bin:/h/bin')
  })
})

describe('executableOnPath', () => {
  it('first match in PATH order; empty entries skipped; a path is itself', () => {
    expect(executableOnPath('aa', '/x::/y', files('/y/aa'))).toBe('/y/aa')
    expect(executableOnPath('aa', undefined, files('/y/aa'))).toBeNull()
    expect(executableOnPath('/z/aa', '/x', files('/z/aa'))).toBe('/z/aa')
  })
})

describe('an engine that declares its binary', () => {
  it('names its command and absolute install directories under home', () => {
    const declared = registeredHarnesses().filter((h) => h.binary)
    expect(declared.length).toBeGreaterThan(0)
    for (const h of declared) {
      expect(h.binary!.command().length, h.id).toBeGreaterThan(0)
      const dirs = h.binary!.installDirs('/home/op')
      expect(dirs.length, h.id).toBeGreaterThan(0)
      for (const d of dirs) expect(d.startsWith('/home/op/'), `${h.id}: ${d}`).toBe(true)
    }
  })
})
