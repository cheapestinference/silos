import { describe, it, expect } from 'vitest';
import { exportChatToMarkdown } from './chat-export';
import type { ChatMessage } from '../types/openclaw';

function make(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: '',
    timestamp: 1_700_000_000_000,
    ...partial,
  };
}

describe('exportChatToMarkdown', () => {
  it('renders preamble + role sections', () => {
    const out = exportChatToMarkdown(
      [
        make({ id: 'a', role: 'user', content: 'hi', timestamp: 1_700_000_000_000 }),
        make({ id: 'b', role: 'assistant', content: 'hello', timestamp: 1_700_000_001_000 }),
      ],
      { sessionKey: 'agent:x:a' },
    );
    expect(out).toContain('# Silos chat export');
    expect(out).toContain('**Session:** `agent:x:a`');
    expect(out).toContain('## You');
    expect(out).toContain('## Assistant');
    expect(out).toContain('hi');
    expect(out).toContain('hello');
  });
  it('skips messages flagged as deleted', () => {
    const out = exportChatToMarkdown(
      [
        make({ id: 'a', content: 'keep' }),
        make({ id: 'b', content: 'drop' }),
      ],
      { sessionKey: 's', isDeleted: (id) => id === 'b' },
    );
    expect(out).toContain('keep');
    expect(out).not.toContain('drop');
  });
  it('skips inter-session events', () => {
    const out = exportChatToMarkdown(
      [
        make({ id: 'a', content: 'normal' }),
        make({
          id: 'b',
          content: 'Subagent:…',
          meta: { kind: 'inter_session', task: 'x' },
        }),
      ],
      { sessionKey: 's' },
    );
    expect(out).toContain('normal');
    expect(out).not.toContain('Subagent:');
  });
  it('renders contentBlocks (text + tool_call + tool_result)', () => {
    const out = exportChatToMarkdown(
      [
        make({
          id: 'a',
          role: 'assistant',
          contentBlocks: [
            { type: 'text', text: 'Calling a tool.' },
            { type: 'tool_call', name: 'cron', args: { action: 'add' } },
            { type: 'tool_result', text: 'ok', toolCallId: 'c1' },
          ],
        }),
      ],
      { sessionKey: 's' },
    );
    expect(out).toContain('Calling a tool.');
    expect(out).toContain('**Tool call:** `cron`');
    expect(out).toContain('"action": "add"');
    expect(out).toContain('**Tool result:**');
    expect(out).toContain('ok');
  });
  it('renders thinking as blockquote', () => {
    const out = exportChatToMarkdown(
      [
        make({
          id: 'a',
          role: 'assistant',
          contentBlocks: [{ type: 'thinking', thinking: 'line1\nline2' }],
        }),
      ],
      { sessionKey: 's' },
    );
    expect(out).toContain('> _Reasoning:_');
    expect(out).toContain('> line1');
    expect(out).toContain('> line2');
  });
});
