// output-style.test.ts — the cockpit's sixth field: an output style (e.g.
// explanatory) settable per agent or per conversation, systematically.
// Every variant: unset (nothing sent — the operator's own
// config), agent only, a conversation pin over the agent, a turn over both,
// an unknown/invalid name refused at every write door, an engine without
// styles (OpenCode) never offered nor sent, the console's ONE --settings
// merged with theme + fence, the SDK's settings, and a live console told to
// restart (a style is read at SessionStart).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { validateOverrides, resolveCascade } from '../src/cockpit.js'
import { CLAUDE_BUILTIN_STYLES, listClaudeOutputStyles, outputStyleSettings } from '../src/harnesses/claude-code/output-styles.js'
import { defaultConsoleCommand } from '../src/harnesses/claude-code/console.js'
import { claudeServerHooks } from '../src/harnesses/claude-code/server-hooks.js'
import { claudeCode } from '../src/harnesses/claude-code/index.js'
import { opencode } from '../src/harnesses/opencode/index.js'
import { registerHarness } from '../src/harnesses/registry.js'
import { describeHarnesses } from '../src/harness-descriptor.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { AgentStateStore } from '../src/agent-state.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { ConversationPrefsStore } from '../src/conversation-prefs.js'
import { OpenCodeHeadless } from '../src/harnesses/opencode/headless.js'
import { buildServer } from '../src/server.js'
import type { LaunchSpec } from '../src/harnesses/contract.js'
import type { QueryArgs, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'
import type { Agent } from '../src/types.js'

const OFF = { 'explanatory-output-style@claude-plugins-official': false, 'learning-output-style@claude-plugins-official': false }
const dirs: string[] = []
const temp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('cockpit: the outputStyle field', () => {
  it('validates a name (spaces allowed), refuses a path, a non-string, an empty name', () => {
    expect(validateOverrides({ outputStyle: ' Explanatory ' })).toEqual({ outputStyle: 'Explanatory' })
    expect(validateOverrides({ outputStyle: 'Probe Style' })).toEqual({ outputStyle: 'Probe Style' })
    expect(validateOverrides({ outputStyle: null }, { allowNull: true })).toEqual({ outputStyle: null })
    for (const bad of ['../x', '', 'a/b', 3, true, 'x'.repeat(65)]) {
      expect(() => validateOverrides({ outputStyle: bad })).toThrow(/outputStyle/)
    }
    expect(() => validateOverrides({ outputStyle: null })).toThrow('overrides.outputStyle does not accept null')
  })

  it('the cascade: unset → nothing; agent only; a pin over the agent; a turn over both; agent "" = cleared', () => {
    expect(resolveCascade({}, null, null).outputStyle).toBeUndefined()
    expect('outputStyle' in resolveCascade({}, null, null)).toBe(false)
    expect(resolveCascade({ outputStyle: 'Explanatory' }, null, null).outputStyle).toBe('Explanatory')
    expect(resolveCascade({ outputStyle: 'Explanatory' }, { outputStyle: 'default' }, null).outputStyle).toBe('default')
    expect(resolveCascade({ outputStyle: 'Explanatory' }, { outputStyle: 'default' }, { outputStyle: 'Learning' }).outputStyle).toBe('Learning')
    expect(resolveCascade({ outputStyle: '' }, null, null).outputStyle).toBeUndefined()
  })
})

describe('the per-process settings (output-styles.ts)', () => {
  it('nothing when nobody set a style; the native style + the style plugins off when one is set', () => {
    expect(outputStyleSettings(undefined)).toEqual({})
    expect(outputStyleSettings('')).toEqual({})
    expect(JSON.stringify(outputStyleSettings('Explanatory'))).toBe(JSON.stringify({ outputStyle: 'Explanatory', enabledPlugins: OFF }))
    // 'default' is a real choice: the plain voice, with the global plugin kept out
    expect(outputStyleSettings('default')).toEqual({ outputStyle: 'default', enabledPlugins: OFF })
  })

  it('the console merges the style into its ONE --settings, after theme and fence; no style = byte-identical', () => {
    const fence = { permissions: { deny: ['Read(//x)'], additionalDirectories: [] } } as never
    const argv = defaultConsoleCommand({ sessionId: 's', theme: 'light', fence, outputStyle: 'Learning' })
    expect(argv.filter((a) => a === '--settings')).toHaveLength(1)
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!)
    expect(Object.keys(settings)).toEqual(['theme', 'permissions', 'outputStyle', 'enabledPlugins'])
    expect(settings).toEqual({ theme: 'light', permissions: { deny: ['Read(//x)'], additionalDirectories: [] }, outputStyle: 'Learning', enabledPlugins: OFF })
    expect(defaultConsoleCommand({ sessionId: 's', theme: 'light', fence })).toEqual(
      defaultConsoleCommand({ sessionId: 's', theme: 'light', fence, outputStyle: undefined }),
    )
    expect(defaultConsoleCommand({ sessionId: 's' })).toEqual(['claude', '--session-id', 's'])
  })

  it("the harness command() forwards a spec style; OpenCode's console never carries one", () => {
    const spec = { agent: { id: 'a' } as Agent, cwd: '/p', key: 'k', fence: null, provider: null, env: {}, outputStyle: 'Explanatory' } as LaunchSpec
    expect(claudeCode.console.command(spec).join(' ')).toContain('"outputStyle":"Explanatory"')
    const oc = opencode.console.command({ ...spec, key: 'ses_k', port: 4999 })
    expect(oc.join(' ')).not.toMatch(/Explanatory|outputStyle/)
  })
})

describe('what the engine offers (listClaudeOutputStyles)', () => {
  it("built-ins, then the operator's, then the project's; frontmatter name wins over the file name; junk skipped", () => {
    const home = temp('os-home-')
    const cwd = temp('os-cwd-')
    mkdirSync(join(home, '.claude', 'output-styles'), { recursive: true })
    mkdirSync(join(cwd, '.claude', 'output-styles'), { recursive: true })
    writeFileSync(join(home, '.claude', 'output-styles', 'mine.md'), '---\nname: Probe Style\ndescription: "a probe"\n---\nbody')
    writeFileSync(join(home, '.claude', 'output-styles', 'shared.md'), '---\nname: Shared\ndescription: user one\n---\n')
    writeFileSync(join(cwd, '.claude', 'output-styles', 'nameless.md'), '---\ndescription: no name\n---\n')
    writeFileSync(join(cwd, '.claude', 'output-styles', 'shared.md'), '---\nname: Shared\ndescription: project one\n---\n')
    writeFileSync(join(cwd, '.claude', 'output-styles', 'bad.md'), '---\nname: ../evil\n---\n')
    writeFileSync(join(cwd, '.claude', 'output-styles', 'Explanatory.md'), '---\nname: Explanatory\n---\nshadow')
    writeFileSync(join(cwd, '.claude', 'output-styles', 'notes.txt'), 'not a style')
    const styles = listClaudeOutputStyles(cwd, home)
    expect(styles.map((s) => [s.id, s.source])).toEqual([
      ['default', 'built-in'],
      ['Explanatory', 'built-in'],
      ['Learning', 'built-in'],
      ['Concise', 'built-in'],
      ['Proactive', 'built-in'],
      ['Probe Style', 'user'],
      ['Shared', 'project'],
      ['nameless', 'project'],
    ])
    expect(styles.find((s) => s.id === 'Probe Style')?.description).toBe('a probe')
    // no folder, no dirs: the built-ins alone
    expect(listClaudeOutputStyles(null, temp('os-empty-')).map((s) => s.id)).toEqual(CLAUDE_BUILTIN_STYLES.map((s) => s.id))
  })
})

describe('harness descriptors and registration', () => {
  it('Claude Code offers styles, OpenCode does not — to the web too', () => {
    const d = describeHarnesses()
    expect(d.find((h) => h.id === claudeCode.id)?.caps.outputStyles).toBe(true)
    expect(d.find((h) => h.id === opencode.id)?.caps.outputStyles).toBe(false)
    expect(opencode.outputStyles).toBeUndefined()
  })

  it('a cap without a lister (or a lister without the cap) is refused at registration', () => {
    const base = { ...opencode, id: 'style-liar', ownsId: () => false } as never as typeof opencode
    expect(() => registerHarness({ ...base, caps: { ...base.caps, outputStyles: true } })).toThrow(/outputStyles/)
    expect(() => registerHarness({ ...base, outputStyles: () => [] })).toThrow(/outputStyles/)
  })
})

describe('a live console takes a style on relaunch (pushPin)', () => {
  const hooks = (sent: string[]) =>
    claudeServerHooks({
      deps: {} as never,
      options: undefined,
      helpers: {
        terminals: {
          consoleSendLiteral: (_k: string, t: string) => {
            sent.push(t)
          },
        },
      } as never,
    })
  it('style → restart (nothing typed); style + model → restart; model alone stays live; no console → nothing', async () => {
    const sent: string[] = []
    const h = hooks(sent)
    expect(await h.pushPin!('s', 'k', { outputStyle: 'Explanatory' }, { outputStyle: 'Explanatory' })).toBe('restart')
    expect(await h.pushPin!('s', 'k', { outputStyle: 'default', model: 'opus' }, { outputStyle: 'default', model: 'opus' })).toBe('restart')
    expect(sent).toEqual([])
    expect(await h.pushPin!('s', 'k', { model: 'opus' }, { model: 'opus' })).toBe('live')
    expect(await h.pushPin!('s', null, { outputStyle: 'Explanatory' }, { outputStyle: 'Explanatory' })).toBeNull()
  })
})

describe('a live console takes another account or key on relaunch (pushPin)', () => {
  it('provider → restart, alone or with a model, nothing typed (a login rides the process env); no console → nothing', async () => {
    const sent: string[] = []
    const h = claudeServerHooks({
      deps: {} as never,
      options: undefined,
      helpers: {
        terminals: {
          consoleSendLiteral: (_k: string, t: string) => {
            sent.push(t)
          },
        },
      } as never,
    })
    expect(await h.pushPin!('s', 'k', { provider: 'account:kai' }, { provider: 'account:kai' })).toBe('restart')
    expect(await h.pushPin!('s', 'k', { provider: null, model: 'opus' }, { model: 'opus' })).toBe('restart')
    expect(sent).toEqual([])
    expect(await h.pushPin!('s', null, { provider: 'account:kai' }, { provider: 'account:kai' })).toBeNull()
  })
})

describe('the routes and both Claude engines', () => {
  let app: FastifyInstance, calls: QueryArgs[], folder: string, root: string, registry: AgentRegistry, convPrefs: ConversationPrefsStore, chat: ChatService
  let index: ReturnType<typeof claudeSessionIndex>, native: NativeStore
  const TOKEN = 't0k'
  beforeEach(async () => {
    const base = temp('os-srv-')
    root = join(base, 'projects')
    folder = temp('os-srv-folder-')
    mkdirSync(join(folder, '.claude', 'output-styles'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'output-styles', 'team.md'), '---\nname: Team Voice\ndescription: ours\n---\nbody')
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    mkdirSync(root, { recursive: true })
    index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder })
    registry.create({ id: 'oc', name: 'Oc', folder, framework: opencode.id })
    native = new NativeStore(join(base, 'data', 'native.json'))
    calls = []
    convPrefs = new ConversationPrefsStore(join(base, 'data'))
    convPrefs.load()
    const queryFn = (args: QueryArgs): SdkQueryHandle => {
      calls.push(args)
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
        },
        async interrupt() {
          return { status: 'interrupted' }
        },
      } as SdkQueryHandle
    }
    chat = new ChatService({ registry, native, queryFn, convPrefs })
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, join(base, 'data')),
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(join(base, 'data')),
      memory: new MemoryService(root, join(base, 'data'), registry),
      token: TOKEN,
      liveMs: 120_000,
      convPrefs,
    })
  })
  afterEach(async () => {
    await app.close()
  })
  const req = (method: 'GET' | 'PATCH' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'x-token': TOKEN }, ...(payload !== undefined ? { payload: payload as never } : {}) })
  const settingsOf = (i: number) => (calls[i]!.options as Record<string, unknown>).settings
  const until = async (n: number) => {
    const t0 = Date.now()
    while (calls.length < n) {
      if (Date.now() - t0 > 3000) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it("GET /api/agents/:id/output-styles: built-ins + the folder's own; 400 on an engine with none", async () => {
    const r = await req('GET', '/api/agents/writer/output-styles')
    expect(r.statusCode).toBe(200)
    expect(r.json().styles.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(['default', 'Explanatory', 'Team Voice']))
    const oc = await req('GET', '/api/agents/oc/output-styles')
    expect(oc.statusCode).toBe(400)
    expect(oc.json().error).toMatch(/has no output styles/)
    expect((await req('GET', '/api/agents/nope/output-styles')).statusCode).toBe(404)
  })

  it('the agent default: an offered name saves, an unknown one is refused, "" clears; OpenCode refuses any', async () => {
    expect((await req('PATCH', '/api/agents/writer', { outputStyle: 'Team Voice' })).json().agent.outputStyle).toBe('Team Voice')
    const bad = await req('PATCH', '/api/agents/writer', { outputStyle: 'explanatory' }) // case-sensitive: Claude would fall back in silence
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/unknown output style for Claude Code: explanatory/)
    expect(registry.get('writer')?.outputStyle).toBe('Team Voice')
    expect((await req('PATCH', '/api/agents/writer', { outputStyle: '' })).json().agent.outputStyle).toBeUndefined()
    expect((await req('PATCH', '/api/agents/oc', { outputStyle: 'Explanatory' })).statusCode).toBe(400)
    expect((await req('POST', '/api/agents', { id: 'n1', name: 'N', folder, outputStyle: 'Nope' })).statusCode).toBe(400)
    expect((await req('POST', '/api/agents', { id: 'n2', name: 'N', folder, outputStyle: 'Learning' })).json().agent.outputStyle).toBe('Learning')
  })

  it('a conversation pin: offered → saved, unknown → 400, an OpenCode conversation → 400, null clears', async () => {
    const mf = mungePath(folder)
    const ok = await req('PATCH', `/api/sessions/${mf}/s-1/prefs`, { outputStyle: 'Team Voice' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().prefs).toEqual({ outputStyle: 'Team Voice' })
    expect((await req('PATCH', `/api/sessions/${mf}/s-1/prefs`, { outputStyle: 'Pirate' })).statusCode).toBe(400)
    const oc = await req('PATCH', `/api/sessions/${mf}/ses_abc/prefs`, { outputStyle: 'Explanatory' })
    expect(oc.statusCode).toBe(400)
    expect(oc.json().error).toMatch(/has no output styles/)
    expect((await req('PATCH', `/api/sessions/${mf}/s-1/prefs`, { outputStyle: null })).json().prefs).toEqual({})
  })

  it('the SDK turn: unset → no settings; agent only; a pin overrides the agent; a turn overrides both; unknown turn style → 400', async () => {
    await req('POST', '/api/agents/writer/chat', { text: 'a' })
    await until(1)
    expect(settingsOf(0)).toBeUndefined()
    registry.update('writer', { outputStyle: 'Explanatory' })
    await req('POST', '/api/agents/writer/chat', { text: 'b' })
    await until(2)
    expect(settingsOf(1)).toEqual({ outputStyle: 'Explanatory', enabledPlugins: OFF })
    const mf = mungePath(folder)
    mkdirSync(join(root, mf), { recursive: true })
    writeFileSync(join(root, mf, 'sess-p.jsonl'), `{"type":"user","cwd":"${folder}","message":{"role":"user","content":"hi"}}\n`)
    await index.refresh(mf, 'sess-p')
    native.register(mf, 'sess-p', { agentId: 'writer', createdAt: 'x' })
    convPrefs.patch(mf, 'sess-p', { outputStyle: 'default' })
    await req('POST', '/api/agents/writer/chat', { text: 'c', session: { folder: mungePath(folder), id: 'sess-p' } })
    await until(3)
    expect(settingsOf(2)).toEqual({ outputStyle: 'default', enabledPlugins: OFF })
    await req('POST', '/api/agents/writer/chat', { text: 'd', overrides: { outputStyle: 'Learning' } })
    await until(4)
    expect(settingsOf(3)).toEqual({ outputStyle: 'Learning', enabledPlugins: OFF })
    const bad = await req('POST', '/api/agents/writer/chat', { text: 'e', overrides: { outputStyle: 'Pirate' } })
    expect(bad.statusCode).toBe(400)
    expect(calls.length).toBe(4)
  })

  it('the console cascade: the pin over the agent, else the agent, else nothing', () => {
    expect(chat.consoleOutputStyle('writer', folder, 'x')).toBeUndefined()
    registry.update('writer', { outputStyle: 'Explanatory' })
    expect(chat.consoleOutputStyle('writer', folder)).toBe('Explanatory')
    convPrefs.patch(mungePath(folder), 'sess-q', { outputStyle: 'Team Voice' })
    expect(chat.consoleOutputStyle('writer', folder, 'sess-q')).toBe('Team Voice')
  })
})

describe('OpenCode never receives a style', () => {
  it("even with an agent style and a pin written behind the routes' back, `opencode run` gets no trace of it", async () => {
    const base = temp('os-oc-')
    const cwd = join(base, 'proj')
    mkdirSync(cwd)
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'oc', name: 'Oc', folder: cwd, framework: opencode.id })
    registry.update('oc', { outputStyle: 'Explanatory' })
    const convPrefs = new ConversationPrefsStore(base)
    convPrefs.patch(mungePath(cwd), 'ses_p', { outputStyle: 'Learning' })
    const rec = join(base, 'rec')
    mkdirSync(rec)
    const bin = join(base, 'opencode-stub.sh')
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > '${rec}/argv'`,
        `cat > '${rec}/stdin'`,
        `env > '${rec}/env'`,
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_p","part":{}}'`,
      ].join('\n'),
    )
    chmodSync(bin, 0o755)
    const h = new OpenCodeHeadless({
      binary: bin,
      registry,
      agentState: new AgentStateStore(join(base, 'agent-state')),
      native: new NativeStore(join(base, 'native.json')),
      dataDir: base,
      home: base,
      silosApi: 'http://127.0.0.1:3210',
      convPrefs,
      agentOfDb: () => 'oc',
    })
    for await (const _ of h.send({ turnId: 't', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_p', mode: 'append' } })) void _
    const seen = ['argv', 'stdin', 'env'].map((f) => readFileSync(join(rec, f), 'utf8')).join('\n')
    expect(seen).not.toMatch(/Explanatory|Learning|outputStyle/)
  })
})
