// src/lib/chat-export.ts
//
// Serialize ChatMessage[] to markdown for copy/download. Renders each
// message as a role-titled section with ISO-ish timestamp and content.
// Deleted messages are skipped via an optional isDeleted callback.
// Inter-session events (meta.kind === 'inter_session') are skipped —
// they are runtime context, not user-authored.

import type { ChatMessage, ContentBlock } from '../types/openclaw';

export interface ExportOptions {
  sessionKey: string;
  isDeleted?: (messageId: string) => boolean;
}

function fmtRole(role: ChatMessage['role']): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Assistant';
  if (role === 'tool') return 'Tool';
  if (role === 'system') return 'System';
  return role;
}

function fmtTime(ts: number | undefined): string {
  if (!ts) return '';
  try {
    return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return '';
  }
}

function renderBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text.trim()) parts.push(b.text.trim());
      continue;
    }
    if (b.type === 'thinking') {
      if (b.thinking.trim()) {
        parts.push('> _Reasoning:_');
        parts.push(
          b.thinking
            .trim()
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        );
      }
      continue;
    }
    if (b.type === 'tool_call') {
      const args = b.args !== undefined ? JSON.stringify(b.args, null, 2) : '';
      parts.push(`**Tool call:** \`${b.name}\``);
      if (args) {
        parts.push('```json');
        parts.push(args);
        parts.push('```');
      }
      continue;
    }
    if (b.type === 'tool_result') {
      parts.push(b.isError ? '**Tool error:**' : '**Tool result:**');
      parts.push('```');
      parts.push(b.text);
      parts.push('```');
      continue;
    }
    if (b.type === 'image') {
      const src =
        b.source.type === 'url'
          ? b.source.url
          : `data:${b.source.mediaType};base64,${b.source.data}`;
      parts.push(`![image](${src})`);
      continue;
    }
  }
  return parts.join('\n\n');
}

export function exportChatToMarkdown(messages: ChatMessage[], options: ExportOptions): string {
  const kept = messages.filter((m) => {
    if (options.isDeleted?.(m.id)) return false;
    if (m.meta?.kind === 'inter_session') return false;
    return true;
  });

  const preamble = [
    `# Silos chat export`,
    ``,
    `- **Session:** \`${options.sessionKey}\``,
    `- **Exported:** ${fmtTime(Date.now())}`,
    `- **Messages:** ${kept.length}`,
    ``,
    `---`,
    ``,
  ].join('\n');

  const sections: string[] = [preamble];
  for (const m of kept) {
    const heading = `## ${fmtRole(m.role)}${fmtTime(m.timestamp) ? ` — ${fmtTime(m.timestamp)}` : ''}`;
    const body =
      m.contentBlocks && m.contentBlocks.length > 0
        ? renderBlocks(m.contentBlocks)
        : (m.content || '').trim();
    sections.push(heading);
    if (body) sections.push(body);
    sections.push('');
  }
  return sections.join('\n');
}
