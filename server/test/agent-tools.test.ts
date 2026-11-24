// agent-tools.ts — an agent's own MCP servers: the engine
// file holds the active ones, Silos' held twin the rest; a config never holds
// a secret value; nothing outside the agent's plugin is ever written.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStateStore } from '../src/agent-state.js'
import { AgentTools, AgentToolError, checkOwnToolConfig } from '../src/agent-tools.js'
import { rolePluginFor } from '../src/role-plugin.js'

let base: string, state: AgentStateStore, tools: AgentTools
const plugin = (id = 'finance'): string => join(base, 'agent-state', id, 'plugin')
const servers = (file: string, id = 'finance'): Record<string, unknown> => JSON.parse(readFileSync(join(plugin(id), file), 'utf8')).mcpServers
const stdio = { command: 'npx', args: ['-y', 'some-mcp'], env: { API_KEY: '${SOME_API_KEY}' } }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silos-agent-tools-'))
  state = new AgentStateStore(join(base, 'agent-state'))
  tools = new AgentTools(state)
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('AgentTools states', () => {
  it('add writes the engine file + a manifest; the plugin then loads with no skill', () => {
    tools.add('finance', 'Finance', 'books', stdio)
    expect(servers('.mcp.json')).toEqual({ books: stdio })
    expect(existsSync(join(plugin(), '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(rolePluginFor('finance', join(base, 'agent-state', 'finance'))).toBe(plugin())
    // another agent of the same folder gets nothing
    expect(tools.list('builder')).toEqual([])
  })

  it('hold moves it out of the engine file, activate back; the config survives both ways', () => {
    tools.add('finance', 'Finance', 'books', stdio)
    tools.hold('finance', 'Finance', 'books')
    expect(servers('.mcp.json')).toEqual({})
    expect(servers('.silos-held.mcp.json')).toEqual({ books: stdio })
    expect(rolePluginFor('finance', join(base, 'agent-state', 'finance'))).toBeNull()
    expect(tools.list('finance').map((r) => [r.name, r.state])).toEqual([['books', 'held']])
    tools.hold('finance', 'Finance', 'books') // idempotent
    tools.activate('finance', 'Finance', 'books')
    expect(servers('.mcp.json')).toEqual({ books: stdio })
    expect(servers('.silos-held.mcp.json')).toEqual({})
  })

  it('a duplicate name (active or held) is refused; unknown names are 404; remove deletes from either file', () => {
    tools.add('finance', 'Finance', 'books', stdio)
    tools.add('finance', 'Finance', 'remote', { type: 'http', url: 'https://mcp.example.test/v1', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' } })
    tools.hold('finance', 'Finance', 'remote')
    expect(() => tools.add('finance', 'Finance', 'remote', stdio)).toThrow(expect.objectContaining({ status: 409 }))
    expect(() => tools.hold('finance', 'Finance', 'nope')).toThrow(expect.objectContaining({ status: 404 }))
    tools.remove('finance', 'Finance', 'remote')
    tools.remove('finance', 'Finance', 'books')
    expect(tools.list('finance')).toEqual([])
    expect(() => tools.remove('finance', 'Finance', 'books')).toThrow(AgentToolError)
  })

  it('needs = the refs the Vault does not give it', () => {
    tools.add('finance', 'Finance', 'books', { command: 'srv', env: { A: '${HAVE_IT}', B: '${MISSING_ONE}' } })
    const [row] = tools.list('finance', new Set(['HAVE_IT']))
    expect(row?.refs).toEqual(['HAVE_IT', 'MISSING_ONE'])
    expect(row?.needs).toEqual(['MISSING_ONE'])
  })

  it('prototype names in a hand-edited file are data', () => {
    mkdirSync(plugin(), { recursive: true })
    writeFileSync(join(plugin(), '.mcp.json'), '{"mcpServers":{"__proto__":{"command":"x"},"constructor":{"command":"y"}}}')
    expect(tools.list('finance').map((r) => r.name)).toEqual(['__proto__', 'constructor'])
    expect(() => tools.add('finance', 'Finance', 'constructor', stdio)).toThrow(expect.objectContaining({ status: 409 }))
    tools.hold('finance', 'Finance', 'constructor')
    expect(Object.keys(servers('.silos-held.mcp.json'))).toEqual(['constructor'])
  })

  it('never writes through a plugin dir the agent replaced with a link', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    mkdirSync(join(base, 'agent-state', 'finance'), { recursive: true })
    symlinkSync(outside, plugin())
    expect(() => tools.add('finance', 'Finance', 'books', stdio)).toThrow()
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('checkOwnToolConfig — no secret value in a file', () => {
  const bad = (cfg: unknown): void => {
    expect(() => checkOwnToolConfig(cfg)).toThrow(expect.objectContaining({ status: 400 }))
  }
  it('refuses literal env values and literal header secrets', () => {
    bad({ command: 'srv', env: { API_KEY: 'sk-literal' } })
    bad({ command: 'srv', env: { API_KEY: 'prefix-${SOME_KEY}' } })
    bad({ type: 'http', url: 'https://x.test', headers: { Authorization: 'Bearer sk-literal' } })
  })
  it('refuses refs that are not Vault names (Silos wiring, provider layer)', () => {
    bad({ command: 'srv', env: { T: '${SILOS_AGENT_TOKEN}' } })
    bad({ command: 'srv', env: { T: '${ANTHROPIC_API_KEY}' } })
    bad({ type: 'http', url: 'https://x.test', headers: { Authorization: 'Bearer ${SILOS_TURN}' } })
  })
  it('refuses stray braces, control characters, non-http urls and unknown types', () => {
    bad({ command: 'srv', args: ['{file:/etc/passwd}'] })
    bad({ command: 'srv\nrm -rf' })
    bad({ type: 'http', url: 'file:///etc/passwd' })
    bad({ type: 'ws', url: 'https://x.test' })
    bad({ command: '' })
  })
  it('accepts Vault refs in args, env, url and headers', () => {
    expect(checkOwnToolConfig({ command: 'srv', args: ['--key', '${SOME_KEY}'], env: { K: '${SOME_KEY}' } })).toEqual({
      command: 'srv',
      args: ['--key', '${SOME_KEY}'],
      env: { K: '${SOME_KEY}' },
    })
    expect(checkOwnToolConfig({ type: 'sse', url: 'https://x.test/${TENANT_ID}/sse', headers: { 'X-Key': '${SOME_KEY}' } })).toEqual({
      type: 'sse',
      url: 'https://x.test/${TENANT_ID}/sse',
      headers: { 'X-Key': '${SOME_KEY}' },
    })
  })
})
