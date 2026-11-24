// inboxText (harnesses/inbox-text.ts) is the derived twin of
// plugin/hooks/inbox.py — the single source of the inbox rule. Byte for
// byte: the LIVE script fetches each fixture from a fake Silos API (its
// GET /api/agents/<self>/messages?state=new, bearer and $SILOS_TURN) and
// inboxText renders the same messages, so an edit to the script fails here
// until the twin follows. Since B2.4 the script asks a second thing, GET /api/agents/<self>/asks, and lists the
// asks other agents left it after the messages — the twin too (asksText).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { inboxText, INBOX_UNFETCHED } from '../src/harnesses/inbox-text.js'
import type { AgentMessage } from '../src/types.js'
import type { AskLine } from '../src/task-asks.js'

const SCRIPT = fileURLToPath(new URL('../../plugin/hooks/inbox.py', import.meta.url))

let server: Server
let api: string
let served: AgentMessage[]
let servedAsks: AskLine[] | null
let seen: IncomingMessage[]
let home: string

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'silos-inbox-text-'))
  served = []
  servedAsks = []
  seen = []
  server = createServer((req, res) => {
    seen.push(req)
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/asks')) {
      // null: an older server without the route — the asks list nothing
      if (servedAsks === null) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'no route' }))
        return
      }
      res.end(JSON.stringify({ asks: servedAsks }))
      return
    }
    res.end(JSON.stringify({ messages: served }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
})

function python(agentId: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [SCRIPT],
      {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, PYTHONIOENCODING: 'utf-8', SILOS_AGENT_ID: agentId, SILOS_API: api, ...env },
        encoding: 'utf8',
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })
}

/** The script's stdout is the text plus print()'s newline; nothing → ''. */
async function expectSame(messages: AgentMessage[], asks: AskLine[] = []): Promise<string> {
  served = messages
  servedAsks = asks
  const out = await python('a1')
  const text = inboxText(messages, asks)
  expect(text === '' ? '' : `${text}\n`).toBe(out)
  return text
}

const msg = (id: string, o: Partial<AgentMessage> = {}): AgentMessage => ({
  id,
  from: 'builder',
  to: 'a1',
  at: '2026-11-01T09:00:00.000Z',
  text: 'x',
  state: 'new',
  ...o,
})
const ask = (key: string, o: Partial<AskLine> = {}): AskLine => ({
  key,
  ref: 'p#t1',
  title: 'Write the draft',
  from: 'writer',
  fromName: 'Writer',
  action: 'review the draft',
  asked: '',
  at: '2026-11-01T09:00:00.000Z',
  silos: false,
  ...o,
})

describe('inboxText = inbox.py, byte for byte', () => {
  it('nothing unread: nothing', async () => {
    expect(await expectSame([])).toBe('')
    expect(await expectSame([msg('r-000001', { state: 'read' })])).toBe('')
  })

  it('oldest first, whitespace and truncation as Python does, more than five, provenance said', async () => {
    const text = await expectSame([
      msg('m-000001', { at: '2026-11-01T09:00:00.000Z', text: 'plain one' }),
      msg('m-000002', { at: '2026-11-02T09:00:00.000Z', from: 'owner', text: '  spaced\n\tout text　here  ' }),
      msg('m-000003', { at: '2026-10-30T08:00:00.000Z', text: 'ñ'.repeat(10) + 'x'.repeat(200) }),
      msg('m-000004', { at: '2026-11-03T10:00:00.000Z', from: 'writer', text: 'after reading', readOutside: ['WebFetch', 'mcp__mail'] }),
      msg('m-000005', { at: '2026-11-04T10:00:00.000Z', text: 'five' }),
      msg('m-000006', { at: '2026-11-05T10:00:00.000Z', text: 'six' }),
      msg('m-000007', { at: '2026-11-06T10:00:00.000Z', text: 'answered', state: 'answered' }),
    ])
    expect(text).toMatch(/^Your Silos inbox: 6 unread messages\. /)
    expect(text).not.toMatch(/urgent\)|URGENT/)
    expect(text.split('\n')[1]).toContain('(m-000003)')
    expect(text).toContain('after reading — sent after reading the web (WebFetch, mcp__mail)')
    expect(text).toContain('- … and 1 more')
  })

  it('one: the singular wording', async () => {
    expect(await expectSame([msg('a-000001', { text: 'one' })])).toMatch(/^Your Silos inbox: 1 unread message\. /)
  })

  // the asks other agents left it, after the messages
  it("the asks: oldest first, the question else the action, the escalation's own, the mark, more than five, with or without messages", async () => {
    const asks = [
      ask('folder:/w/p/tasks/t2', { ref: 'p#t2', at: '2026-11-02T09:00:00.000Z', asked: '  which  price\n tier?  ' }),
      ask('folder:/w/p/tasks/t1', { at: '2026-11-01T09:00:00.000Z' }),
      ask('folder:/w/p/tasks/t3', { ref: 'p#t3', at: '2026-11-03T09:00:00.000Z', title: 'Ship it', action: 'unstick p#t3', silos: true, fromName: 'Builder' }),
      ask('folder:/w/p/tasks/t4', { ref: 'p#t4', at: '2026-11-04T09:00:00.000Z', asked: 'ñ'.repeat(200), readOutside: ['WebFetch'] }),
      ask('folder:/w/p/tasks/t5', { ref: 'p#t5', at: '2026-11-05T09:00:00.000Z' }),
      ask('folder:/w/p/tasks/t6', { ref: 'p#t6', at: '2026-11-06T09:00:00.000Z' }),
    ]
    const both = await expectSame([msg('m-000001')], asks)
    const lines = both.split('\n')
    expect(lines[0]).toMatch(/^Your Silos inbox: 1 unread message\. /)
    expect(lines[2]).toMatch(/^Asks waiting on you through Silos: 6\. Answer each with POST \/api\/tasks\/ask\/answer /)
    expect(lines[3]).toBe('- ask:folder:/w/p/tasks/t1 — Writer waits on you for p#t1: «review the draft»')
    expect(lines[4]).toBe('- ask:folder:/w/p/tasks/t2 — Writer waits on you for p#t2: «which price tier?»')
    expect(lines[5]).toBe('- ask:folder:/w/p/tasks/t3 — p#t3 «Ship it» is stuck and Silos asks you to help unstick it (Builder stays its owner)')
    expect(lines[6]).toContain('— asked after reading the web (WebFetch)')
    expect(lines.at(-1)).toBe('- … and 1 more')
    const alone = await expectSame([], asks.slice(0, 1))
    expect(alone).toMatch(/^Asks waiting on you through Silos: 1\. /)
    expect(await expectSame([], [])).toBe('')
  })
})

describe("inbox.py fetches the server's store", () => {
  // (B2.4) changed on purpose: a second GET, the asks, with the same credentials
  it('asks GET /api/agents/<self>/messages?state=new, then GET /api/agents/<self>/asks, with the bearer and the turn token', async () => {
    served = [msg('a-000001')]
    await python('a1', { SILOS_AGENT_TOKEN: 'b'.repeat(64), SILOS_TURN: 'c'.repeat(32) })
    expect(seen).toHaveLength(2)
    expect(seen.map((r) => r.url)).toEqual(['/api/agents/a1/messages?state=new', '/api/agents/a1/asks'])
    for (const r of seen) {
      expect(r.headers.authorization).toBe(`Bearer ${'b'.repeat(64)}`)
      expect(r.headers['x-silos-turn']).toBe('c'.repeat(32))
    }
  })

  it('an asks fetch that fails lists no asks — the messages still print', async () => {
    servedAsks = null
    served = [msg('a-000001', { text: 'one' })]
    expect(await python('a1')).toBe(`${inboxText([msg('a-000001', { text: 'one' })])}\n`)
  })

  it('a failed fetch says so in one line (nothing is marked); master and a bad id ask nothing', async () => {
    expect(await python('a1', { SILOS_API: 'http://127.0.0.1:1' })).toBe(`${INBOX_UNFETCHED}\n`)
    expect(await python('master')).toBe('')
    expect(await python('..')).toBe('')
    expect(await python('a/b')).toBe('')
    expect(seen).toHaveLength(0)
  })
})

// a turn without hooks — and every OpenCode launch —
// gets the asks from the server's own composition (MessageReads.inboxFor)
describe('MessageReads.inboxFor lists the asks after the messages', () => {
  it('asks alone still make the text; the messages served are only the messages', async () => {
    const { MessageReads } = await import('../src/message-reads.js')
    const { LiveTurns } = await import('../src/live-turns.js')
    const marked: string[][] = []
    const store = {
      list: () => [] as AgentMessage[],
      markRead: (_a: string, ids: Iterable<string>) => {
        marked.push([...ids])
        return [...ids]
      },
    }
    const reads = new MessageReads(store, new LiveTurns(), () => [ask('folder:/w/p/tasks/t1')])
    expect(reads.inboxFor('a1', 'attended')).toBe(inboxText([], [ask('folder:/w/p/tasks/t1')]))
    expect(marked).toEqual([])
  })
})
