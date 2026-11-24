// cli-install.test.ts — the packaged command's subcommands (q4 t48): what
// doctor says of a machine, what a service file carries, and what an update
// does for each way Silos can have got there. The decisions are pure; the
// machine is injected.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { EngineCompat } from '../src/harness-run.js'
import { dataDirCheck, engineCheck, nodeCheck, portCheck, probePort, renderChecks, runDoctor, serviceCheck, type DoctorDeps } from '../src/cli/doctor.js'
import { carriedEnv, isNpxCopy, launchdPlist, serviceSpec, stepsFor, systemdUnit, type ServiceInput } from '../src/cli/service.js'
import { originOf, uninstallPlan, updatePlan } from '../src/cli/update.js'

const verdict = (over: Partial<EngineCompat>): EngineCompat => ({
  harness: 'engine-a' as EngineCompat['harness'],
  name: 'Engine A',
  state: 'ok',
  installed: '2.0.0',
  needed: '2.0.0',
  update: null,
  refuses: [],
  message: null,
  ...over,
})

const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  nodeVersion: '22.14.0',
  dataDir: join(tmpdir(), 'silos-doctor-absent-dir'),
  host: '127.0.0.1',
  port: 3210,
  onPath: () => '/usr/bin/x',
  loadTerminal: async () => {},
  engines: async () => ({ required: 'engine-a', verdicts: [verdict({})] }),
  portState: async () => 'free',
  service: async () => ({ kind: 'systemd', installed: false, active: false }),
  ...over,
})

describe('silos doctor', () => {
  it('a machine with everything: no warning, no failure', async () => {
    const checks = await runDoctor(deps())
    expect(checks.every((c) => c.state === 'ok')).toBe(true)
    expect(renderChecks(checks)).toContain('Everything Silos needs is here.')
  })

  it('the Node floor is 22.13', () => {
    expect(nodeCheck('22.13.0').state).toBe('ok')
    expect(nodeCheck('24.1.0').state).toBe('ok')
    expect(nodeCheck('22.12.9').state).toBe('fail')
    expect(nodeCheck('20.19.0').state).toBe('fail')
  })

  it('a terminal module that does not load fails with the toolchain as the fix, and the engines are not blamed for it', async () => {
    const checks = await runDoctor(
      deps({
        loadTerminal: async () => {
          throw new Error('Cannot find module pty.node\nstack…')
        },
        engines: async () => {
          throw new Error('same cause')
        },
      }),
    )
    const fails = checks.filter((c) => c.state === 'fail')
    expect(fails).toHaveLength(1)
    expect(fails[0]!.fix).toContain('build-essential')
    expect(fails[0]!.says).not.toContain('stack')
  })

  it('the engine Silos cannot do without fails when missing or old; any other is optional', () => {
    expect(engineCheck(verdict({ state: 'missing', installed: null, update: 'install it' }), true)).toMatchObject({ state: 'fail', fix: 'install it' })
    expect(engineCheck(verdict({ state: 'missing', installed: null }), false)).toBeNull()
    expect(engineCheck(verdict({ state: 'outdated', installed: '1.0.0', update: 'update it' }), true)).toMatchObject({ state: 'fail', fix: 'update it' })
    expect(engineCheck(verdict({ state: 'outdated', installed: '1.0.0' }), false)?.state).toBe('warn')
    // an install is never told the repo's npm command
    expect(engineCheck(verdict({ state: 'ahead', installed: '2.1.0', message: 'npm install -w server …' }), true)).toMatchObject({
      state: 'warn',
      fix: 'silos update',
      says: expect.not.stringContaining('npm'),
    })
  })

  it('missing tmux or git warns — Silos still runs', async () => {
    const checks = await runDoctor(deps({ onPath: () => null }))
    expect(checks.filter((c) => c.state === 'warn').map((c) => c.name)).toEqual(['tmux', 'git'])
    expect(checks.some((c) => c.state === 'fail')).toBe(false)
    expect(renderChecks(checks)).toContain('Silos runs. 2 things worth a look.')
  })

  it('the data directory: absent is fine, open to others warns, not writable fails', () => {
    const base = mkdtempSync(join(tmpdir(), 'silos-doctor-'))
    expect(dataDirCheck(join(base, 'nope')).state).toBe('ok')
    const open = join(base, 'open')
    mkdirSync(open)
    chmodSync(open, 0o755)
    expect(dataDirCheck(open)).toMatchObject({ state: 'warn', fix: `chmod 700 "${open}"` })
    const closed = join(base, 'closed')
    mkdirSync(closed)
    chmodSync(closed, 0o700)
    expect(dataDirCheck(closed).state).toBe('ok')
    if (process.getuid?.() !== 0) {
      const ro = join(base, 'ro')
      mkdirSync(ro)
      chmodSync(ro, 0o500)
      expect(dataDirCheck(ro).state).toBe('fail')
    }
  })

  it('the port: a running Silos and a free port are fine; another program fails with a way out', () => {
    expect(portCheck('silos', '127.0.0.1', 3210).state).toBe('ok')
    expect(portCheck('free', '127.0.0.1', 3210).state).toBe('ok')
    expect(portCheck('taken', '127.0.0.1', 3210)).toMatchObject({ state: 'fail', fix: expect.stringContaining('SILOS_PORT=3211') })
  })

  it('probePort tells a Silos from nobody from something else', async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' })
      res.end('hi')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    expect(await probePort('127.0.0.1', port)).toBe('taken')
    const silos = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
    expect(await probePort('127.0.0.1', port, silos)).toBe('silos')
    srv.closeAllConnections()
    await new Promise((r) => srv.close(r))
    expect(await probePort('127.0.0.1', port)).toBe('free')
  })

  it('the service: not installed is a hint, installed and down is a warning', () => {
    expect(serviceCheck({ kind: 'systemd', installed: false, active: false })).toMatchObject({
      state: 'ok',
      says: expect.stringContaining('silos service install'),
    })
    expect(serviceCheck({ kind: 'systemd', installed: true, active: true }).state).toBe('ok')
    expect(serviceCheck({ kind: 'launchd', installed: true, active: false }).state).toBe('warn')
    expect(serviceCheck({ kind: 'unsupported', why: 'no systemd on this machine' }).state).toBe('ok')
  })
})

const input = (over: Partial<ServiceInput> = {}): ServiceInput => ({
  platform: 'linux',
  home: '/home/op',
  node: '/usr/bin/node',
  entry: '/usr/lib/node_modules/silosplatform/server/dist/index.js',
  env: {
    PATH: '/home/op/.local/bin:/usr/bin',
    SILOS_PORT: '4000',
    SILOS_AGENT_TOKEN: 'secret',
    SILOS_TURN: 't',
    ANTHROPIC_API_KEY: 'k',
    CLAUDE_CONFIG_DIR: '/x',
    HOME: '/home/op',
  },
  dataDir: '/home/op/.silos',
  ...over,
})

describe('silos service', () => {
  it('carries PATH and Silos’ own settings — never the shell’s engine or per-turn variables', () => {
    expect(carriedEnv(input().env)).toEqual({ PATH: '/home/op/.local/bin:/usr/bin', SILOS_PORT: '4000' })
    for (const text of [systemdUnit(input()), launchdPlist(input())]) {
      expect(text).toContain('SILOS_PORT')
      for (const leak of ['ANTHROPIC', 'CLAUDE_', 'SILOS_AGENT_TOKEN', 'SILOS_TURN', 'secret']) expect(text).not.toContain(leak)
    }
  })

  it('a stop or restart never kills the consoles: the unit stops the server process only', () => {
    expect(systemdUnit(input())).toContain('KillMode=process')
    expect(launchdPlist(input())).toContain('<key>AbandonProcessGroup</key><true/>')
  })

  it('the systemd unit is a user unit that restarts and quotes awkward paths', () => {
    const unit = systemdUnit(input({ node: '/opt/my node/bin/node', entry: '/srv/100%/a$b/index.js' }))
    expect(unit).toContain('ExecStart="/opt/my node/bin/node" "/srv/100%%/a$$b/index.js"')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=default.target')
    // a user unit: no User=, and no system target it cannot order against
    expect(unit).not.toMatch(/^User=/m)
    expect(unit).not.toContain('network-online.target')
  })

  it('the plist escapes what XML reserves', () => {
    expect(launchdPlist(input({ entry: '/a&b/<c>/index.js' }))).toContain('<string>/a&amp;b/&lt;c&gt;/index.js</string>')
  })

  it('where the file goes per platform, and where there is no service manager', () => {
    expect(serviceSpec(input(), () => true)).toMatchObject({ kind: 'systemd', file: '/home/op/.config/systemd/user/silos.service' })
    expect(serviceSpec(input(), () => false)).toMatchObject({ kind: 'unsupported' })
    expect(serviceSpec(input({ platform: 'darwin', home: '/Users/op' }), () => true)).toMatchObject({
      kind: 'launchd',
      file: '/Users/op/Library/LaunchAgents/com.silosplatform.silos.plist',
    })
    expect(serviceSpec(input({ platform: 'win32' }), () => true)).toMatchObject({ kind: 'unsupported' })
  })

  it('install enables, (re)starts and asks for boot start; a refused linger says what is left, never fails the install', () => {
    const spec = serviceSpec(input(), () => true) as Extract<ReturnType<typeof serviceSpec>, { kind: 'systemd' }>
    const steps = stepsFor('install', spec, { uid: 1000, user: 'op' })
    expect(steps.map((s) => `${s.cmd} ${s.args.join(' ')}`)).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable silos.service',
      'systemctl --user restart silos.service',
      'loginctl enable-linger op',
    ])
    expect(steps[3]).toMatchObject({ optional: true, otherwise: expect.stringContaining('sudo loginctl enable-linger op') })
    expect(stepsFor('uninstall', spec, { uid: 1000, user: 'op' })[0]).toMatchObject({ args: ['--user', 'disable', '--now', 'silos.service'], optional: true })
  })

  it('launchd: install reloads a previous copy; restart kicks the running one', () => {
    const spec = serviceSpec(input({ platform: 'darwin', home: '/Users/op' }), () => true) as Extract<ReturnType<typeof serviceSpec>, { kind: 'launchd' }>
    expect(stepsFor('install', spec, { uid: 501, user: 'op' }).map((s) => s.args.join(' '))).toEqual([
      'bootout gui/501/com.silosplatform.silos',
      `bootstrap gui/501 ${spec.file}`,
    ])
    expect(stepsFor('restart', spec, { uid: 501, user: 'op' })[0]!.args).toEqual(['kickstart', '-k', 'gui/501/com.silosplatform.silos'])
  })

  it('a copy in npx’s cache is told apart', () => {
    expect(isNpxCopy('/home/op/.npm/_npx/ab12/node_modules/silosplatform/server/dist/index.js')).toBe(true)
    expect(isNpxCopy('/usr/lib/node_modules/silosplatform/server/dist/index.js')).toBe(false)
  })
})

describe('silos update · uninstall', () => {
  const installed = '/usr/lib/node_modules/silosplatform/server/dist/index.js'

  it('how the copy got here: the package’s name and its path', () => {
    expect(originOf('silosplatform', installed)).toBe('installed')
    expect(originOf('silosplatform', '/home/op/.npm/_npx/ab/node_modules/silosplatform/server/dist/index.js')).toBe('npx')
    expect(originOf('silos', '/home/op/silos/server/dist/index.js')).toBe('source')
    expect(originOf(null, installed)).toBe('source')
  })

  it('an installed copy moves to the newest with npm; the same or an older registry changes nothing', () => {
    expect(updatePlan({ origin: 'installed', current: '0.1.0', latest: '0.2.0' })).toEqual({
      kind: 'install',
      from: '0.1.0',
      to: '0.2.0',
      cmd: 'npm',
      args: ['install', '-g', 'silosplatform@0.2.0'],
    })
    expect(updatePlan({ origin: 'installed', current: '0.2.0', latest: '0.2.0' }).kind).toBe('say')
    expect(updatePlan({ origin: 'installed', current: '0.3.0', latest: '0.2.0' }).kind).toBe('say')
  })

  it('--check only says; --version goes to that one, older included (the way back)', () => {
    expect(updatePlan({ origin: 'installed', current: '0.1.0', latest: '0.2.0', checkOnly: true })).toMatchObject({
      kind: 'say',
      lines: [expect.stringContaining('0.2.0 is available')],
    })
    expect(updatePlan({ origin: 'installed', current: '0.3.0', latest: null, pin: '0.2.0' })).toMatchObject({ kind: 'install', to: '0.2.0' })
    expect(updatePlan({ origin: 'installed', current: '0.3.0', latest: null, pin: '0.2.0; rm -rf ~' }).kind).toBe('say')
  })

  it('an unreachable registry is said, never guessed', () => {
    expect(updatePlan({ origin: 'installed', current: '0.1.0', latest: null })).toMatchObject({
      kind: 'say',
      lines: [expect.stringContaining('Could not ask npm')],
    })
  })

  it('npx and source copies are told their own command; nothing runs', () => {
    expect(updatePlan({ origin: 'npx', current: '0.1.0', latest: '0.2.0' })).toMatchObject({
      kind: 'say',
      lines: expect.arrayContaining([expect.stringContaining('npx silosplatform@latest')]),
    })
    expect(updatePlan({ origin: 'source', current: '0.1.0', latest: '0.2.0' })).toMatchObject({
      kind: 'say',
      lines: expect.arrayContaining([expect.stringContaining('git pull')]),
    })
    expect(uninstallPlan('installed')).toEqual({ cmd: 'npm', args: ['uninstall', '-g', 'silosplatform'] })
    expect(uninstallPlan('npx')).toHaveProperty('say')
    expect(uninstallPlan('source')).toHaveProperty('say')
  })
})
