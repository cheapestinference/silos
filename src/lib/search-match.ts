// src/lib/search-match.ts
//
// Pure helpers for in-chat search. Case-insensitive substring match on the
// message's rendered text view (message.content for now; MessageContent
// migration in a later phase).

import type { ChatMessage } from '../types/openclaw';

export function matchMessage(message: ChatMessage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const hay = (message.content || '').toLowerCase();
  if (hay.includes(q)) return true;
  // Also search through contentBlocks text + tool names.
  if (message.contentBlocks) {
    for (const b of message.contentBlocks) {
      if (b.type === 'text' && b.text.toLowerCase().includes(q)) return true;
      if (b.type === 'thinking' && b.thinking.toLowerCase().includes(q)) return true;
      if (b.type === 'tool_call' && b.name.toLowerCase().includes(q)) return true;
      if (b.type === 'tool_result' && b.text.toLowerCase().includes(q)) return true;
    }
  }
  if (message.toolName && message.toolName.toLowerCase().includes(q)) return true;
  return false;
}

export function highlightSnippet(text: string, query: string, contextChars = 40): string {
  const q = query.trim().toLowerCase();
  if (!q) return text.slice(0, 80);
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return text.slice(0, 80);
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + q.length + contextChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}
