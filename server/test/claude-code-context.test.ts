import { describe, it, expect } from 'vitest'
import { ContextAccumulator } from '../src/harnesses/claude-code/context.js'

// formats verified against real sessions from ~/.claude/projects — not
// invented.

const line = (obj: unknown): string => JSON.stringify(obj)

const taskCreate = (id: string, subject: string, ts: string, opts?: { description?: string; activeForm?: string }) => [
  line({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu_create_${id}`, name: 'TaskCreate', input: { subject, ...opts } }] },
  }),
  line({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_create_${id}`, content: `Task #${id} created successfully: ${subject}` }] },
  }),
]

const taskUpdate = (toolId: string, taskId: string, ts: string, status: string, extra?: Record<string, unknown>) => [
  line({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'TaskUpdate', input: { taskId, status, ...extra } }] },
  }),
  line({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] },
  }),
]

// cost: computed by Silos from each assistant record's message.usage ×
// API list prices (Claude Code ≥2.1.302 stopped writing its cumulative
// cost-state during live sessions). Real usage shape from
// ~/.claude/projects: usage repeats IDENTICALLY on every line of the same
// message.id (one line per content block) — counted once per message.
// USD is notional (API list prices) — labeling is the client's job.
const usageLine = (model: string, id: string, usage: Record<string, unknown>, ts = '2026-10-20T10:00:00.000Z') =>
  line({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', id, model, content: [{ type: 'text', text: 'ok' }], usage },
  })

describe('ContextAccumulator — cost (computed from assistant usage)', () => {
  it('prices a message at API list prices (haiku-5-5: figures from a real cost-state)', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([usageLine('claude-haiku-5-5', 'msg_1', { input_tokens: 1217, output_tokens: 327 })])
    const cost = acc.state.cost!
    expect(cost.totalUsd).toBeCloseTo(0.0002852, 10) // (1217×$0.10 + 327×$0.50)/MTok — matches the CLI's own cost-state for the same usage
    expect(cost.unknownModels).toBe(false)
    expect(cost.byModel).toEqual([
      { model: 'claude-haiku-5-5', usd: cost.totalUsd, inputTokens: 1217, outputTokens: 327, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ])
  })

  it('counts a message ONCE however many lines repeat its id (one line per content block)', () => {
    const acc = new ContextAccumulator()
    const u = { input_tokens: 100, output_tokens: 200 }
    acc.feedLines([usageLine('claude-haiku-5-5', 'msg_1', u), usageLine('claude-haiku-5-5', 'msg_1', u), usageLine('claude-haiku-5-5', 'msg_1', u)])
    expect(acc.state.cost!.byModel[0]!.inputTokens).toBe(100)
    expect(acc.state.cost!.byModel[0]!.outputTokens).toBe(200)
  })

  it('accumulates per model and totals across models', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      usageLine('claude-fable-5', 'msg_1', { input_tokens: 1_000_000, output_tokens: 0 }), // $10
      usageLine('claude-fable-5', 'msg_2', { input_tokens: 0, output_tokens: 1_000_000 }), // $50
      usageLine('claude-haiku-5-5', 'msg_3', { input_tokens: 1_000_000, output_tokens: 0 }), // $0.50 — prompt over 100K bills haiku's long card
    ])
    const cost = acc.state.cost!
    expect(cost.totalUsd).toBeCloseTo(60.5, 6)
    expect(cost.byModel).toEqual([
      { model: 'claude-fable-5', usd: 60, inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { model: 'claude-haiku-5-5', usd: 0.5, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ])
  })

  it('prices cache writes by TTL (1h = 2× input, 5m = 1.25×) and reads at the read rate', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      usageLine('claude-fable-5', 'msg_1', {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000, // $1.00 on fable-5
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 1_000_000 }, // $20 + $12.50
      }),
    ])
    const cost = acc.state.cost!
    expect(cost.totalUsd).toBeCloseTo(33.5, 6)
    expect(cost.byModel[0]!.cacheReadTokens).toBe(1_000_000)
    expect(cost.byModel[0]!.cacheCreationTokens).toBe(2_000_000)
  })

  it('cache writes without a TTL split are priced at 5m (the lower bound)', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([usageLine('claude-fable-5', 'msg_1', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })])
    expect(acc.state.cost!.totalUsd).toBeCloseTo(12.5, 6)
  })

  it('an unpriced model still counts tokens, contributes $0, and raises unknownModels', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      usageLine('claude-haiku-5-5', 'msg_1', { input_tokens: 1_000_000, output_tokens: 0 }),
      usageLine('claude-future-9', 'msg_2', { input_tokens: 500, output_tokens: 500 }),
    ])
    const cost = acc.state.cost!
    expect(cost.unknownModels).toBe(true)
    expect(cost.totalUsd).toBeCloseTo(0.5, 6) // haiku's 1M prompt bills the long card
    expect(cost.byModel.find((m) => m.model === 'claude-future-9')).toEqual({
      model: 'claude-future-9',
      usd: 0,
      inputTokens: 500,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  })

  it('a dated model id prices as its base model (claude-haiku-4-5-20251001)', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([usageLine('claude-haiku-4-5-20251001', 'msg_1', { input_tokens: 1_000_000, output_tokens: 0 })])
    expect(acc.state.cost!.totalUsd).toBeCloseTo(1, 6) // haiku-4-5: $1/MTok in
    expect(acc.state.cost!.unknownModels).toBe(false)
  })

  it('a cost-state record no longer drives cost — the computed sum stands', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      usageLine('claude-haiku-5-5', 'msg_1', { input_tokens: 1_000_000, output_tokens: 0 }),
      line({
        type: 'cost-state',
        sessionId: 's',
        totalCostUSD: 99.9,
        modelUsage: { 'claude-haiku-5-5': { inputTokens: 1, outputTokens: 1, costUSD: 99.9 } },
        hasUnknownModelCost: false,
      }),
    ])
    expect(acc.state.cost!.totalUsd).toBeCloseTo(0.5, 6) // haiku's 1M prompt bills the long card
  })

  it('no usage -> cost is null (never an invented $0); zero/synthetic usage is skipped', () => {
    const acc = new ContextAccumulator()
    expect(acc.state.cost).toBeNull()
    acc.feedLines([
      usageLine('claude-haiku-5-5', 'msg_0', { input_tokens: 0, output_tokens: 0 }),
      usageLine('<synthetic>', 'msg_s', { input_tokens: 100, output_tokens: 100 }),
      line({ type: 'assistant', message: { role: 'assistant', id: 'msg_n', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'no usage field' }] } }),
    ])
    expect(acc.state.cost).toBeNull()
  })

  it('cost survives a state round-trip (cache restore) and keeps accumulating', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([usageLine('claude-haiku-5-5', 'msg_1', { input_tokens: 1_000_000, output_tokens: 0 })])
    const restored = new ContextAccumulator(acc.state)
    expect(restored.state.cost).toEqual(acc.state.cost)
    restored.feedLines([usageLine('claude-haiku-5-5', 'msg_2', { input_tokens: 1_000_000, output_tokens: 0 })])
    expect(restored.state.cost!.totalUsd).toBeCloseTo(1.0, 6) // two 1M prompts, each on haiku's long card
    // an old cache (pre-cost) restores without the field -> null, no crash
    const { cost: _cost, ...old } = acc.state
    const fromOld = new ContextAccumulator(old as never)
    expect(fromOld.state.cost).toBeNull()
  })
})

describe('ContextAccumulator — plan (TaskCreate/TaskUpdate)', () => {
  it('create -> in_progress -> completed computes durationMs and done/total', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...taskCreate('1', 'Task 1', '2026-08-19T10:00:00.000Z'),
      ...taskUpdate('tu_u1', '1', '2026-08-19T10:00:05.000Z', 'in_progress'),
      ...taskUpdate('tu_u2', '1', '2026-08-19T10:01:05.000Z', 'completed'),
    ])
    const { plan } = acc.state
    expect(plan).not.toBeNull()
    expect(plan!.total).toBe(1)
    expect(plan!.done).toBe(1)
    const t = plan!.tasks[0]!
    expect(t).toMatchObject({
      id: '1',
      subject: 'Task 1',
      status: 'completed',
      createdAt: '2026-08-19T10:00:00.000Z',
      startedAt: '2026-08-19T10:00:05.000Z',
      completedAt: '2026-08-19T10:01:05.000Z',
    })
    expect(t.durationMs).toBe(60_000)
  })

  it('completed without ever going through in_progress uses createdAt as the start', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...taskCreate('1', 'Straight to complete', '2026-08-19T10:00:00.000Z'),
      ...taskUpdate('tu_u1', '1', '2026-08-19T10:00:30.000Z', 'completed'),
    ])
    const t = acc.state.plan!.tasks[0]!
    expect(t.durationMs).toBe(30_000)
  })

  it('status deleted removes the task from the plan', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...taskCreate('1', 'Task A', '2026-08-19T10:00:00.000Z'),
      ...taskCreate('2', 'Task B', '2026-08-19T10:00:01.000Z'),
      ...taskUpdate('tu_u1', '1', '2026-08-19T10:00:05.000Z', 'deleted'),
    ])
    const { plan } = acc.state
    expect(plan!.total).toBe(1)
    expect(plan!.tasks.map((t) => t.id)).toEqual(['2'])
  })

  it('with no TaskCreate at all, plan is null', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([line({ type: 'user', message: { role: 'user', content: 'hi' } })])
    expect(acc.state.plan).toBeNull()
  })

  it('preserves creation order and merges subject/description/activeForm on update', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...taskCreate('1', 'First', '2026-08-19T10:00:00.000Z', { description: 'd1', activeForm: 'Doing first' }),
      ...taskCreate('2', 'Second', '2026-08-19T10:00:01.000Z'),
      ...taskUpdate('tu_u1', '2', '2026-08-19T10:00:02.000Z', 'in_progress', { subject: 'Second (renamed)' }),
    ])
    const { tasks } = acc.state.plan!
    expect(tasks.map((t) => t.id)).toEqual(['1', '2'])
    expect(tasks[0]).toMatchObject({ description: 'd1', activeForm: 'Doing first' })
    expect(tasks[1]).toMatchObject({ subject: 'Second (renamed)', status: 'in_progress' })
  })
})

describe('ContextAccumulator — subagents (Agent tool)', () => {
  const agentLaunch = (toolId: string, ts: string, opts: { agentId: string; background?: boolean; async?: boolean }) => [
    line({
      type: 'assistant',
      timestamp: ts,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolId,
            name: 'Agent',
            input: { description: 'Explore X', subagent_type: 'general-purpose', model: 'claude-sonnet-5', run_in_background: opts.background ?? false },
          },
        ],
      },
    }),
    opts.async === false
      ? line({
          type: 'user',
          timestamp: ts,
          toolUseResult: { agentId: opts.agentId },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `agentId: ${opts.agentId} sync result` }] },
        })
      : line({
          type: 'user',
          timestamp: ts,
          toolUseResult: { isAsync: true, agentId: opts.agentId },
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolId,
                content: `Async agent launched successfully. (internal)\nagentId: ${opts.agentId} (internal ID - do not mention to user...`,
              },
            ],
          },
        }),
  ]

  it('attaches the subagent to the in_progress task at the moment it launches', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...taskCreate('1', 'Task with subagent', '2026-08-19T10:00:00.000Z'),
      ...taskUpdate('tu_u1', '1', '2026-08-19T10:00:01.000Z', 'in_progress'),
      ...agentLaunch('tu_agent1', '2026-08-19T10:00:02.000Z', { agentId: 'a1b2c3d4e5f6a7b8', background: true }),
    ])
    const { plan, agents } = acc.state
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      id: 'a1b2c3d4e5f6a7b8',
      description: 'Explore X',
      type: 'general-purpose',
      model: 'claude-sonnet-5',
      background: true,
      startedAt: '2026-08-19T10:00:02.000Z',
      taskId: '1',
    })
    expect(agents[0]!.endedAt).toBeUndefined() // background: doesn't close until the task-notification
    expect(plan!.tasks[0]!.agents).toEqual(['a1b2c3d4e5f6a7b8'])
  })

  it('with two in_progress tasks, completing the last one leaves the other as current', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...taskCreate('1', 'A', '2026-08-19T10:00:00.000Z'),
      ...taskCreate('2', 'B', '2026-08-19T10:00:00.500Z'),
      ...taskUpdate('tu_u1', '1', '2026-08-19T10:00:01.000Z', 'in_progress'),
      ...taskUpdate('tu_u2', '2', '2026-08-19T10:00:02.000Z', 'in_progress'),
      ...taskUpdate('tu_u3', '2', '2026-08-19T10:00:03.000Z', 'completed'),
      ...agentLaunch('tu_agent9', '2026-08-19T10:00:04.000Z', { agentId: 'f1e2d3c4b5a69788', background: true }),
    ])
    expect(acc.state.agents[0]!.taskId).toBe('1')
    expect(acc.state.plan!.tasks.find((t) => t.id === '1')!.agents).toEqual(['f1e2d3c4b5a69788'])
  })

  it('a synchronous agent (not background) closes endedAt when the tool_result arrives', () => {
    const acc = new ContextAccumulator()
    acc.feedLines(agentLaunch('tu_agent1', '2026-08-19T10:00:02.000Z', { agentId: 'a1b2c3d4e5f6a7b8', async: false }))
    expect(acc.state.agents[0]).toMatchObject({ background: false, endedAt: '2026-08-19T10:00:02.000Z' })
  })

  it('a background agent closes on its task-notification (<task-id>)', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...agentLaunch('tu_agent1', '2026-08-19T10:00:02.000Z', { agentId: 'a1b2c3d4e5f6a7b8', background: true }),
      line({
        type: 'user',
        timestamp: '2026-08-19T10:05:00.000Z',
        message: { role: 'user', content: '<task-notification>\n<task-id>a1b2c3d4e5f6a7b8</task-id>\n<status>completed</status>\n</task-notification>' },
      }),
    ])
    expect(acc.state.agents[0]!.endedAt).toBe('2026-08-19T10:05:00.000Z')
  })

  it('with no in_progress task, the subagent carries no taskId', () => {
    const acc = new ContextAccumulator()
    acc.feedLines(agentLaunch('tu_agent1', '2026-08-19T10:00:02.000Z', { agentId: 'a1b2c3d4e5f6a7b8', background: true }))
    expect('taskId' in acc.state.agents[0]!).toBe(false)
  })
})

describe('ContextAccumulator — pending (AskUserQuestion)', () => {
  it('opens pending with the first question and its options', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({
        type: 'assistant',
        timestamp: '2026-08-19T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_ask',
              name: 'AskUserQuestion',
              input: { questions: [{ question: 'Where?', header: 'Location', options: [{ label: 'A', description: 'da' }, { label: 'B' }] }] },
            },
          ],
        },
      }),
    ])
    expect(acc.state.pending).toEqual({
      question: 'Where?',
      header: 'Location',
      askedAt: '2026-08-19T10:00:00.000Z',
      toolUseId: 'tu_ask',
      options: [{ label: 'A', description: 'da' }, { label: 'B' }],
    })
  })

  it('carries EVERY question of the call: the first in the flat fields, the rest in `more`, multiSelect kept', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({
        type: 'assistant',
        timestamp: '2026-08-19T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_ask',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  { question: 'Who?', header: 'Finance', options: [{ label: 'Investigate' }, { label: 'Fix' }] },
                  { question: 'Which?', header: 'Parts', multiSelect: true, options: [{ label: 'X', description: 'dx' }, { label: 'Y' }] },
                  { header: 'no text — skipped', options: [{ label: 'Z' }] },
                ],
              },
            },
          ],
        },
      }),
    ])
    expect(acc.state.pending).toEqual({
      question: 'Who?',
      header: 'Finance',
      askedAt: '2026-08-19T10:00:00.000Z',
      toolUseId: 'tu_ask',
      options: [{ label: 'Investigate' }, { label: 'Fix' }],
      more: [{ question: 'Which?', header: 'Parts', multiSelect: true, options: [{ label: 'X', description: 'dx' }, { label: 'Y' }] }],
    })
    // survives the cache round-trip
    expect(new ContextAccumulator(acc.state).state.pending).toEqual(acc.state.pending)
  })

  it("the tool_result of the question ITSELF closes pending right away — that's the answer", () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({
        type: 'assistant',
        timestamp: '2026-08-19T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'q', options: [{ label: 'A' }] }] } }],
        },
      }),
    ])
    expect(acc.state.pending).not.toBeNull()
    acc.feedLines([
      line({
        type: 'user',
        timestamp: '2026-08-19T10:00:05.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ask', content: '{"answers":{"q":"A"}}' }] },
      }),
    ])
    expect(acc.state.pending).toBeNull()
  })

  it('a later real user turn closes pending; an UNRELATED tool_result does not close it', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({
        type: 'assistant',
        timestamp: '2026-08-19T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'q', options: [] }] } }],
        },
      }),
      line({
        type: 'assistant',
        timestamp: '2026-08-19T10:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'ls' } }] },
      }),
      line({
        type: 'user',
        timestamp: '2026-08-19T10:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'output' }] },
      }),
    ])
    expect(acc.state.pending).not.toBeNull() // the tool_result does not close pending
    acc.feedLines([line({ type: 'user', timestamp: '2026-08-19T10:00:03.000Z', message: { role: 'user', content: 'option A' } })])
    expect(acc.state.pending).toBeNull()
  })
})

describe('ContextAccumulator — links (pr/artifact/worktree)', () => {
  it('pr-link, frame-link and worktree-state accumulate', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({ type: 'pr-link', prNumber: 15, prUrl: 'https://github.com/x/y/pull/15', prRepository: 'x/y', timestamp: '2026-08-19T10:00:00.000Z' }),
      line({ type: 'frame-link', path: '/tmp/a.html', frameUrl: 'https://claude.ai/code/artifact/1', timestamp: '2026-08-19T10:00:01.000Z' }),
      line({
        type: 'worktree-state',
        worktreeSession: { worktreePath: '/home/x/.claude/worktrees/y', worktreeName: 'y' },
      }),
    ])
    const { links } = acc.state
    expect(links.prs).toEqual([{ number: 15, url: 'https://github.com/x/y/pull/15', repo: 'x/y', ts: '2026-08-19T10:00:00.000Z' }])
    expect(links.artifacts).toEqual([{ path: '/tmp/a.html', url: 'https://claude.ai/code/artifact/1', ts: '2026-08-19T10:00:01.000Z' }])
    expect(links.worktree).toEqual({ path: '/home/x/.claude/worktrees/y', name: 'y' })
  })
})

describe('ContextAccumulator — artifacts published with the Artifact tool', () => {
  const publish = (id: string, path: string, url: string, title: string, ts: string) => [
    line({
      type: 'assistant',
      timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Artifact', input: { file_path: path, favicon: '📋' } }] },
    }),
    line({ type: 'frame-link', path, frameUrl: url, timestamp: ts }),
    line({
      type: 'user',
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Published ${path} at ${url}\n\nTo update: republish` }] },
      toolUseResult: { url, path, title, updated: false, version: 1 },
    }),
  ]

  it("the tool_result's title lands on the frame-link entry (the page title, not the file name)", () => {
    const acc = new ContextAccumulator()
    acc.feedLines(publish('tu_a', '/tmp/s/plan-bpmn.html', 'https://claude.ai/code/artifact/1', 'Regularization plan', '2026-08-26T10:00:00.000Z'))
    expect(acc.state.links.artifacts).toEqual([
      { path: '/tmp/s/plan-bpmn.html', url: 'https://claude.ai/code/artifact/1', ts: '2026-08-26T10:00:00.000Z', title: 'Regularization plan' },
    ])
  })

  it('a republish of the same URL updates the entry in place (title, ts) instead of appending', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...publish('tu_a', '/tmp/s/p.html', 'https://claude.ai/code/artifact/1', 'v1', '2026-08-26T10:00:00.000Z'),
      ...publish('tu_b', '/tmp/s/p.html', 'https://claude.ai/code/artifact/1', 'v2', '2026-08-26T11:00:00.000Z'),
    ])
    expect(acc.state.links.artifacts).toEqual([
      { path: '/tmp/s/p.html', url: 'https://claude.ai/code/artifact/1', ts: '2026-08-26T11:00:00.000Z', title: 'v2' },
    ])
  })

  it('without a frame-link line, the tool_result alone still yields the entry (Published <path> at <url>)', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({
        type: 'assistant',
        timestamp: '2026-08-26T10:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_a', name: 'Artifact', input: { file_path: '/tmp/s/p.html' } }] },
      }),
      line({
        type: 'user',
        timestamp: '2026-08-26T10:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'Published /tmp/s/p.html at https://claude.ai/code/artifact/9\n' }],
        },
      }),
    ])
    expect(acc.state.links.artifacts).toEqual([{ path: '/tmp/s/p.html', url: 'https://claude.ai/code/artifact/9', ts: '2026-08-26T10:00:01.000Z' }])
  })

  it('a non-publishing Artifact call (read/list/comments) yields nothing', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_a', name: 'Artifact', input: { action: 'list' } }] } }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: '1. Foo — https://claude.ai/code/artifact/1' }] },
      }),
    ])
    expect(acc.state.links.artifacts).toEqual([])
  })
})

describe('ContextAccumulator — events (system subtypes)', () => {
  it('maps each known subtype to its kind, and turn_duration is ignored', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({ type: 'system', subtype: 'model_consent_fallback', content: 'switched', timestamp: '2026-08-19T10:00:00.000Z' }),
      line({ type: 'system', subtype: 'model_refusal_fallback', content: 'refused', timestamp: '2026-08-19T10:00:01.000Z' }),
      line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: '2026-08-19T10:00:02.000Z' }),
      line({ type: 'system', subtype: 'scheduled_task_fire', content: 'wakeup', timestamp: '2026-08-19T10:00:03.000Z' }),
      line({ type: 'system', subtype: 'bridge_status', content: 'remote on', timestamp: '2026-08-19T10:00:04.000Z' }),
      line({ type: 'system', subtype: 'informational', content: 'fyi', timestamp: '2026-08-19T10:00:05.000Z' }),
      line({ type: 'system', subtype: 'turn_duration', durationMs: 100, timestamp: '2026-08-19T10:00:06.000Z' }),
    ])
    expect(acc.state.events).toEqual([
      { ts: '2026-08-19T10:00:00.000Z', kind: 'model', text: 'switched' },
      { ts: '2026-08-19T10:00:01.000Z', kind: 'refusal', text: 'refused' },
      { ts: '2026-08-19T10:00:02.000Z', kind: 'compact', text: 'Conversation compacted' },
      { ts: '2026-08-19T10:00:03.000Z', kind: 'loop', text: 'wakeup' },
      { ts: '2026-08-19T10:00:04.000Z', kind: 'remote', text: 'remote on' },
      { ts: '2026-08-19T10:00:05.000Z', kind: 'info', text: 'fyi' },
    ])
  })

  it('caps events at 50, keeping the most recent', () => {
    const acc = new ContextAccumulator()
    const lines = Array.from({ length: 55 }, (_, i) => line({ type: 'system', subtype: 'informational', content: `e${i}`, timestamp: `t${i}` }))
    acc.feedLines(lines)
    expect(acc.state.events).toHaveLength(50)
    expect(acc.state.events[0]!.text).toBe('e5')
    expect(acc.state.events[49]!.text).toBe('e54')
  })
})

describe('ContextAccumulator — files/tools', () => {
  it('counts Edit/Write/Read per path', () => {
    const acc = new ContextAccumulator()
    const tu = (name: string, path: string) =>
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu_${Math.random()}`, name, input: { file_path: path } }] },
      })
    acc.feedLines([tu('Read', '/a.ts'), tu('Edit', '/a.ts'), tu('Edit', '/a.ts'), tu('Write', '/b.ts')])
    const files = acc.state.files
    expect(files.find((f) => f.path === '/a.ts')).toEqual({ path: '/a.ts', edits: 2, writes: 0, reads: 1, sent: 0, disk: 0 })
    expect(files.find((f) => f.path === '/b.ts')).toEqual({ path: '/b.ts', edits: 0, writes: 1, reads: 0, sent: 0, disk: 0 })
  })

  it('caps at 200 distinct paths', () => {
    const acc = new ContextAccumulator()
    const lines = Array.from({ length: 210 }, (_, i) =>
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu_${i}`, name: 'Read', input: { file_path: `/f${i}.ts` } }] },
      }),
    )
    acc.feedLines(lines)
    expect(acc.state.files).toHaveLength(200)
  })

  it('files handed over with SendUserFile count as touched (sent), one entry per path', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_s', name: 'SendUserFile', input: { files: ['/tmp/s/1-report.pdf', '/tmp/s/2-usage.csv'], status: 'normal' } }],
        },
      }),
    ])
    expect(acc.state.files.map((f) => [f.path, f.sent])).toEqual([
      ['/tmp/s/1-report.pdf', 1],
      ['/tmp/s/2-usage.csv', 1],
    ])
  })

  it('aggregates every tool_use and splits server/tool in mcp__server__tool', () => {
    const acc = new ContextAccumulator()
    const tu = (name: string) =>
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu_${Math.random()}`, name, input: {} }] },
      })
    acc.feedLines([tu('Bash'), tu('Bash'), tu('mcp__claude_ai_Gmail__send_message')])
    const tools = acc.state.tools
    expect(tools.find((t) => t.name === 'Bash')).toEqual({ name: 'Bash', server: null, count: 2 })
    expect(tools.find((t) => t.name === 'send_message')).toEqual({ name: 'send_message', server: 'claude_ai_Gmail', count: 1 })
  })
})

describe('ContextAccumulator — waiting (Monitor/ScheduleWakeup/Workflow)', () => {
  it('opens waiting on seeing the tool_use and closes it on its tool_result', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({
        type: 'assistant',
        timestamp: '2026-08-19T10:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_mon', name: 'Monitor', input: { description: 'waiting on the build' } }] },
      }),
    ])
    expect(acc.state.waiting).toEqual({ kind: 'monitor', since: '2026-08-19T10:00:00.000Z', label: 'waiting on the build' })
    acc.feedLines([line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_mon', content: 'ready' }] } })])
    expect(acc.state.waiting).toBeNull()
  })

  it('ScheduleWakeup and Workflow also open waiting with their own kind', () => {
    const acc1 = new ContextAccumulator()
    acc1.feedLines([
      line({
        type: 'assistant',
        timestamp: 't1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ScheduleWakeup', input: { reason: 'sleep' } }] },
      }),
    ])
    expect(acc1.state.waiting).toMatchObject({ kind: 'wakeup', label: 'sleep' })

    const acc2 = new ContextAccumulator()
    acc2.feedLines([
      line({
        type: 'assistant',
        timestamp: 't2',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Workflow', input: { meta: { name: 'my-workflow' } } }] },
      }),
    ])
    expect(acc2.state.waiting).toMatchObject({ kind: 'workflow', label: 'my-workflow' })
  })
})

describe('ContextAccumulator — flags', () => {
  it('bridge-session activates remote; permission-mode and gitBranch/effort/model are captured', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({ type: 'permission-mode', permissionMode: 'bypassPermissions' }),
      line({ type: 'bridge-session', bridgeSessionId: 'cse_x' }),
      line({ type: 'user', gitBranch: 'main', effort: 'high', message: { role: 'user', content: 'hi' } }),
      line({
        type: 'assistant',
        gitBranch: 'main',
        effort: 'high',
        message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }] },
      }),
    ])
    expect(acc.state.flags).toEqual({ remote: true, permissionMode: 'bypassPermissions', gitBranch: 'main', effort: 'high', model: 'claude-sonnet-5' })
  })

  it('with no signal at all, flags default', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([line({ type: 'user', message: { role: 'user', content: 'hi' } })])
    expect(acc.state.flags).toEqual({ remote: false, permissionMode: null, gitBranch: null, effort: null, model: null })
  })
})

describe('ContextAccumulator — round-trip via state (cache)', () => {
  it('a complete state survives new ContextAccumulator(state)', () => {
    const acc1 = new ContextAccumulator()
    acc1.feedLines([
      ...taskCreate('1', 'Task', '2026-08-19T10:00:00.000Z'),
      ...taskUpdate('tu_u1', '1', '2026-08-19T10:00:01.000Z', 'in_progress'),
      line({ type: 'pr-link', prNumber: 1, prUrl: 'u', prRepository: 'r', timestamp: 't' }),
      line({ type: 'permission-mode', permissionMode: 'bypassPermissions' }),
      line({
        type: 'assistant',
        timestamp: 't2',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_mon', name: 'Monitor', input: { description: 'x' } }] },
      }),
      line({
        type: 'assistant',
        timestamp: 't3',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_r', name: 'Read', input: { file_path: '/a.ts' } }] },
      }),
      line({ type: 'system', subtype: 'informational', content: 'event', timestamp: 't4' }),
    ])
    const state1 = acc1.state
    const acc2 = new ContextAccumulator(state1)
    expect(acc2.state).toEqual(state1)
  })

  it('an empty state also round-trips', () => {
    const acc1 = new ContextAccumulator()
    const acc2 = new ContextAccumulator(acc1.state)
    expect(acc2.state).toEqual(acc1.state)
  })
})

describe('ContextAccumulator — robustness', () => {
  it('a corrupt line does not break the rest', () => {
    const acc = new ContextAccumulator()
    acc.feedLines(['{not json', line({ type: 'permission-mode', permissionMode: 'bypassPermissions' })])
    expect(acc.state.flags.permissionMode).toBe('bypassPermissions')
  })

  it('feedLines does not break on empty lines', () => {
    const acc = new ContextAccumulator()
    expect(() => acc.feedLines(['', '  '])).not.toThrow()
  })
})

// ---- disk attribution (a tool call NAMES a plans/*.plan.json path) --------
// The Read/Write/Edit rule is blind to Bash heredocs, scripts and subagents
// (decision: option B). Attribution is deterministic — no
// clocks: any tool_use whose input mentions a plan path (the Bash command,
// a subagent's prompt) touches that plan, resolved against the session's
// cwd. What a session never named is never its.
describe('ContextAccumulator — disk attribution of plan files', () => {
  const cwdLine = line({ type: 'user', cwd: '/proj', message: { role: 'user', content: 'go' } })
  // unit tests stay fs-free: every path is "real" unless a test says otherwise
  const accWithExists = (exists: (p: string) => boolean = () => true) => {
    const acc = new ContextAccumulator()
    acc.pathExists = exists
    return acc
  }
  const bash = (command: string, id = 'tu_b') =>
    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    })

  it('context/<scope>/ mentions count at any depth (deliverables convention)', () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash('python3 audit.py > context/builder/analysis/16-economic-audit.md && cp x.csv context/shared/data/2026/q4.csv')])
    expect(acc.state.files.map((f) => [f.path, f.disk])).toEqual([
      ['/proj/context/builder/analysis/16-economic-audit.md', 1],
      ['/proj/context/shared/data/2026/q4.csv', 1],
    ])
  })
  it("an absolute path under an agent's own state folder counts; the unexpanded $SILOS_AGENT_STATE does not (documented gap)", () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash('cat > /home/u/.silos/agent-state/builder/reports/q4.md <<EOF\nx\nEOF\ncp q4.md $SILOS_AGENT_STATE/copy.md')])
    expect(acc.state.files.map((f) => f.path)).toEqual(['/home/u/.silos/agent-state/builder/reports/q4.md'])
  })
  // no clock: the input is the guard. The cubic shape took 40 s on 8 KB;
  // these are 14–20 KB, so a regression cannot finish inside the test
  // timeout, while the linear token scan takes about a millisecond.
  it('pathological repeated segments attribute nothing and stay linear (was cubic backtracking)', () => {
    for (const command of ['context/a/'.repeat(2000), '/agent-state/a'.repeat(1000)]) {
      const acc = accWithExists()
      acc.feedLines([cwdLine, bash(command)])
      expect(acc.state.files).toEqual([])
    }
  })
  it('a Claude-style @ citation names the same file (one leading @ stripped)', () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash('see @context/builder/x.md and @plans/p.plan.json')])
    expect(acc.state.files.map((f) => f.path)).toEqual(['/proj/context/builder/x.md', '/proj/plans/p.plan.json'])
  })
  it('a context/ folder inside node_modules is a library, not a deliverable', () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash('cat node_modules/react/context/x/y.js')])
    expect(acc.state.files).toEqual([])
  })
  it('a relative …/agent-state/ path is never taken for an absolute one', () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash('echo x > foo/agent-state/builder/a.md; echo y > xfoo/agent-state/builder/b.md')])
    expect(acc.state.files).toEqual([])
  })
  it('a path at the start of a heredoc line counts; a prose full stop is not part of it', () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash('cat <<EOF\nplans/h.plan.json\nEOF\necho see context/shared/notes.md.')])
    expect(acc.state.files.map((f) => f.path)).toEqual(['/proj/plans/h.plan.json', '/proj/context/shared/notes.md'])
  })
  it('a path that merely contains the word context is not a deliverable', () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash('echo x > docs/context-notes.md; echo y > contexts/a/b.md')])
    expect(acc.state.files).toEqual([])
  })

  it('a Bash heredoc that names a relative plan path touches it, resolved against the session cwd', () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash("cat > plans/x.plan.json <<'EOF'\n{}\nEOF")])
    expect(acc.state.files).toEqual([{ path: '/proj/plans/x.plan.json', edits: 0, writes: 0, reads: 0, sent: 0, disk: 1 }])
  })

  it('absolute and ~/ paths resolve; ./ is normalized; several mentions in ONE call count once each', () => {
    const acc = accWithExists()
    acc.feedLines([bash('python3 edit.py /home/u/proj/plans/a.plan.json /home/u/proj/plans/a.plan.json ./plans/b.plan.json ~/other/plans/c.plan.json')])
    // no cwd yet → the relative ./plans/b is skipped (cannot be resolved honestly)
    const paths = acc.state.files.map((f) => [f.path, f.disk])
    expect(paths).toContainEqual(['/home/u/proj/plans/a.plan.json', 1])
    expect(paths.some(([p]) => String(p).endsWith('/other/plans/c.plan.json'))).toBe(true)
    expect(paths).toHaveLength(2)
  })

  it("a subagent's prompt naming the plan attributes it to this session (the Agent tool_use carries the path)", () => {
    const acc = accWithExists()
    acc.feedLines([
      cwdLine,
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_a',
              name: 'Agent',
              input: { description: 'update plan', prompt: 'Mark t3 done in plans/sprint.plan.json and recompute' },
            },
          ],
        },
      }),
    ])
    expect(acc.state.files.map((f) => [f.path, f.disk])).toEqual([['/proj/plans/sprint.plan.json', 1]])
  })

  it("what the session never NAMED is never its — another session's concurrent write cannot stick", () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash('npm test'), bash('git commit -m x', 'tu_c')])
    expect(acc.state.files).toEqual([])
  })

  it('Read/Write/Edit inputs are NOT scanned (file_path already counts them — no double touch)', () => {
    const acc = accWithExists()
    acc.feedLines([
      cwdLine,
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_w', name: 'Write', input: { file_path: '/proj/plans/x.plan.json', content: 'see plans/x.plan.json' } }],
        },
      }),
    ])
    expect(acc.state.files).toEqual([{ path: '/proj/plans/x.plan.json', edits: 0, writes: 1, reads: 0, sent: 0, disk: 0 }])
  })

  it('a later Read of a Bash-touched plan merges into the same entry', () => {
    const acc = accWithExists()
    acc.feedLines([
      cwdLine,
      bash('sed -i s/x/y/ plans/x.plan.json'),
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_r', name: 'Read', input: { file_path: '/proj/plans/x.plan.json' } }] },
      }),
    ])
    expect(acc.state.files).toEqual([{ path: '/proj/plans/x.plan.json', edits: 0, writes: 0, reads: 1, sent: 0, disk: 1 }])
  })

  it('context/<scope>/<file> mentions count too (t11): a Bash-generated PDF lands in files', () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash('python3 make-pdf.py && mv out.pdf context/shared/date-change-letter.pdf')])
    expect(acc.state.files).toEqual([{ path: '/proj/context/shared/date-change-letter.pdf', edits: 0, writes: 0, reads: 0, sent: 0, disk: 1 }])
  })

  it('a mentioned path that does not EXIST is never attributed — code that cites plan paths (tests, docs) stays out', () => {
    const acc = accWithExists((p) => p === '/proj/plans/real.plan.json')
    acc.feedLines([
      cwdLine,
      bash("cat > test/x.test.ts <<'EOF'\nexpect('/tmp/fake/plans/x.plan.json')\nEOF"),
      bash('sed -i s/a/b/ plans/real.plan.json', 'tu_c'),
    ])
    expect(acc.state.files.map((f) => f.path)).toEqual(['/proj/plans/real.plan.json'])
  })

  it('a Bash append that names the SDD ledger touches it like a plan (the executor writes its own record)', () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash("cat >> .superpowers/sdd/2026-10-27-x/progress.md <<'EOF'\nTask 1: complete (a)\nEOF")])
    expect(acc.state.files).toEqual([{ path: '/proj/.superpowers/sdd/2026-10-27-x/progress.md', edits: 0, writes: 0, reads: 0, sent: 0, disk: 1 }])
  })

  it('a progress.md outside a plan folder of .superpowers/sdd is no ledger', () => {
    const acc = accWithExists()
    acc.feedLines([cwdLine, bash('echo x >> .superpowers/sdd/progress.md; echo y >> notes/progress.md')])
    expect(acc.state.files).toEqual([])
  })

  it('an old cached file entry without `disk` round-trips as disk: 0', () => {
    const acc = new ContextAccumulator({
      plan: null,
      agents: [],
      pending: null,
      links: { prs: [], artifacts: [], worktree: null },
      events: [],
      files: [{ path: '/a', edits: 1, writes: 0, reads: 0, sent: 0 } as never],
      tools: [],
      flags: { remote: false, permissionMode: null, gitBranch: null, effort: null, model: null },
      waiting: null,
    })
    expect(acc.state.files[0]).toEqual({ path: '/a', edits: 1, writes: 0, reads: 0, sent: 0, disk: 0 })
  })
})

// c7: documents pasted into the conversation — real shape
// verified: a user entry whose content carries {type:'document',
// source:{type:'base64', media_type, data}} and NOTHING else (no filename
// anywhere). Silos lists type+size+when; the bytes are estimated from the
// base64 length (3/4), never decoded here.
const docLine = (ts: string, chars: number, mediaType = 'application/pdf') =>
  line({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: mediaType, data: 'A'.repeat(chars) } }] },
  })

describe('ContextAccumulator — documents (pasted into the conversation)', () => {
  it('accumulates document blocks with media type, approx bytes and ts', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([docLine('2026-08-12T19:29:56.477Z', 400)])
    expect(acc.state.documents).toEqual([{ mediaType: 'application/pdf', bytes: 300, ts: '2026-08-12T19:29:56.477Z' }])
  })

  it('keeps only the LAST 20 and survives a state round-trip; an old cache restores to []', () => {
    const acc = new ContextAccumulator()
    acc.feedLines(Array.from({ length: 23 }, (_, i) => docLine(`2026-08-12T19:00:${String(i).padStart(2, '0')}.000Z`, 4)))
    expect(acc.state.documents).toHaveLength(20)
    expect(acc.state.documents[19]!.ts).toBe('2026-08-12T19:00:22.000Z')
    const restored = new ContextAccumulator(acc.state)
    expect(restored.state.documents).toEqual(acc.state.documents)
    const { documents: _d, ...old } = acc.state
    expect(new ContextAccumulator(old as never).state.documents).toEqual([])
  })

  it('a malformed document block (no source/media_type) is ignored', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({ type: 'user', timestamp: 't', message: { role: 'user', content: [{ type: 'document' }, { type: 'document', source: { type: 'base64' } }] } }),
    ])
    expect(acc.state.documents).toEqual([])
  })
})

// c4: file-history — Claude Code's /rewind checkpoints. Real shape
// file-history-delta {trackingPath, backup:{version, backupTime},
// timestamp}; snapshots carry an empty trackedFileBackups map, so the
// DELTAS are the signal. Grouped per file: versions + last checkpoint.
const fhDelta = (path: string, version: number, backupTime: string) =>
  line({
    type: 'file-history-delta',
    messageId: 'm',
    snapshotMessageId: 's',
    trackingPath: path,
    backup: { backupFileName: null, version, backupTime, realParentDir: '/x' },
    timestamp: backupTime,
  })

describe('ContextAccumulator — file history (rewind checkpoints)', () => {
  it('groups deltas per file: version count and last checkpoint time, newest file first', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      fhDelta('docs/a.md', 1, '2026-08-17T17:10:26.970Z'),
      fhDelta('docs/a.md', 2, '2026-08-17T17:20:00.000Z'),
      fhDelta('src/b.ts', 1, '2026-08-17T17:15:00.000Z'),
    ])
    expect(acc.state.fileHistory).toEqual([
      { path: 'docs/a.md', versions: 2, lastAt: '2026-08-17T17:20:00.000Z' },
      { path: 'src/b.ts', versions: 1, lastAt: '2026-08-17T17:15:00.000Z' },
    ])
  })

  it('a malformed delta is ignored; no deltas -> empty; survives round-trip and old caches', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([line({ type: 'file-history-delta', trackingPath: 7 })])
    expect(acc.state.fileHistory).toEqual([])
    acc.feedLines([fhDelta('a', 1, 't1')])
    const restored = new ContextAccumulator(acc.state)
    expect(restored.state.fileHistory).toEqual(acc.state.fileHistory)
    const { fileHistory: _f, ...old } = acc.state
    expect(new ContextAccumulator(old as never).state.fileHistory).toEqual([])
  })
})

// request blobs (newer Claude Code) replay the conversation's messages —
// the context counts each tool call and document ONCE, from the real
// records only.
describe('ContextAccumulator — request blobs are not conversation', () => {
  it('tools, documents and model come only from type user|assistant records', async () => {
    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(new URL('./fixtures/request-blobs.jsonl', import.meta.url), 'utf8').split('\n')
    const acc = new ContextAccumulator()
    acc.feedLines(lines)
    expect(acc.state.tools.find((t) => t.name === 'Bash')).toEqual({ name: 'Bash', server: null, count: 1 })
    expect(acc.state.documents).toEqual([]) // the only document rode a blob
    expect(acc.state.flags.model).toBe('claude-opus-4-1')
  })
})

describe('ContextAccumulator — the login of the latest start (session_context)', () => {
  it('keeps the email of the LAST session_context: the account the conversation last ran on', () => {
    const acc = new ContextAccumulator()
    const sc = (email: string, ts: string) =>
      line({
        type: 'attachment',
        timestamp: ts,
        attachment: { type: 'session_context', context: { userEmail: `The user's email address is ${email}. Use it only to identify the user.` } },
      })
    acc.feedLines([sc('a@x.com', '2026-10-27T10:00:00Z'), sc('b@y.com', '2026-10-30T10:00:00Z')])
    expect(acc.state.flags.accountEmail).toBe('b@y.com')
  })
  it('no session_context → no accountEmail', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([line({ type: 'user', timestamp: '2026-10-27T10:00:00Z', message: { role: 'user', content: 'hi' } })])
    expect(acc.state.flags.accountEmail).toBeUndefined()
  })
})

describe('ContextAccumulator — outbound (SendMessage waits + inter-agent messages sent)', () => {
  // real shapes: SendMessage input {to, summary, message} (corpus 396e6c9c);
  // replies arrive as user turns carrying <cross-session-message
  // from="uds:…" from-name="silos-1a" from-mode="bypass">; an inter-agent message is a
  // Bash curl POST /api/agents/<id>/messages whose 201 echoes the stored
  // message {"message":{"id":"<ms base36>-<6 base36>",…,"to":"finance",…}}
  const sendMessage = (toolId: string, input: Record<string, unknown>, ts: string, result = 'Message sent', isError = false) => [
    line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'SendMessage', input }] } }),
    line({
      type: 'user',
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: result, ...(isError ? { is_error: true } : {}) }] },
    }),
  ]
  const bash = (toolId: string, command: string, ts: string, result: string, isError = false) => [
    line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command } }] } }),
    line({
      type: 'user',
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: result, ...(isError ? { is_error: true } : {}) }] },
    }),
  ]
  const ownerTurn = (text: string, ts: string) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
  const MESSAGE_201 =
    '{"message":{"id":"mh3k2x9a-ab12cd","from":"owner","to":"finance","at":"2026-11-03T10:00:00Z","urgent":false,"text":"review the invoices","state":"new"}}'

  it('an answered SendMessage opens a wait with the input summary; the reply from that name clears it, others stay', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...sendMessage('tu_s1', { to: 'silos-1a', summary: 'merge scope-layers', message: 'long…' }, '2026-11-03T10:00:00Z'),
      ...sendMessage('tu_s2', { to: 'silos-0b', message: 'look at the old plans and tell me' }, '2026-11-03T10:01:00Z'),
    ])
    expect(acc.state.outbound).toEqual([
      { kind: 'session', to: 'silos-1a', summary: 'merge scope-layers', since: '2026-11-03T10:00:00Z' },
      { kind: 'session', to: 'silos-0b', summary: 'look at the old plans and tell me', since: '2026-11-03T10:01:00Z' },
    ])
    acc.feedLines([
      ownerTurn(
        '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="silos-1a" from-mode="bypass">\ndone\n</cross-session-message>',
        '2026-11-03T10:05:00Z',
      ),
    ])
    expect(acc.state.outbound).toEqual([{ kind: 'session', to: 'silos-0b', summary: 'look at the old plans and tell me', since: '2026-11-03T10:01:00Z' }])
  })

  it('a reply closes a wait keyed to the ADDRESS too (a send that answered a peer uses its uds from=)', () => {
    const acc = new ContextAccumulator()
    acc.feedLines(sendMessage('tu_s1', { to: 'uds:/tmp/cc-socks/3129115.sock', summary: 'already solved', message: 'x' }, '2026-11-03T10:00:00Z'))
    expect(acc.state.outbound).toHaveLength(1)
    acc.feedLines([
      ownerTurn(
        '<cross-session-message from="uds:/tmp/cc-socks/3129115.sock" from-name="see-plan-mode-conversation" from-mode="bypass">\nok\n</cross-session-message>',
        '2026-11-03T10:06:00Z',
      ),
    ])
    expect(acc.state.outbound).toBeUndefined()
  })

  it('an errored SendMessage opens nothing', () => {
    const acc = new ContextAccumulator()
    acc.feedLines(sendMessage('tu_s1', { to: 'nobody', message: 'x' }, '2026-11-03T10:00:00Z', 'No agent named nobody', true))
    expect(acc.state.outbound).toBeUndefined()
  })

  it('a second message to the same name re-stamps the one wait', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...sendMessage('tu_s1', { to: 'silos-1a', summary: 'one', message: 'x' }, '2026-11-03T10:00:00Z'),
      ...sendMessage('tu_s2', { to: 'silos-1a', summary: 'two', message: 'y' }, '2026-11-03T10:02:00Z'),
    ])
    expect(acc.state.outbound).toEqual([{ kind: 'session', to: 'silos-1a', summary: 'two', since: '2026-11-03T10:02:00Z' }])
  })

  it("the owner's typed turn clears the session waits and keeps the inter-agent messages; noise (a <tag> line, Caveat) does not", () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...sendMessage('tu_s1', { to: 'silos-1a', summary: 's', message: 'x' }, '2026-11-03T10:00:00Z'),
      ...bash(
        'tu_b1',
        `curl -s -X POST http://127.0.0.1:3210/api/agents/finance/messages -d '{"text":"review the invoices"}'`,
        '2026-11-03T10:01:00Z',
        MESSAGE_201,
      ),
      ownerTurn('Caveat: the messages below were generated', '2026-11-03T10:02:00Z'),
    ])
    expect(acc.state.outbound).toHaveLength(2)
    acc.feedLines([ownerTurn('ok, carry on with the rest', '2026-11-03T10:03:00Z')])
    expect(acc.state.outbound).toEqual([
      { kind: 'message', to: 'finance', summary: 'review the invoices', since: '2026-11-03T10:01:00Z', messageId: 'mh3k2x9a-ab12cd' },
    ])
  })

  it('a task-notification from a subagent messaged by id closes its wait', () => {
    const acc = new ContextAccumulator()
    acc.feedLines(sendMessage('tu_s1', { to: 'a0fdb60f7968a7470', summary: 'carry on with Tasks 3-4', message: 'x' }, '2026-11-03T10:00:00Z'))
    expect(acc.state.outbound).toHaveLength(1)
    acc.feedLines([ownerTurn('<task-notification>done</task-notification> <task-id>a0fdb60f7968a7470</task-id>', '2026-11-03T10:04:00Z')])
    expect(acc.state.outbound).toBeUndefined()
  })

  it('an inter-agent message POST counts only when the result echoes the stored message, and takes `to` from the response', () => {
    const acc = new ContextAccumulator()
    acc.feedLines(
      bash(
        'tu_b1',
        `curl -s -X POST 'http://127.0.0.1:3210/api/agents/c%66o/messages' --data '{"text":"review the October invoices, 674 are overdue"}'`,
        '2026-11-03T10:00:00Z',
        MESSAGE_201,
      ),
    )
    expect(acc.state.outbound).toEqual([
      { kind: 'message', to: 'finance', summary: 'review the October invoices, 674 are overdue', since: '2026-11-03T10:00:00Z', messageId: 'mh3k2x9a-ab12cd' },
    ])
  })

  it('quoting the URL without sending opens nothing: a doc write, a GET, a refused POST', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      // a brief that only MENTIONS the door (echo has no body flag and the result stores no message)
      ...bash('tu_b1', `echo 'send messages with POST /api/agents/builder/messages' > context/builder/brief.md`, '2026-11-03T10:00:00Z', ''),
      // reading an inbox is not sending
      ...bash(
        'tu_b2',
        `curl -s http://127.0.0.1:3210/api/agents/builder/messages | head -c 400`,
        '2026-11-03T10:01:00Z',
        '{"messages":[{"id":"mh000000-aaaaaa","to":"builder","state":"new"}]}',
      ),
      // a 409 stores nothing — no id in the response
      ...bash(
        'tu_b3',
        `curl -s -X POST http://127.0.0.1:3210/api/agents/master/messages -d '{"text":"hi"}'`,
        '2026-11-03T10:02:00Z',
        '{"error":"Anywhere has no inbox reader"}',
      ),
      // PATCHing a message is not sending one
      ...bash(
        'tu_b4',
        `curl -s -X PATCH http://127.0.0.1:3210/api/agents/builder/messages/mh3k2x9a-ab12cd -d '{"state":"read"}'`,
        '2026-11-03T10:03:00Z',
        MESSAGE_201,
      ),
    ])
    expect(acc.state.outbound).toBeUndefined()
  })

  it('bounded: at most 5 inter-agent messages, oldest dropped', () => {
    const acc = new ContextAccumulator()
    const lines: string[] = []
    for (let i = 0; i < 7; i++) {
      const resp = `{"message":{"id":"mh3k2x9${i}-ab12cd","from":"owner","to":"finance","at":"x","urgent":false,"text":"n${i}","state":"new"}}`
      lines.push(
        ...bash(`tu_b${i}`, `curl -s -X POST http://127.0.0.1:3210/api/agents/finance/messages -d '{"text":"n${i}"}'`, `2026-11-03T10:0${i}:00Z`, resp),
      )
    }
    acc.feedLines(lines)
    expect(acc.state.outbound).toHaveLength(5)
    expect(acc.state.outbound![0]!.summary).toBe('n2')
  })

  it('round-trips via state, dropping the live-joined fields a caller might have cached', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...sendMessage('tu_s1', { to: 'silos-1a', summary: 's', message: 'x' }, '2026-11-03T10:00:00Z'),
      ...bash('tu_b1', `curl -s -X POST http://127.0.0.1:3210/api/agents/finance/messages -d '{"text":"t"}'`, '2026-11-03T10:01:00Z', MESSAGE_201),
    ])
    const cached = structuredClone(acc.state)
    cached.outbound![1] = { ...cached.outbound![1]!, state: 'answered', answer: 'done' }
    const back = new ContextAccumulator(cached).state
    expect(back.outbound).toEqual(acc.state.outbound)
    expect(back.outbound![1]).not.toHaveProperty('state')
  })
})

describe('ContextAccumulator — background commands (Bash run_in_background)', () => {
  const bgUse = (id: string, input: Record<string, unknown>) =>
    line({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { run_in_background: true, ...input } }] },
    })
  const bgResult = (toolUseId: string, taskId: string) =>
    line({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `task ${taskId} running` }] },
      toolUseResult: { backgroundTaskId: taskId },
    })

  it('a backgrounded Bash becomes a row at its result (label = description, else the command), and its task-notification ends it', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([bgUse('tu_a', { command: 'until done; do sleep 9; done\necho x', description: 'Watch the deploy' }), bgResult('tu_a', 'task_1')])
    acc.feedLines([bgUse('tu_b', { command: 'npm run watch -- --long' }), bgResult('tu_b', 'task_2')])
    expect(acc.state.background).toEqual([
      expect.objectContaining({ id: 'task_1', label: 'Watch the deploy' }),
      expect.objectContaining({ id: 'task_2', label: 'npm run watch -- --long' }),
    ])
    acc.feedLines([line({ type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>task_1</task-id>\n<status>completed</status>' } })])
    expect(acc.state.background).toEqual([expect.objectContaining({ id: 'task_2' })])
  })

  it('a foreground Bash, an errored result, or one without a task id adds no row; rows survive the cache roundtrip; a stale row is not served', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_fg', name: 'Bash', input: { command: 'ls' } }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_fg', content: 'ok' }] } }),
      bgUse('tu_err', { command: 'x' }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_err', is_error: true, content: 'refused' }] },
        toolUseResult: { backgroundTaskId: 'task_e' },
      }),
      bgUse('tu_noid', { command: 'y' }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_noid', content: 'ok' }] } }),
    ])
    expect(acc.state.background).toBeUndefined()
    acc.feedLines([bgUse('tu_live', { description: 'alive' }), bgResult('tu_live', 'task_l')])
    const reloaded = new ContextAccumulator(acc.state)
    expect(reloaded.state.background).toEqual([expect.objectContaining({ id: 'task_l', label: 'alive' })])
    // a row whose notification never came (the engine died) leaves the serving after SHELL_MAX_MS
    const stale = new ContextAccumulator()
    stale.feedLines([
      line({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_old', name: 'Bash', input: { run_in_background: true, command: 'z' } }] },
      }),
      line({
        type: 'user',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_old', content: 'ok' }] },
        toolUseResult: { backgroundTaskId: 'task_old' },
      }),
    ])
    expect(stale.state.background).toBeUndefined()
  })
})
