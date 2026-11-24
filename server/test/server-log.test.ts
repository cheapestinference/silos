// server-log.test.ts — durable evidence of the server's life (a dead
// server must leave a trace): every start, every
// write to stdout/stderr and every fatal ends up in <dataDir>/logs/
// server.log, capped by rotation (never unbounded), however the server
// was launched.
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initServerLog, type ServerLog } from '../src/server-log.js'

let log: ServerLog | null = null
afterEach(() => {
  log?.close()
  log = null
})

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'silos-log-'))
}

describe('server-log', () => {
  it('creates logs/server.log under the data dir and stamps a start line with the pid', () => {
    const dir = tmp()
    log = initServerLog(dir)
    const text = readFileSync(join(dir, 'logs', 'server.log'), 'utf8')
    expect(text).toContain('server start')
    expect(text).toContain(`pid=${process.pid}`)
  })

  it('mirrors stdout and stderr writes into the file (the console keeps working)', () => {
    const dir = tmp()
    log = initServerLog(dir)
    process.stdout.write('hello stdout\n')
    process.stderr.write('hello stderr\n')
    const text = readFileSync(join(dir, 'logs', 'server.log'), 'utf8')
    expect(text).toContain('hello stdout')
    expect(text).toContain('hello stderr')
  })

  it('close() stops the mirroring and removes its process listeners', () => {
    const dir = tmp()
    const before = process.listeners('uncaughtException').length
    log = initServerLog(dir)
    expect(process.listeners('uncaughtException').length).toBe(before + 1)
    log.close()
    log = null
    expect(process.listeners('uncaughtException').length).toBe(before)
  })

  it('rotates at maxBytes and never keeps more than 3 files (bounded forever)', () => {
    const dir = tmp()
    log = initServerLog(dir, { maxBytes: 200 })
    for (let i = 0; i < 40; i++) log.line(`filler ${i} ${'x'.repeat(40)}`)
    const files = readdirSync(join(dir, 'logs'))
      .filter((f) => f.startsWith('server.log'))
      .sort()
    expect(files).toEqual(['server.log', 'server.log.1', 'server.log.2'])
    for (const f of files) expect(statSync(join(dir, 'logs', f)).size).toBeLessThan(400)
  })

  it('a fatal leaves the error and its stack as the last evidence', () => {
    const dir = tmp()
    log = initServerLog(dir)
    log.fatal('uncaughtException', new Error('test boom'))
    const text = readFileSync(join(dir, 'logs', 'server.log'), 'utf8')
    expect(text).toContain('FATAL uncaughtException: Error: test boom')
    expect(text).toContain('server-log.test.ts')
  })
})
