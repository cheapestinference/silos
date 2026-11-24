// server-log.ts — durable evidence of the server's life (so a dev-server
// death always leaves a trace to read). Always on, never a
// "debug mode": evidence only exists if it was already being written when
// something died. Every start, everything stdout/stderr carry, and every
// fatal lands in <dataDir>/logs/server.log — however the server was
// launched (npm run dev, systemd, Docker, a bare terminal).
//
// Bounded forever: when server.log passes maxBytes it rotates to .1/.2
// and the oldest is dropped — ~3×maxBytes total, no external cron, no
// maintenance. Writes are sync appends (the volume here is a dev server's
// chatter, not a request log) so the last line before a death is on disk.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ServerLog {
  path: string
  line: (msg: string) => void
  fatal: (kind: string, err: unknown) => void
  close: () => void
}

const KEEP = 3 // server.log + .1 + .2

export function initServerLog(dataDir: string, opts: { maxBytes?: number } = {}): ServerLog {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const dir = join(dataDir, 'logs')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'server.log')

  function rotateIfNeeded(): void {
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      return
    }
    if (size < maxBytes) return
    try {
      rmSync(`${path}.${KEEP - 1}`, { force: true })
      for (let i = KEEP - 2; i >= 1; i--) {
        try {
          renameSync(`${path}.${i}`, `${path}.${i + 1}`)
        } catch {
          /* absent */
        }
      }
      renameSync(path, `${path}.1`)
    } catch {
      /* a failed rotation must never take the server down */
    }
  }

  function append(text: string): void {
    // best-effort by design: logging can never be the thing that crashes.
    try {
      rotateIfNeeded()
      appendFileSync(path, text)
    } catch {
      /* ignore */
    }
  }

  function line(msg: string): void {
    append(`[${new Date().toISOString()}] ${msg}\n`)
  }

  // tee stdout/stderr: the console the launcher sees keeps working, the
  // file remembers. Patched at the write level so fastify's logger, plain
  // console.* and anything else all leave the same trace.
  const outWrite = process.stdout.write.bind(process.stdout)
  const errWrite = process.stderr.write.bind(process.stderr)
  const tee = (orig: typeof outWrite): typeof outWrite =>
    ((chunk: never, ...rest: never[]) => {
      append(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? (chunk as Buffer).toString('utf8') : String(chunk))
      return orig(chunk, ...rest)
    }) as typeof outWrite
  process.stdout.write = tee(outWrite)
  process.stderr.write = tee(errWrite)

  function fatal(kind: string, err: unknown): void {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    line(`FATAL ${kind}: ${detail}`)
  }

  // the last-evidence handlers: write, then die the way node would have —
  // masking a crash as survival would lie to whatever supervises us.
  const onUncaught = (err: unknown): void => {
    fatal('uncaughtException', err)
    process.exit(1)
  }
  const onUnhandled = (reason: unknown): void => {
    fatal('unhandledRejection', reason)
    process.exit(1)
  }
  const onExit = (code: number): void => {
    line(`server exit code=${code}`)
  }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUnhandled)
  process.on('exit', onExit)

  line(`server start pid=${process.pid} node=${process.version}`)

  return {
    path,
    line,
    fatal,
    close: () => {
      process.stdout.write = outWrite
      process.stderr.write = errWrite
      process.removeListener('uncaughtException', onUncaught)
      process.removeListener('unhandledRejection', onUnhandled)
      process.removeListener('exit', onExit)
    },
  }
}
