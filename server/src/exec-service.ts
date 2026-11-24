import { spawn } from 'node:child_process'
import type { AgentRegistry } from './agent-registry.js'
import { cleanEnv } from './env.js'

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  ms: number
  truncated: boolean
}
const CAP = 200_000

export class ExecService {
  constructor(
    private registry: AgentRegistry,
    private timeoutMs = 30_000,
  ) {}

  async run(agentId: string, command: string): Promise<ExecResult> {
    const agent = this.registry.get(agentId)
    if (!agent) throw new Error('agent not found')
    if (agent.archived) throw new Error('agent archived')
    if (agent.folder === null) throw new Error('master agent has no folder')
    if (command.trim() === '') throw new Error('empty command')

    const env = cleanEnv() // the child doesn't inherit Claude's context

    const t0 = Date.now()
    return await new Promise<ExecResult>((resolvePromise) => {
      // detached: true → the child is the leader of its own process group,
      // so the whole group (bash + any background child left hanging off
      // the stdout pipe, e.g. `sleep 30 &`) can be killed with kill(-pid).
      const child = spawn('bash', ['-c', command], { cwd: agent.folder as string, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      let stdout = ''
      let stderr = ''
      let truncated = false
      let settled = false
      let drainTimer: ReturnType<typeof setTimeout> | null = null
      const feed = (cur: string, chunk: Buffer): string => {
        if (cur.length >= CAP) {
          truncated = true
          return cur
        }
        const next = cur + chunk.toString('utf8')
        if (next.length > CAP) {
          truncated = true
          return next.slice(0, CAP)
        }
        return next
      }
      child.stdout.on('data', (c: Buffer) => {
        stdout = feed(stdout, c)
      })
      child.stderr.on('data', (c: Buffer) => {
        stderr = feed(stderr, c)
      })
      const settle = (code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (drainTimer) clearTimeout(drainTimer)
        resolvePromise({ stdout, stderr, code, ms: Date.now() - t0, truncated })
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-(child.pid as number), 'SIGKILL')
        } catch {
          /* the process may have already exited */
        }
      }, this.timeoutMs)
      timer.unref()
      child.on('exit', (code) => {
        // bash exited but the stdout pipe can stay open (background
        // children inherit the fd) — 'close' would wait for it to close on
        // its own. We give it a short drain grace period and, if it never
        // arrives, resolve anyway with whatever's in the buffer: the turn
        // must not hang over this.
        drainTimer = setTimeout(() => settle(code), 500)
      })
      child.on('close', (code) => {
        settle(code)
      })
      child.on('error', (err) => {
        stderr = stderr + String(err)
        settle(null)
      })
    })
  }
}
