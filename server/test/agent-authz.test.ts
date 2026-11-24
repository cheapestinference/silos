import { describe, expect, it } from 'vitest'
import { agentMayRead, agentMayWrite } from '../src/agent-authz.js'

describe('agentMayWrite', () => {
  const cases: Array<[string, string, string, boolean]> = [
    ['builder', 'POST', '/api/agents/finance/messages', true],
    ['builder', 'PATCH', '/api/agents/finance', false],
    ['builder', 'GET', '/api/agents', true],
    ['builder', 'PATCH', '/api/agents/builder/messages/abc', true],
    ['builder', 'PATCH', '/api/agents/finance/messages/abc', false],
    ['builder', 'DELETE', '/api/sessions/x/y', false],
    ['builder', 'POST', '/api/automations', true],
    ['builder', 'PATCH', '/api/automations/abc', true], // the route checks ownership
    ['builder', 'PATCH', '/api/automations/abc/runs', false],
    // withdrawing its own recurring work: the route
    // lets only origin:'self' of the caller through
    ['builder', 'DELETE', '/api/automations/abc', true],
    ['builder', 'DELETE', '/api/automations/%61bc', true],
    ['builder', 'DELETE', '/api/automations/templates/t1', false],
    ['builder', 'DELETE', '/api/automations', false],
    ['builder', 'DELETE', '/api/automations/abc/runs', false],
    // /api/support is gone (support is a silo): no agent route left there
    ['builder', 'PATCH', '/api/support/cases/builder/c1', false],
    ['builder', 'POST', '/api/support/cases/builder/c1/threads/t1/move', false],
    ['builder', 'PATCH', '/api/support/cases/finance/c1', false],
    ['builder', 'POST', '/api/agents/builder/token/rotate', false],
    // resolving a plan task from Needs you is the owner's (Done / Drop)
    ['builder', 'POST', '/api/plans/task', false],
    ['builder', 'POST', '/api/%70lans/task', false],
    ['builder', 'POST', '/api/agents/finance/messages?x=1', true],
    ['builder', 'POST', '/api/agents/finance/messages/extra', false],
    ['builder', 'HEAD', '/api/agents', true],
    ['builder', 'OPTIONS', '/api/agents', true],
    ['finance', 'POST', '/api/silos', false],
    // a silo's producer writes its own records and proposals, nothing else
    ['finance', 'PUT', '/api/silos/invoices/agents/finance/records/hd-1', true],
    ['finance', 'PUT', '/api/silos/invoices/agents/builder/records/hd-1', false],
    ['finance', 'PUT', '/api/silos/invoices/agents/finance/records', false],
    ['finance', 'POST', '/api/silos/invoices/agents/finance/proposals', true],
    ['finance', 'POST', '/api/silos/invoices/agents/builder/proposals', false],
    ['finance', 'POST', '/api/silos/invoices/record/set-field', false],
    // append-item is open to a bearer: roles by the
    // kernel, identity by the actions layer; ensure and respond stay the owner's
    ['x', 'POST', '/api/silos/plans/record/append', true],
    ['x', 'POST', '/api/silos/plans/record/ensure', false],
    ['x', 'POST', '/api/silos/plans/record/respond', false],
    ['finance', 'POST', '/api/silos/invoices/proposals/x/approve', false],
    ['finance', 'PUT', '/api/silos/invoices/agents/%66inance/records/hd-1', true],
    // validating a draft costs nothing and decides nothing — an author
    // agent checks its manifest BEFORE submitting (the route
    // exists for exactly that, so an agent must be able to call it)
    ['finance', 'POST', '/api/silos/validate', true],
    ['finance', 'POST', '/api/silos/%76alidate', true],
    ['finance', 'POST', '/api/silos/validate/x', false],
    // submitting is the agent's gesture; deciding is the owner's
    ['finance', 'POST', '/api/silos/submissions', true],
    ['finance', 'POST', '/api/silos/%73ubmissions', true],
    ['finance', 'POST', '/api/silos/submissions/', false],
    ['finance', 'POST', '/api/silos/submissions/invoices/approve', false],
    ['finance', 'POST', '/api/silos/submissions/invoices/reject', false],
    ['finance', 'POST', '/api/silos/invoices/uninstall', false],
    ['finance', 'PATCH', '/api/silos/invoices/operator', false],
    // Settings › Silos' door back is the owner's gesture
    ['finance', 'POST', '/api/silos/invoices/resubmit', false],
    ['finance', 'POST', '/api/silos/%69nvoices/resubmit', false],
    ['finance', 'POST', '/api/silos/%2573ubmissions', false],
    // its own tools (agent-tools.ts) are the owner's to change — never its own
    ['finance', 'POST', '/api/agents/finance/tools', false],
    ['finance', 'POST', '/api/agents/finance/tools/activate', false],
    ['finance', 'DELETE', '/api/agents/finance/tools/books', false],
    ['finance', 'POST', '/api/agents/builder/tools/hold', false],
  ]
  it.each(cases)('%s %s %s → %s', (agent, method, url, expected) => {
    expect(agentMayWrite(agent, method, url)).toBe(expected)
  })
})

describe('agentMayRead (allow-list over decoded segments)', () => {
  const cases: Array<[string, string, boolean]> = [
    ['builder', '/api/board', false],
    ['builder', '/api/board?x=1', false],
    // another agent's tool config is never read (its own: refs only)
    ['builder', '/api/agents/finance/tools', false],
    ['finance', '/api/agents/finance/tools', true],
    ['builder', '/api/file/raw?path=/home/user/.silos/agent-state/finance/inbox/a.json', false],
    ['builder', '/api/files', false],
    ['builder', '/api/sessions/f/id', false],
    ['builder', '/api/needs-you', false],
    ['builder', '/api/overview', false],
    ['builder', '/api/vault', false],
    // the silo registry is the owner's: agents don't manage silos in v0
    ['builder', '/api/silos', false],
    ['builder', '/api/silos/invoices', false],
    ['finance', '/api/silos?x=1', false],
    ['finance', '/api/silos/invoices/agents/finance/merged', true],
    ['finance', '/api/silos/invoices/agents/finance/proposals', true],
    ['finance', '/api/silos/invoices/agents/builder/merged', false],
    ['finance', '/api/silos/invoices/records', false],
    ['finance', '/api/silos/invoices/record?key=x', false],
    ['finance', '/api/silos/invoices/agents/finance/records/hd-1', false],
    ['finance', '/api/silos/submissions', false],
    ['finance', '/api/silos/submissions/invoices/consequences', false],
    ['finance', '/api/silos/operator', false],
    ['builder', '/api/territory', false],
    ['builder', '/api', false],
    ['builder', '/api/agents', true],
    ['builder', '/api/agents/', false],
    ['builder', '/api/agents/builder', true],
    ['builder', '/api/agents/builder/messages?state=new', true],
    ['builder', '/api/agents/finance/messages', false],
    ['builder', '/api/agents/finance', false],
    ['builder', '/api/support/cases/builder', false],
    ['builder', '/api/support/cases/builder/c1', false],
    ['builder', '/api/support/cases/finance/c1', false],
    ['builder', '/api/support/cases', false],
    ['builder', '/api/support/cases?agentId=builder', false],
    ['builder', '/api/automations', true],
    ['builder', '/api/automations?x=1', true],
    ['builder', '/api/automations/a1/runs', true],
    // a command run's log is the owner's (command automations)
    ['builder', '/api/automations/a1/runs/r1/log', false],
    ['builder', '/api/automations/a1/runs/r1/%6cog', false],
    // encoded spellings route as their decoded form in Fastify
    ['builder', '/api/%62oard', false],
    ['builder', '/%61pi/board', false],
    ['builder', '/api/agents/%62uilder/messages', true],
    ['builder', '/api/agents/%66inance/messages', false],
    ['builder', '/api/agents/%2563to/messages', false],
    ['builder', '/api/%zz', false],
    ['builder', '/api//agents', false],
    ['builder', '/api/agents/builder/../../board', false],
    ['builder', '/api/agents/builder/./messages', false],
    ['builder', '/healthz', true],
    ['builder', '/', true],
  ]
  it.each(cases)('%s GET %s → %s', (agent, url, expected) => {
    expect(agentMayRead(agent, url)).toBe(expected)
  })
})

describe('agentMayWrite over decoded segments', () => {
  const cases: Array<[string, string, string, boolean]> = [
    ['builder', 'PATCH', '/api/agents/%62uilder/messages/x', true],
    ['builder', 'PATCH', '/api/agents/%66inance/messages/x', false],
    ['builder', 'PATCH', '/api/agents/builder/messages/%zz', false],
    ['builder', 'POST', '/api/%61utomations', true],
    ['builder', 'PATCH', '/api/support/cases/%66inance/c1', false],
    ['builder', 'PATCH', '/api/agents/builder/messages/', false],
  ]
  it.each(cases)('%s %s %s → %s', (agent, method, url, expected) => {
    expect(agentMayWrite(agent, method, url)).toBe(expected)
  })
})
