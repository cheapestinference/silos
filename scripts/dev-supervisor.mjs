#!/usr/bin/env node
// dev-supervisor.mjs — `npm run dev` that comes back on its own.
//
// `tsx watch` reloads the server on every save, but when a reload meets code
// that does not compile (a merge mid-way, conflict markers for a second) the
// child dies and tsx does not always start it again once the code is fine —
// the server stays down until someone restarts it by hand (23-11: down from
// 12:40 until noticed). This wraps `tsx watch`: it asks the server's
// /healthz every few seconds and, when nothing has answered for DOWN_MS,
// stops the whole tsx group and starts it again. Broken code keeps failing
// and is retried every cycle; the first cycle after it is fixed brings the
// server back. If tsx itself exits, it is started again.
//
// The deployed paths (Railway, systemd) restart a crashed `node
// server/dist/index.js` themselves and never run sources; this is only the
// development server's safety net.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'server')
const port = Number(process.env.SILOS_PORT ?? process.env.PORT ?? 3210)
const health = `http://127.0.0.1:${port}/healthz`
const EVERY_MS = 10_000
// a boot reads the whole session index before it listens: give it room
const BOOT_GRACE_MS = 120_000
const DOWN_MS = 60_000

const say = (line) => console.log(`[dev-supervisor] ${line}`)
let child = null
let startedAt = 0
let downSince = null
let stopping = false
let restarting = false

function start() {
  startedAt = Date.now()
  downSince = null
  // its own process group: a restart stops tsx AND the server it runs
  child = spawn(join(server, '..', 'node_modules', '.bin', 'tsx'), ['watch', 'src/index.ts'], { cwd: server, stdio: 'inherit', detached: true })
  child.on('exit', (code, signal) => {
    child = null
    if (stopping || restarting) return
    say(`tsx watch exited (${signal ?? code}) — starting it again`)
    setTimeout(start, 2_000)
  })
}

function stopGroup() {
  return new Promise((resolve) => {
    const c = child
    if (!c) return resolve()
    const pgid = c.pid
    const kill = (sig) => {
      try {
        process.kill(-pgid, sig)
      } catch {
        /* gone */
      }
    }
    const hard = setTimeout(() => kill('SIGKILL'), 10_000)
    c.once('exit', () => {
      clearTimeout(hard)
      resolve()
    })
    kill('SIGTERM')
  })
}

async function answers() {
  try {
    const r = await fetch(health, { signal: AbortSignal.timeout(5_000) })
    return r.ok
  } catch {
    return false
  }
}

async function tick() {
  if (stopping || restarting || !child) return
  if (await answers()) {
    downSince = null
    return
  }
  const now = Date.now()
  if (now - startedAt < BOOT_GRACE_MS) return
  downSince ??= now
  if (now - downSince < DOWN_MS) return
  restarting = true
  say(`nothing answered ${health} for ${Math.round((now - downSince) / 1000)} s — restarting tsx watch`)
  await stopGroup()
  restarting = false
  if (!stopping) start()
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    stopping = true
    await stopGroup()
    process.exit(0)
  })
}

start()
setInterval(() => {
  void tick()
}, EVERY_MS)
