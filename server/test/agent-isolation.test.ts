// agent-isolation.test.ts — a link an agent plants in its OWN state that
// points into ANOTHER agent's state is never read or written through (fifth
// review round: with the whole agent-state base as the containment root, a
// link from one agent's dir into another's was "inside"). Same rule for a
// project's private context scopes: context/<A> → context/<B> is refused.
// (Messages left the agents' state with t6: ~/.silos/messages, the server's.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextService } from '../src/context-service.js'
import { containedAgentDir } from '../src/contained-dir.js'

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agent-iso-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe("an agent's state is its own — a link into another agent's is never followed", () => {
  it("an agent's state dir that is itself a link (to a sibling) refuses", () => {
    mkdirSync(join(base, 'bob', 'silos'), { recursive: true })
    symlinkSync(join(base, 'bob'), join(base, 'alice'))
    expect(() => containedAgentDir(base, 'alice', ['silos'], { create: true })).toThrow(/is a link/)
  })

  it("a link inside the agent's own state that stays in it is still followed", () => {
    mkdirSync(join(base, 'alice', 'real'), { recursive: true })
    symlinkSync(join(base, 'alice', 'real'), join(base, 'alice', 'alias'))
    expect(containedAgentDir(base, 'alice', ['alias'], { create: false })).toBe(join(base, 'alice', 'real'))
  })

  it("a silo folder that links into another agent's state refuses (finance/silos/invoices → ../../bob/silos/invoices)", () => {
    mkdirSync(join(base, 'bob', 'silos', 'invoices'), { recursive: true })
    mkdirSync(join(base, 'finance', 'silos'), { recursive: true })
    symlinkSync(join(base, 'bob', 'silos', 'invoices'), join(base, 'finance', 'silos', 'invoices'))
    expect(() => containedAgentDir(base, 'finance', ['silos', 'invoices'], { create: true })).toThrow(/leads outside/)
  })
})

describe("a project's private context scope is its own", () => {
  it("context/builder → context/finance: an upload for builder refuses and builder's list never shows finance's files", () => {
    const F = join(base, 'proj')
    mkdirSync(join(F, 'context', 'finance'), { recursive: true })
    writeFileSync(join(F, 'context', 'finance', 'payroll.md'), 'private to finance')
    symlinkSync(join(F, 'context', 'finance'), join(F, 'context', 'builder'))
    const ctx = new ContextService()
    expect(() => ctx.save(F, 'agent', 'builder', 'x.md', Buffer.from('y'))).toThrow(/another scope/)
    expect(existsSync(join(F, 'context', 'finance', 'x.md'))).toBe(false)
    const listed = ctx.list([F], 'builder')
    expect(listed.agent.map((f) => f.name)).toEqual([])
    expect(readFileSync(join(F, 'context', 'finance', 'payroll.md'), 'utf8')).toBe('private to finance')
  })
})
