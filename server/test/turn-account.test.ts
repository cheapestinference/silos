// turn-account.test.ts — the account an unattended turn runs on, through
// the REAL ChatService resolution and the registered harnesses: a Claude account is «readable» only when the turn's
// engine really runs on it; an engine on its own login has no price and no
// reading — the heartbeat's brake is then ROUNDS_UNMEASURED_PER_DAY.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ProvidersStore } from '../src/providers-store.js'
import { turnAccountOf } from '../src/turn-account.js'

let base: string, registry: AgentRegistry, providers: ProvidersStore, chat: ChatService

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silos-acct-'))
  const dataDir = join(base, 'data')
  mkdirSync(dataDir, { recursive: true })
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  providers = new ProvidersStore(dataDir)
  providers.load()
  chat = new ChatService({
    registry,
    native: new NativeStore(join(dataDir, 'native.json')),
    providers,
    dataDir,
    queryFn: () => {
      throw new Error('no turn here')
    },
  })
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('turnAccountOf — what the heartbeat brakes by', () => {
  it('an agent with no provider on the engine that runs Claude accounts: the default account, its plan reading', () => {
    registry.create({ id: 'books', name: 'Books', folder: base })
    expect(turnAccountOf({ registry, chat }, 'books', undefined)).toEqual({ id: 'default', priced: false, readable: true })
  })

  it('an agent with no provider on an engine that cannot run a Claude account: its own login — no price, no reading', () => {
    registry.create({ id: 'ops', name: 'Ops', folder: base, framework: 'opencode' })
    expect(turnAccountOf({ registry, chat }, 'ops', undefined)).toEqual({ id: 'default', priced: false, readable: false })
  })

  it('an engine-owned login and an API key: unreadable; the key prices', () => {
    const native = providers.create({ kind: 'harness-native', label: 'Z', harness: 'opencode', providerId: 'zai' })
    const key = providers.create({ label: 'gw', baseUrl: 'https://api.gw.test/anthropic', apiKey: 'sk-gw-abcdef123456' })
    registry.create({ id: 'ops', name: 'Ops', folder: base, framework: 'opencode', provider: native.id })
    registry.create({ id: 'books', name: 'Books', folder: base, provider: key.id })
    expect(turnAccountOf({ registry, chat }, 'ops', undefined)).toEqual({ id: native.id, priced: false, readable: false })
    expect(turnAccountOf({ registry, chat }, 'books', undefined)).toEqual({ id: key.id, priced: true, readable: false })
    // the automation's runsOn wins over the agent's own
    expect(turnAccountOf({ registry, chat }, 'books', 'default')).toEqual({ id: 'default', priced: false, readable: true })
  })
})
