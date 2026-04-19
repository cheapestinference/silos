import { describe, it, expect } from 'vitest';
import {
  normalizeMessage,
  extractToolMessagesFromBlocks,
  buildToolResultMap,
  injectToolResultBlocks,
} from './message-normalizer';

describe('normalizeMessage', () => {
  it('returns null for non-objects', () => {
    expect(normalizeMessage(null)).toBeNull();
    expect(normalizeMessage('nope')).toBeNull();
  });
  it('strips inbound metadata from user text', () => {
    const raw = {
      role: 'user',
      timestamp: 1_000,
      content: [
        {
          type: 'text',
          text:
            'Sender (untrusted metadata):\n```json\n{"x":1}\n```\n\n[Wed 2026-03-11 23:51 PDT] hola',
        },
      ],
    };
    const out = normalizeMessage(raw);
    expect(out?.role).toBe('user');
    expect(out?.content).toBe('hola');
    expect(out?.contentBlocks).toHaveLength(1);
    expect(out?.contentBlocks[0]).toEqual({ type: 'text', text: 'hola' });
  });
  it('preserves assistant array content and prefers final_answer', () => {
    const raw = {
      role: 'assistant',
      timestamp: 2_000,
      content: [
        {
          type: 'text',
          text: 'commentary text',
          textSignature: JSON.stringify({ phase: 'commentary' }),
        },
        {
          type: 'text',
          text: 'final answer',
          textSignature: JSON.stringify({ phase: 'final_answer' }),
        },
      ],
    };
    const out = normalizeMessage(raw);
    expect(out?.content).toBe('final answer');
    expect(out?.contentBlocks).toHaveLength(2);
  });
  it('derives a uniform phase when present', () => {
    const raw = {
      role: 'assistant',
      timestamp: 0,
      content: [
        { type: 'text', text: 'a', textSignature: JSON.stringify({ phase: 'final_answer' }) },
        { type: 'text', text: 'b', textSignature: JSON.stringify({ phase: 'final_answer' }) },
      ],
    };
    expect(normalizeMessage(raw)?.phase).toBe('final_answer');
  });
  it('returns undefined phase when mixed', () => {
    const raw = {
      role: 'assistant',
      timestamp: 0,
      content: [
        { type: 'text', text: 'a', textSignature: JSON.stringify({ phase: 'commentary' }) },
        { type: 'text', text: 'b', textSignature: JSON.stringify({ phase: 'final_answer' }) },
      ],
    };
    expect(normalizeMessage(raw)?.phase).toBeUndefined();
  });
  it('extracts senderLabel when present', () => {
    const raw = { role: 'user', timestamp: 0, content: 'hi', senderLabel: 'Bot' };
    expect(normalizeMessage(raw)?.senderLabel).toBe('Bot');
  });
  it('normalizes senderLabel=null when empty', () => {
    const raw = { role: 'user', timestamp: 0, content: 'hi', senderLabel: '   ' };
    expect(normalizeMessage(raw)?.senderLabel).toBeNull();
  });
});

describe('extractToolMessagesFromBlocks', () => {
  it('produces one tool ChatMessage per tool_call block', () => {
    const tools = extractToolMessagesFromBlocks('msg1', 0, 1_000, 'run1', [
      { type: 'tool_call', name: 'cron', args: { a: 1 }, toolCallId: 'c1' },
      { type: 'text', text: 'ignored' },
      { type: 'tool_call', name: 'shell', toolCallId: 'c2' },
    ]);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ toolName: 'cron', toolCall: { a: 1 }, runId: 'run1' });
    expect(tools[1]).toMatchObject({ toolName: 'shell' });
  });

  it('pairs tool_call with its result via resultByCallId map', () => {
    const map = new Map([['c1', { text: 'ok, done', isError: false }]]);
    const tools = extractToolMessagesFromBlocks('msg', 0, 1_000, 'run', [
      { type: 'tool_call', name: 'cron', args: {}, toolCallId: 'c1' },
    ], map);
    expect(tools).toHaveLength(1);
    expect(tools[0].result).toBe('ok, done');
    expect(tools[0].content).toBe('ok, done');
  });

  it('marks orphan tool_calls with an abort notice when no matching result', () => {
    const tools = extractToolMessagesFromBlocks('msg', 0, 1_000, 'run', [
      { type: 'tool_call', name: 'browser', toolCallId: 'orphan' },
    ], new Map());
    expect(tools).toHaveLength(1);
    expect(tools[0].result).toBeUndefined();
    expect(tools[0].content).toMatch(/aborted|no result/i);
  });
});

describe('buildToolResultMap', () => {
  it('collects OpenClaw-style top-level role=toolResult messages', () => {
    const map = buildToolResultMap([
      { role: 'assistant', content: [{ type: 'toolCall', name: 'browser', toolCallId: 'tc1' }] },
      {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'browser',
        content: [{ type: 'text', text: 'page loaded' }],
        isError: false,
      },
    ]);
    expect(map.size).toBe(1);
    expect(map.get('tc1')).toEqual({ text: 'page loaded', isError: false });
  });

  it('collects Anthropic-style tool_result content blocks', () => {
    const map = buildToolResultMap([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shell', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'stdout: ok' }] },
    ]);
    expect(map.size).toBe(1);
    expect(map.get('t1')?.text).toBe('stdout: ok');
  });

  it('propagates isError flag', () => {
    const map = buildToolResultMap([
      { role: 'toolResult', toolCallId: 'x', content: 'boom', isError: true },
    ]);
    expect(map.get('x')).toEqual({ text: 'boom', isError: true });
  });

  it('ignores messages without a toolCallId', () => {
    const map = buildToolResultMap([{ role: 'toolResult', content: 'orphan' }]);
    expect(map.size).toBe(0);
  });
});

describe('injectToolResultBlocks', () => {
  it('inserts a synthetic tool_result immediately after each matching tool_call', () => {
    const map = new Map([['c1', { text: 'done' }]]);
    const out = injectToolResultBlocks(
      [
        { type: 'text', text: 'calling' },
        { type: 'tool_call', name: 'browser', toolCallId: 'c1' },
        { type: 'text', text: 'after' },
      ],
      map,
    );
    expect(out).toHaveLength(4);
    expect(out[1]).toMatchObject({ type: 'tool_call', toolCallId: 'c1' });
    expect(out[2]).toMatchObject({ type: 'tool_result', toolCallId: 'c1', text: 'done' });
    expect(out[3]).toMatchObject({ type: 'text', text: 'after' });
  });

  it('leaves tool_calls without a match alone', () => {
    const out = injectToolResultBlocks(
      [{ type: 'tool_call', name: 'x', toolCallId: 'missing' }],
      new Map(),
    );
    expect(out).toHaveLength(1);
  });

  it('returns the same blocks ref (no extra allocs) when map is empty', () => {
    const blocks = [{ type: 'text' as const, text: 'a' }];
    expect(injectToolResultBlocks(blocks, new Map())).toBe(blocks);
  });
});
