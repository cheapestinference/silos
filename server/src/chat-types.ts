// chat-types.ts — the engine-neutral chat stream (ChatEvent). The Claude
// Agent SDK's message and query types live in harnesses/claude-code/sdk-types.ts.
// What flows to the UI (over WS and through ChatService's generator)
export type ChatEvent =
  // Cabin: model/permissionMode are the ECHO of the SDK's init (the
  // effective ground truth of the process that started) — the UI compares
  // them against what was requested. slashCommands: the REAL slash commands
  // the init announced for this session (terminal-only ones already
  // stripped) — the UI offers them in the '/' menu. Absent = an empty list
  // (or an engine that announces none) → the UI falls back to skills behavior.
  | { ev: 'chat-init'; turnId: string; folder: string; sessionId: string; model?: string; permissionMode?: string; slashCommands?: string[] }
  | { ev: 'chat-delta'; turnId: string; text: string }
  | { ev: 'chat-thinking'; turnId: string; text: string }
  | { ev: 'chat-tool'; turnId: string; name: string; input?: string }
  | { ev: 'chat-usage'; turnId: string; outputTokens: number; contextTokens?: number }
  // priced: whether the provider the turn ran on prices its turns (an API
  // key — providers-store providerPrices); set by ChatService.send, absent
  // when the engine never resolved a provider
  | { ev: 'chat-done'; turnId: string; subtype: string; costUsd: number | null; priced?: boolean }
  | { ev: 'chat-error'; turnId: string; error: string }
  // Resident + 5h/7d bar: normalized from the SDK's rate-limit event
  // (harnesses/claude-code/sdk-types.ts) — resetsAt is
  // always ISO 8601 (the SDK gives it in epoch ms).
  | { ev: 'chat-ratelimit'; turnId: string; status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: string; kind?: string; utilization?: number }
