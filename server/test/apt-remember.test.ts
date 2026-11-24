// The image's apt shim (deploy/apt-remember.sh, installed as
// /usr/local/sbin/apt-get and apt): what an agent installs with sudo is
// remembered on the volume and replayed at boot. If it forgets, a redeploy
// silently loses the agent's system packages; if it remembers a failed
// install, every boot retries a broken name; if it changes the exit code,
// the agent's own command lies.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHIM = fileURLToPath(new URL('../../deploy/apt-remember.sh', import.meta.url))

function setup(realExit: number) {
  const dir = mkdtempSync(join(tmpdir(), 'apt-shim-'))
  const real = join(dir, 'real')
  const bin = join(dir, 'bin')
  spawnSync('mkdir', ['-p', real, bin])
  for (const n of ['apt-get', 'apt']) {
    writeFileSync(join(real, n), `#!/bin/sh\necho "$0 $*" >>"${dir}/calls"\nexit ${realExit}\n`)
    chmodSync(join(real, n), 0o755)
    symlinkSync(SHIM, join(bin, n))
  }
  const list = join(dir, 'silos', 'system-packages.txt')
  const run = (name: string, ...args: string[]) =>
    spawnSync(join(bin, name), args, { encoding: 'utf8', env: { ...process.env, SILOS_REAL_APT_DIR: real, SILOS_SYSTEM_PACKAGES: list } })
  const listed = () => (existsSync(list) ? readFileSync(list, 'utf8').split('\n').filter(Boolean) : [])
  return { dir, run, listed }
}

describe('apt shim — sudo installs survive a redeploy', () => {
  it('a successful install is remembered once, by name, options and local files skipped', () => {
    const s = setup(0)
    expect(s.run('apt-get', '-y', '-o', 'Dpkg::Use-Pty=0', 'install', 'ffmpeg', 'jq', './local.deb', '--no-install-recommends').status).toBe(0)
    expect(s.run('apt', 'install', '-y', 'jq', 'postgresql-client').status).toBe(0)
    expect(s.listed()).toEqual(['ffmpeg', 'jq', 'postgresql-client'])
    // the real command got the arguments untouched
    expect(readFileSync(join(s.dir, 'calls'), 'utf8')).toContain('real/apt-get -y -o Dpkg::Use-Pty=0 install ffmpeg jq ./local.deb --no-install-recommends')
  })

  it('a failed install is not remembered and its exit code reaches the caller', () => {
    const s = setup(100)
    expect(s.run('apt-get', 'install', '-y', 'no-such-pkg').status).toBe(100)
    expect(s.listed()).toEqual([])
  })

  it('remove/purge forget; other subcommands leave the list alone', () => {
    const s = setup(0)
    s.run('apt-get', 'install', '-y', 'a', 'b', 'c')
    s.run('apt-get', 'purge', '-y', 'b')
    s.run('apt', 'remove', 'c')
    s.run('apt-get', 'update')
    s.run('apt-get', 'download', 'z')
    expect(s.listed()).toEqual(['a'])
  })
})
