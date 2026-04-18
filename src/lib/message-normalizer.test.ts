import { describe, it, expect } from 'vitest';
import { normalizeMessage, extractToolMessagesFromBlocks } from './message-normalizer';

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
});
