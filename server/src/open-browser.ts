// open-browser.ts — `silos` (the packaged command, bin/silos.mjs) opens the
// browser on the address the server prints, token included: that click IS
// the browser's pairing («`npx silosplatform` … opens the browser»). Only the packaged command asks for it (`--open`);
// `npm run dev` never opens anything. A machine with no screen to open on
// (no DISPLAY / WAYLAND_DISPLAY on Linux — an SSH session, a server) skips
// it quietly: the printed line is the way in there.
import { spawn } from 'node:child_process'

export function browserCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  if (platform === 'darwin') return 'open'
  if (platform === 'linux') return env.DISPLAY || env.WAYLAND_DISPLAY ? 'xdg-open' : null
  return null
}

export function openBrowser(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  const cmd = browserCommand(platform, env)
  if (!cmd) return false
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined) // no opener installed: the printed line stays the way in
    child.unref()
    return true
  } catch {
    return false
  }
}
