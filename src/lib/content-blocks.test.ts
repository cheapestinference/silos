import { describe, it, expect } from 'vitest';
import {
  normalizeContentToBlocks,
  extractTextFromBlocks,
  extractThinkingFromBlocks,
  extractToolCardsFromBlocks,
  extractImagesFromBlocks,
} from './content-blocks';

describe('normalizeContentToBlocks', () => {
  it('returns [] for null/undefined', () => {
    expect(normalizeContentToBlocks(null)).toEqual([]);
    expect(normalizeContentToBlocks(undefined)).toEqual([]);
  });
  it('returns [] for empty string', () => {
    expect(normalizeContentToBlocks('')).toEqual([]);
  });
  it('wraps a plain string as a single text block', () => {
    expect(normalizeContentToBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });
  it('passes through text blocks', () => {
    const raw = [{ type: 'text', text: 'hello' }];
    expect(normalizeContentToBlocks(raw)).toEqual([{ type: 'text', text: 'hello' }]);
  });
  it('skips empty text blocks', () => {
    const raw = [{ type: 'text', text: '' }, { type: 'text', text: 'x' }];
    expect(normalizeContentToBlocks(raw)).toEqual([{ type: 'text', text: 'x' }]);
  });
  it('converts OpenClaw toolCall blocks into canonical tool_call', () => {
    const raw = [
      { type: 'toolCall', name: 'cron', arguments: { action: 'add' }, id: 'c1' },
    ];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'tool_call', name: 'cron', args: { action: 'add' }, toolCallId: 'c1' },
    ]);
  });
  it('converts Anthropic tool_use blocks into canonical tool_call', () => {
    const raw = [
      { type: 'tool_use', name: 'shell', input: { cmd: 'ls' }, id: 't1' },
    ];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'tool_call', name: 'shell', args: { cmd: 'ls' }, toolCallId: 't1' },
    ]);
  });
  it('preserves tool_result text from nested content', () => {
    const raw = [
      {
        type: 'toolResult',
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'done' }],
      },
    ];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'tool_result', text: 'done', toolCallId: 'c1' },
    ]);
  });
  it('extracts thinking blocks verbatim', () => {
    const raw = [{ type: 'thinking', thinking: 'considering...' }];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'thinking', thinking: 'considering...' },
    ]);
  });
  it('resolves phase from textSignature JSON', () => {
    const raw = [
      {
        type: 'text',
        text: 'final',
        textSignature: JSON.stringify({ v: 1, phase: 'final_answer' }),
      },
    ];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'text', text: 'final', phase: 'final_answer' },
    ]);
  });
  it('ignores invalid textSignature JSON silently', () => {
    const raw = [{ type: 'text', text: 'x', textSignature: 'not json' }];
    expect(normalizeContentToBlocks(raw)).toEqual([{ type: 'text', text: 'x' }]);
  });
  it('converts base64 image blocks to canonical ImageSource', () => {
    const raw = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' },
      },
    ];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'AAA' } },
    ]);
  });
  it('converts OpenAI image_url blocks', () => {
    const raw = [{ type: 'image_url', image_url: { url: 'https://x.png' } }];
    expect(normalizeContentToBlocks(raw)).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://x.png' } },
    ]);
  });
  it('silently drops unknown block types', () => {
    const raw = [{ type: 'unknown' }, { type: 'text', text: 'keep' }];
    expect(normalizeContentToBlocks(raw)).toEqual([{ type: 'text', text: 'keep' }]);
  });
});

describe('extractTextFromBlocks', () => {
  it('joins text blocks with newlines', () => {
    expect(
      extractTextFromBlocks([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });
  it('skips non-text blocks', () => {
    expect(
      extractTextFromBlocks([
        { type: 'text', text: 'a' },
        { type: 'thinking', thinking: 't' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });
  it('filters by phase but keeps unphased blocks', () => {
    const blocks = [
      { type: 'text', text: 'x', phase: 'commentary' } as const,
      { type: 'text', text: 'y' } as const,
      { type: 'text', text: 'z', phase: 'final_answer' } as const,
    ];
    expect(extractTextFromBlocks(blocks, 'final_answer')).toBe('y\nz');
  });
});

describe('extractThinkingFromBlocks', () => {
  it('joins multiple thinking blocks with blank line', () => {
    expect(
      extractThinkingFromBlocks([
        { type: 'thinking', thinking: 'A' },
        { type: 'text', text: 'mid' },
        { type: 'thinking', thinking: 'B' },
      ]),
    ).toBe('A\n\nB');
  });
  it('returns empty string when no thinking blocks', () => {
    expect(
      extractThinkingFromBlocks([{ type: 'text', text: 'x' }]),
    ).toBe('');
  });
});

describe('extractToolCardsFromBlocks', () => {
  it('pairs tool_call with tool_result by toolCallId', () => {
    const cards = extractToolCardsFromBlocks([
      { type: 'tool_call', name: 'cron', args: { a: 1 }, toolCallId: 'c1' },
      { type: 'tool_result', text: 'ok', toolCallId: 'c1' },
    ]);
    expect(cards).toEqual([
      { name: 'cron', args: { a: 1 }, toolCallId: 'c1', resultText: 'ok' },
    ]);
  });
  it('leaves orphan calls without result', () => {
    const cards = extractToolCardsFromBlocks([
      { type: 'tool_call', name: 'shell', toolCallId: 'c1' },
    ]);
    expect(cards).toEqual([{ name: 'shell', toolCallId: 'c1' }]);
  });
  it('propagates isError', () => {
    const cards = extractToolCardsFromBlocks([
      { type: 'tool_call', name: 'x', toolCallId: 'c1' },
      { type: 'tool_result', text: 'boom', toolCallId: 'c1', isError: true },
    ]);
    expect(cards).toEqual([
      { name: 'x', toolCallId: 'c1', resultText: 'boom', isError: true },
    ]);
  });
});

describe('extractImagesFromBlocks', () => {
  it('returns URL source as-is', () => {
    expect(
      extractImagesFromBlocks([
        { type: 'image', source: { type: 'url', url: 'https://x.png' } },
      ]),
    ).toEqual(['https://x.png']);
  });
  it('wraps raw base64 into a data URL', () => {
    expect(
      extractImagesFromBlocks([
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAA' } },
      ]),
    ).toEqual(['data:image/png;base64,AAA']);
  });
  it('keeps pre-formed data URLs untouched', () => {
    expect(
      extractImagesFromBlocks([
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'data:image/png;base64,AAA' } },
      ]),
    ).toEqual(['data:image/png;base64,AAA']);
  });
});
