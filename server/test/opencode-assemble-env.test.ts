// assembleOpencode over agent-env.ts (E10 #39) and the inbox after the
// roster (E10 #21): an OpenCode process gets the same SILOS_API every agent
// process gets, keeps refusing a Vault entry that names its reserved keys,
// and its context file carries the unread messages a Claude console hears.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStateStore } from '../src/agent-state.js'
import { assembleOpencode } from '../src/harnesses/opencode/assemble.js'
import { MessageStore } from '../src/messages.js'
import { MessageReads } from '../src/message-reads.js'
import { LiveTurns } from '../src/live-turns.js'
import type { Agent } from '../src/types.js'
import type { VaultStore } from '../src/vault-store.js'

let base: string, dataDir: string, folder: string, agentState: AgentStateStore
const a = (): Agent => ({ id: 'oc', name: 'Oc', folder, skills: [], framework: 'opencode' }) as unknown as Agent
const vaultOf = (env: Record<string, string>): VaultStore => ({ envFor: () => env }) as unknown as VaultStore

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silos-oc-assemble-'))
  dataDir = join(base, 'data')
  folder = join(base, 'project')
  mkdirSync(folder, { recursive: true })
  agentState = new AgentStateStore(join(dataDir, 'agent-state'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const assemble = (vault?: VaultStore, inboxFor?: (id: string) => string) =>
  assembleOpencode(
    { agents: () => [a()], agentState, dataDir, home: base, silosApi: 'http://127.0.0.1:3299', ...(vault ? { vault } : {}), ...(inboxFor ? { inboxFor } : {}) },
    a(),
    folder,
  )

describe('assembleOpencode env', () => {
  it('SILOS_API from the one builder; Vault + state in agentEnv, without it', () => {
    const out = assemble(vaultOf({ VAULT_X: 'v' }))
    expect(out.silosApi).toBe('http://127.0.0.1:3299')
    expect(out.env.SILOS_API).toBe('http://127.0.0.1:3299')
    expect(out.agentEnv).toEqual({ VAULT_X: 'v', SILOS_AGENT_STATE: agentState.dirFor('oc'), SILOS_AGENT_ID: 'oc' })
    expect(out.env.SILOS_SESSION_ID).toBeUndefined()
  })

  it('a Vault entry naming a reserved key is still refused, never silently overridden', () => {
    expect(() => assemble(vaultOf({ SILOS_API: 'http://evil.example' }))).toThrow(/SILOS_API is set by Silos/)
  })
})

describe('assembleOpencode context file', () => {
  const contextFile = (): string => readFileSync(join(agentState.dirFor('oc'), 'opencode', 'context.md'), 'utf8')

  it('no unread message: the briefing alone', () => {
    assemble()
    expect(contextFile()).not.toContain('Your Silos inbox')
  })

  it('unread messages: the inbox text after the roster, separated by a blank line — an attended launch marks them read', () => {
    const messages = new MessageStore(dataDir)
    const reads = new MessageReads(messages, new LiveTurns())
    const m = messages.send({ from: 'builder', to: 'oc', text: 'please look' })
    let text = ''
    assemble(undefined, (id) => {
      text = reads.inboxFor(id, 'attended')
      return text
    })
    expect(text).toContain('please look')
    expect(contextFile().endsWith(`\n\n${text}`)).toBe(true)
    expect(messages.get('oc', m.id)?.state).toBe('read')
  })
})

describe("assembleOpencode — the agent's own MCP servers", () => {
  const cfgOf = (out: { configContent: string }): { mcp?: Record<string, unknown>; skills?: { paths: string[] } } => JSON.parse(out.configContent)
  const writeOwn = (servers: Record<string, unknown>): void => {
    const plugin = join(agentState.dirFor('oc'), 'plugin')
    mkdirSync(plugin, { recursive: true })
    writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
  }
  const own = (): void =>
    writeOwn({
      books: { command: 'npx', args: ['-y', 'books-mcp', '--tenant', '${TENANT_ID}'], env: { API_KEY: '${BOOKS_KEY}' } },
      remote: { type: 'http', url: 'https://mcp.example.test/v1', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' } },
    })

  it('land in `mcp` namespaced by the agent, refs as {env:NAME}; no skills root without skills', () => {
    own()
    const cfg = cfgOf(assemble())
    expect(cfg.mcp).toEqual({
      oc_books: {
        type: 'local',
        command: ['npx', '-y', 'books-mcp', '--tenant', '{env:TENANT_ID}'],
        environment: { API_KEY: '{env:BOOKS_KEY}' },
        enabled: true,
      },
      oc_remote: { type: 'remote', url: 'https://mcp.example.test/v1', headers: { Authorization: 'Bearer {env:REMOTE_TOKEN}' }, enabled: true },
    })
    expect(cfg.skills?.paths.some((p) => p.includes(join('oc', 'plugin')))).toBe(false)
  })

  it('a heartbeat without tools gets none; a round with its tools keeps them', () => {
    own()
    const run = (heartbeat: boolean | 'tools') =>
      cfgOf(
        assembleOpencode({ agents: () => [a()], agentState, dataDir, home: base, silosApi: 'http://127.0.0.1:3299' }, a(), folder, {
          provider: null,
          model: null,
          heartbeat,
        }),
      )
    expect(run(true).mcp).toBeUndefined()
    expect(Object.keys(run('tools').mcp ?? {})).toEqual(['oc_books', 'oc_remote'])
  })

  it('a hand-edited brace that is not a ref aborts the launch instead of reaching OpenCode', () => {
    writeOwn({ x: { command: 'srv', args: ['{file:/etc/passwd}'] } })
    expect(() => assemble()).toThrow()
  })
})
