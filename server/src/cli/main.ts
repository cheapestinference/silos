// cli/main.ts — the packaged command's subcommands (bin/silos.mjs hands
// them here; with none, it starts the server): doctor · service · update ·
// uninstall (q4 t48). The decisions live in the three modules beside this
// one, as pure functions; this file only reads the machine and runs what
// they decided.
import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultConfig } from '../config.js'
import { executableOnPath } from '../engine-path.js'
import { probePort, renderChecks, runDoctor, portCheck } from './doctor.js'
import {
  isNpxCopy,
  serviceSpec,
  statusProbe,
  stepsFor,
  USER_MANAGER_PROBE,
  userManagerHelp,
  type ServiceAction,
  type ServiceSpec,
  type ServiceStatus,
  type Step,
} from './service.js'
import { originOf, PACKAGE, uninstallPlan, updatePlan } from './update.js'

const cfg = defaultConfig()
// server/dist/cli/main.js → server/dist/index.js and the package's manifest
const entry = join(import.meta.dirname, '..', 'index.js')
const manifest = join(import.meta.dirname, '..', '..', '..', 'package.json')
const onPath = (cmd: string): string | null => executableOnPath(cmd, process.env.PATH)
const who = (): { uid: number; user: string } => {
  const u = userInfo()
  return { uid: u.uid, user: u.username }
}
const say = (...lines: string[]): void => {
  for (const l of lines) console.log(l)
}

function pkg(): { name: string | null; version: string } {
  try {
    const p = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown }
    return { name: typeof p.name === 'string' ? p.name : null, version: typeof p.version === 'string' ? p.version : '?' }
  } catch {
    return { name: null, version: '?' }
  }
}

function spec(): ServiceSpec {
  return serviceSpec(
    { platform: process.platform, home: homedir(), node: process.execPath, entry, env: process.env, dataDir: cfg.dataDir },
    (c) => onPath(c) !== null,
  )
}

function quiet(step: Step): boolean {
  return spawnSync(step.cmd, step.args, { stdio: 'ignore' }).status === 0
}

async function serviceStatus(): Promise<ServiceStatus> {
  const s = spec()
  if (s.kind === 'unsupported') return s
  const installed = existsSync(s.file)
  return { kind: s.kind, installed, active: installed && quiet(statusProbe(s, who())) }
}

/** Runs an action's steps; false when a required one failed. */
function runSteps(steps: Step[]): boolean {
  for (const step of steps) {
    if (step.optional) {
      if (!quiet(step) && step.otherwise) say(step.otherwise)
      continue
    }
    if (spawnSync(step.cmd, step.args, { stdio: 'inherit' }).status !== 0) {
      console.error(`failed: ${step.cmd} ${step.args.join(' ')}`)
      return false
    }
  }
  return true
}

async function waitUntilUp(ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if ((await probePort(cfg.host, cfg.port)) === 'silos') return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function address(): string {
  let token = ''
  try {
    token = readFileSync(join(cfg.dataDir, 'token'), 'utf8').trim()
  } catch {
    /* not written yet */
  }
  return `http://${cfg.host}:${cfg.port}/${token ? `?token=${token}` : ''}`
}

async function doctor(): Promise<number> {
  const checks = await runDoctor({
    nodeVersion: process.versions.node,
    dataDir: cfg.dataDir,
    host: cfg.host,
    port: cfg.port,
    onPath,
    loadTerminal: async () => {
      await import('node-pty')
    },
    engines: async () => {
      // loaded here, not at the top: the adapters pull the terminal module,
      // and doctor must still speak when that one is broken
      await import('../harnesses/index.js')
      const [{ HarnessService }, { fallbackHarness }] = await Promise.all([import('../harness.js'), import('../harnesses/registry.js')])
      return { required: fallbackHarness().id, verdicts: await new HarnessService().compatibility() }
    },
    portState: () => probePort(cfg.host, cfg.port),
    service: serviceStatus,
  })
  say(renderChecks(checks))
  return checks.some((c) => c.state === 'fail') ? 1 : 0
}

async function service(sub: string | undefined): Promise<number> {
  const s = spec()
  if (sub === 'logs') {
    const log = join(cfg.dataDir, 'logs', 'server.log')
    if (!existsSync(log)) {
      say(`No log yet at ${log} — Silos has not started on this data directory.`)
      return 1
    }
    return await new Promise((resolve) =>
      spawn('tail', ['-n', '100', '-f', log], { stdio: 'inherit' })
        .on('exit', (c) => resolve(c ?? 0))
        .on('error', (err) => {
          say(`Could not run tail: ${err.message}`)
          resolve(1)
        }),
    )
  }
  if (s.kind === 'unsupported') {
    say(
      `Silos cannot install itself as a service here: ${s.why}.`,
      'It runs while its terminal is open — start it inside tmux, or under your own process manager, to keep it up.',
    )
    return 1
  }
  if (s.kind === 'systemd' && !quiet(USER_MANAGER_PROBE)) {
    say(...userManagerHelp(who()))
    return 1
  }
  const status = (await serviceStatus()) as Exclude<ServiceStatus, { kind: 'unsupported' }>
  if (sub === 'status' || sub === undefined) {
    say(
      !status.installed
        ? 'Not installed. `silos service install` keeps Silos running after this terminal closes and after a reboot.'
        : status.active
          ? `Installed and running — ${address()}`
          : 'Installed but not running. `silos service start` starts it; `silos service logs` shows what it said last.',
    )
    return status.installed && !status.active ? 1 : 0
  }
  if (sub === 'install') {
    if (isNpxCopy(entry)) {
      say(
        'This copy of Silos was fetched by npx and lives in npm’s temporary cache: a service cannot point there.',
        `Install it for good first:  npm install -g ${PACKAGE}`,
        'then:  silos service install',
      )
      return 1
    }
    if (!existsSync(entry)) {
      say(`There is no built server at ${entry} — build it first (npm run build).`)
      return 1
    }
    if (!status.active) {
      const port = await probePort(cfg.host, cfg.port)
      if (port === 'silos') {
        say(`A Silos is already running at http://${cfg.host}:${cfg.port} from a terminal. Stop it there (Ctrl-C), then run this again.`)
        return 1
      }
      if (port === 'taken') {
        const c = portCheck(port, cfg.host, cfg.port)
        say(`${c.name}: ${c.says}`, `  → ${c.fix}`)
        return 1
      }
    }
    mkdirSync(dirname(s.file), { recursive: true })
    mkdirSync(join(cfg.dataDir, 'logs'), { recursive: true, mode: 0o700 })
    writeFileSync(s.file, s.content, { mode: 0o644 })
    if (!runSteps(stepsFor('install', s, who()))) return 1
    if (!(await waitUntilUp(20_000))) {
      say('Installed, but Silos did not answer within 20 s. What it said: silos service logs')
      return 1
    }
    say(
      `Silos runs as a service: ${address()}`,
      'It restarts on its own and comes back after a reboot.',
      'silos service status · logs · restart · stop · uninstall',
    )
    return 0
  }
  if (sub === 'uninstall') {
    if (!status.installed) {
      say('No Silos service is installed.')
      return 0
    }
    runSteps(stepsFor('uninstall', s, who()))
    rmSync(s.file, { force: true })
    if (s.kind === 'systemd') quiet({ cmd: 'systemctl', args: ['--user', 'daemon-reload'] })
    say('The Silos service is removed. Open conversations in their consoles keep running; `silos` starts it from a terminal.')
    return 0
  }
  if (sub === 'start' || sub === 'stop' || sub === 'restart') {
    if (!status.installed) {
      say('No Silos service is installed. `silos service install` installs it.')
      return 1
    }
    if (!runSteps(stepsFor(sub as ServiceAction, s, who()))) return 1
    if (sub === 'stop') {
      say('Silos is stopped. Its consoles keep running; `silos service start` brings it back.')
      return 0
    }
    if (!(await waitUntilUp(20_000))) {
      say('Silos did not answer within 20 s. What it said: silos service logs')
      return 1
    }
    say(`Silos is running: ${address()}`)
    return 0
  }
  say(`Unknown: silos service ${sub}`, 'silos service install · status · logs · start · stop · restart · uninstall')
  return 1
}

function published(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('npm', ['view', PACKAGE, 'version'], { timeout: 20_000 }, (err, stdout) => {
      const v = String(stdout ?? '').trim()
      resolve(!err && /^\d+\.\d+\.\d+/.test(v) ? v : null)
    })
  })
}

async function update(args: string[]): Promise<number> {
  const p = pkg()
  const origin = originOf(p.name, entry)
  const at = args.indexOf('--version')
  const pin = at >= 0 ? args[at + 1] : undefined
  if (at >= 0 && !pin) {
    say('silos update --version x.y.z')
    return 1
  }
  const latest = origin === 'installed' && !pin ? await published() : null
  const plan = updatePlan({ origin, current: p.version, latest, pin, checkOnly: args.includes('--check') })
  // a registry that could not be asked is a failed update, not «nothing to do»
  if (plan.kind === 'say') {
    say(...plan.lines)
    return origin === 'installed' && !pin && latest === null ? 1 : 0
  }
  say(`Silos ${plan.from} → ${plan.to}`)
  if (spawnSync(plan.cmd, plan.args, { stdio: 'inherit' }).status !== 0) {
    say(
      `npm could not install ${PACKAGE}@${plan.to}. If it could not write its global folder, run it the way you installed Silos:`,
      `  ${plan.cmd} ${plan.args.join(' ')}`,
    )
    return 1
  }
  const s = spec()
  const status = await serviceStatus()
  if (s.kind !== 'unsupported' && status.kind !== 'unsupported' && status.active) {
    if (!runSteps(stepsFor('restart', s, who())) || !(await waitUntilUp(20_000))) {
      say(`Silos ${plan.to} is installed, but the service did not come back. What it said: silos service logs`)
      return 1
    }
    say(`Silos ${plan.to} is running. Open conversations in their consoles were not interrupted.`)
    return 0
  }
  say(`Silos ${plan.to} is installed. Restart Silos to run it.`, `Going back: silos update --version ${plan.from}`)
  return 0
}

async function uninstall(): Promise<number> {
  const s = spec()
  if (s.kind !== 'unsupported' && existsSync(s.file)) await service('uninstall')
  const plan = uninstallPlan(originOf(pkg().name, entry))
  if ('say' in plan) say(plan.say)
  else if (spawnSync(plan.cmd, plan.args, { stdio: 'inherit' }).status !== 0) {
    say('npm could not remove it. Run it the way you installed Silos:', `  ${plan.cmd} ${plan.args.join(' ')}`)
    return 1
  }
  say(
    `Your data is untouched: ${cfg.dataDir} (agents, automations, the vault) and your agents' folders and transcripts.`,
    `To remove Silos' own state too, delete ${cfg.dataDir} yourself.`,
  )
  return 0
}

export const COMMANDS = ['doctor', 'service', 'update', 'uninstall'] as const

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'doctor':
      return doctor()
    case 'service':
      return service(rest[0])
    case 'update':
      return update(rest)
    case 'uninstall':
      return uninstall()
    default:
      say(`Unknown command: ${cmd ?? ''}`, `silos ${COMMANDS.join(' · ')}`)
      return 1
  }
}
