import type { AgentConfiguration } from '../types/openclaw';

/**
 * Translate DM session keys to the gateway's internal format.
 * "dm-{agentId}" → "agent:{agentId}:dm-operator"
 */
export function resolveSessionKey(key: string): string {
  if (key.startsWith('dm-')) {
    const agentId = key.replace(/^dm-/, '');
    return `agent:${agentId}:dm-operator`;
  }
  return key;
}

/**
 * Strip OpenClaw inbound metadata blocks from user message content.
 * The gateway prepends blocks like "Conversation info (untrusted metadata): ```json ... ```"
 * to user messages when storing them. We strip these for display in the dashboard.
 */
export function stripInboundMeta(content: unknown): string {
  if (!content) return '';

  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // OpenAI format: array of content parts
    text = content
      .map((item: unknown) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const i = item as Record<string, unknown>;
          if (typeof i.text === 'string') return i.text;
        }
        return '';
      })
      .join('\n');
  } else {
    text = String(content);
  }

  // Remove metadata blocks: "Label (untrusted metadata):\n```json\n...\n```"
  text = text.replace(/(?:Conversation info|Sender|Forwarded message context|Thread starter|Replied message|Chat history since last reply)\s*\(untrusted[^)]*\):\s*```json\n[\s\S]*?```\n*/g, '');

  // Remove inbound context system blocks if present
  text = text.replace(/## Inbound Context \(trusted metadata\)[\s\S]*?```\n*/g, '');

  // Remove OpenClaw runtime context blocks (subagent completion events, internal task results).
  text = text.replace(/OpenClaw runtime context \(internal\):[\s\S]*/g, '');

  // Remove "Untrusted context (metadata, ...)" trailing blocks
  text = text.replace(/Untrusted context \(metadata[^)]*\):[\s\S]*/g, '');

  // Remove date/time prefix like "[Wed 2026-02-25 14:30 GMT+1]" that gateway adds
  text = text.replace(/^\[(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+[^\]]*\]\s*/i, '');

  return text.trim();
}

/** Default empty agent configuration for new/missing configs */
export function defaultAgentConfig(agentId: string): AgentConfiguration {
  return {
    agentId,
    systemPrompt: '',
    contextMemory: '',
    knowledgeFiles: [],
    settings: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Build auth headers for workspace HTTP API calls */
export function workspaceHeaders(authToken: string | null, includeContentType = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) headers['Content-Type'] = 'application/json';
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  return headers;
}
