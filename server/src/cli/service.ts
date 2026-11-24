// cli/service.ts — `silos service …`: Silos as a background service of THIS
// user, so it outlives the terminal and comes back after a reboot (q4 t48).
// The resident (automations, heartbeats, task wakes) only works while the
// server runs: an install that dies with its terminal runs nothing at night.
//
// Linux: a systemd USER unit (~/.config/systemd/user/silos.service) — no
// root, no dedicated user: the agents are this user's `claude`, signed in
// under this user's home. macOS: a LaunchAgent. Anything else: said plainly.
//
// Two rules the unit keeps:
//   - the consoles survive a restart. Each real console is a tmux session
//     the server reattaches to; a stop that killed the whole process group
//     would kill every open conversation with it (KillMode=process /
//     AbandonProcessGroup).
//   - a clean environment. The unit carries PATH (where `claude`, `tmux` and
//     the other engines are) and Silos' own four settings — never the shell's
//     engine variables (an inherited CLAUDE_*/ANTHROPIC_* would move every
//     turn to another account: inherited-env.ts).
import { join } from 'node:path'

export const UNIT_NAME = 'silos.service'
export const LAUNCHD_LABEL = 'com.silosplatform.silos'
/** The settings a service keeps from the shell that installed it. */
export const CARRIED_ENV = ['SILOS_PORT', 'SILOS_HOST', 'SILOS_DATA_DIR', 'SILOS_ROOT'] as const

export interface ServiceInput {
  platform: NodeJS.Platform
  home: string
  /** the node binary and the server entry it runs */
  node: string
  entry: string
  env: NodeJS.ProcessEnv
  dataDir: string
}

export type ServiceSpec =
  { kind: 'systemd'; file: string; content: string } | { kind: 'launchd'; file: string; content: string } | { kind: 'unsupported'; why: string }

export type ServiceStatus = { kind: 'systemd' | 'launchd'; installed: boolean; active: boolean } | { kind: 'unsupported'; why: string }

export function carriedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  if (env.PATH) out.PATH = env.PATH
  for (const k of CARRIED_ENV) {
    const v = env[k]
    if (v !== undefined && v !== '') out[k] = v
  }
  return out
}

// systemd: a quoted word; `%` is a specifier and `$` an expansion in Exec lines
function sdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}
function sdExec(s: string): string {
  return sdQuote(s).replace(/\$/g, '$$$$')
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function systemdUnit(i: ServiceInput): string {
  const env = Object.entries(carriedEnv(i.env)).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
  return [
    '# Written by `silos service install` — `silos service uninstall` removes it.',
    '[Unit]',
    'Description=Silos',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${sdExec(i.node)} ${sdExec(i.entry)}`,
    ...env,
    'Restart=always',
    'RestartSec=5',
    '# the consoles are tmux sessions the server reattaches to: a restart',
    '# stops the server only, never the conversations',
    'KillMode=process',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export function launchdPlist(i: ServiceInput): string {
  const env = Object.entries(carriedEnv(i.env)).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
  const log = join(i.dataDir, 'logs', 'service.log')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Written by `silos service install`; `silos service uninstall` removes it. -->',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    `  <array><string>${xml(i.node)}</string><string>${xml(i.entry)}</string></array>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env,
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>AbandonProcessGroup</key><true/>',
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

export function serviceSpec(i: ServiceInput, has: (cmd: string) => boolean): ServiceSpec {
  if (i.platform === 'linux') {
    if (!has('systemctl')) return { kind: 'unsupported', why: 'no systemd on this machine' }
    return { kind: 'systemd', file: join(i.home, '.config', 'systemd', 'user', UNIT_NAME), content: systemdUnit(i) }
  }
  if (i.platform === 'darwin') {
    return { kind: 'launchd', file: join(i.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`), content: launchdPlist(i) }
  }
  return { kind: 'unsupported', why: `no service manager Silos knows on ${i.platform}` }
}

/** A copy `npx` fetched lives in npm's cache and is cleaned without notice:
 *  a service must not point there. */
export function isNpxCopy(entry: string): boolean {
  return /[\\/]_npx[\\/]/.test(entry)
}

export type ServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'restart'

export interface Step {
  cmd: string
  args: string[]
  /** a step that may fail without failing the action; `otherwise` is said then */
  optional?: boolean
  otherwise?: string
}

/** The commands an action runs, in order, AFTER the file is written (install)
 *  and BEFORE it is removed (uninstall). */
export function stepsFor(action: ServiceAction, spec: Exclude<ServiceSpec, { kind: 'unsupported' }>, who: { uid: number; user: string }): Step[] {
  if (spec.kind === 'systemd') {
    const sc = (...args: string[]): Step => ({ cmd: 'systemctl', args: ['--user', ...args] })
    switch (action) {
      case 'install':
        return [
          sc('daemon-reload'),
          sc('enable', UNIT_NAME),
          // restart, not start: a reinstall over a running service must run the new file
          sc('restart', UNIT_NAME),
          // without lingering a user service stops at logout and waits for a login after a reboot
          {
            cmd: 'loginctl',
            args: ['enable-linger', who.user],
            optional: true,
            otherwise: `Silos will start when ${who.user} logs in, not at boot. To start it at boot: sudo loginctl enable-linger ${who.user}`,
          },
        ]
      case 'uninstall':
        return [{ ...sc('disable', '--now', UNIT_NAME), optional: true }]
      default:
        return [sc(action, UNIT_NAME)]
    }
  }
  const domain = `gui/${who.uid}`
  const target = `${domain}/${LAUNCHD_LABEL}`
  const lc = (...args: string[]): Step => ({ cmd: 'launchctl', args })
  switch (action) {
    case 'install':
      // a previous copy is unloaded first (bootstrap refuses a loaded label)
      return [{ ...lc('bootout', target), optional: true }, lc('bootstrap', domain, spec.file)]
    case 'uninstall':
    case 'stop':
      return [{ ...lc('bootout', target), optional: true }]
    case 'start':
      return [{ ...lc('bootstrap', domain, spec.file), optional: true }, lc('kickstart', target)]
    case 'restart':
      return [lc('kickstart', '-k', target)]
  }
}

/** Is it installed, is it running — asked of the service manager itself. */
export function statusProbe(spec: Exclude<ServiceSpec, { kind: 'unsupported' }>, who: { uid: number }): Step {
  return spec.kind === 'systemd'
    ? { cmd: 'systemctl', args: ['--user', 'is-active', '--quiet', UNIT_NAME] }
    : { cmd: 'launchctl', args: ['print', `gui/${who.uid}/${LAUNCHD_LABEL}`] }
}

/** Linux only: is this user's systemd reachable from this shell? It is not
 *  from a shell with no login session (a `su`, a container, a cron) unless
 *  the user lingers — and then every `systemctl --user` fails with a bus
 *  error that says nothing an operator can act on. */
export const USER_MANAGER_PROBE: Step = { cmd: 'systemctl', args: ['--user', 'show-environment'] }

export function userManagerHelp(who: { uid: number; user: string }): string[] {
  return [
    'systemd cannot be reached for this user from this shell (there is no login session behind it).',
    `Let ${who.user}'s services run without one, once:  sudo loginctl enable-linger ${who.user}`,
    `then, in this shell:  export XDG_RUNTIME_DIR=/run/user/${who.uid}`,
    'and run this again.',
  ]
}
