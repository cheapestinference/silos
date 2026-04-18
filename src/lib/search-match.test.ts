import { describe, it, expect } from 'vitest';
import { matchMessage, highlightSnippet } from './search-match';
import type { ChatMessage } from '../types/openclaw';

function make(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: '',
    timestamp: 0,
    ...partial,
  };
}

describe('matchMessage', () => {
  it('returns false for empty query', () => {
    expect(matchMessage(make({ content: 'hello' }), '')).toBe(false);
  });
  it('substring matches content case-insensitively', () => {
    expect(matchMessage(make({ content: 'Hello World' }), 'WORLD')).toBe(true);
  });
  it('does not match when absent', () => {
    expect(matchMessage(make({ content: 'Hello' }), 'xyz')).toBe(false);
  });
  it('matches text block in contentBlocks', () => {
    expect(
      matchMessage(
        make({ content: '', contentBlocks: [{ type: 'text', text: 'foo bar' }] }),
        'bar',
      ),
    ).toBe(true);
  });
  it('matches tool name via contentBlocks', () => {
    expect(
      matchMessage(
        make({ contentBlocks: [{ type: 'tool_call', name: 'cron' }] }),
        'cron',
      ),
    ).toBe(true);
  });
  it('matches thinking block', () => {
    expect(
      matchMessage(
        make({ contentBlocks: [{ type: 'thinking', thinking: 'considering X' }] }),
        'considering',
      ),
    ).toBe(true);
  });
  it('matches top-level toolName', () => {
    expect(matchMessage(make({ role: 'tool', toolName: 'bash' }), 'bash')).toBe(true);
  });
});

describe('highlightSnippet', () => {
  it('returns slice for empty query', () => {
    expect(highlightSnippet('abcdefg', '')).toBe('abcdefg');
  });
  it('returns context window around match with ellipses', () => {
    const s = 'a'.repeat(100) + 'FIND' + 'b'.repeat(100);
    const out = highlightSnippet(s, 'find', 10);
    expect(out).toContain('FIND');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
  it('no leading ellipsis when near start', () => {
    const out = highlightSnippet('FIND rest of text', 'find', 10);
    expect(out.startsWith('…')).toBe(false);
    expect(out).toContain('FIND');
  });
});
