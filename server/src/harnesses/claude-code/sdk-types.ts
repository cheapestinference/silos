// harnesses/claude-code/sdk-types.ts — minimal SDK surface we use, compatible with fakes.
// Cabin: the stream's init carries the process's EFFECTIVE model and
// permissionMode (sdk.d.ts SDKSystemMessage) — this is the system's ground
// truth that the UI compares against what was requested (an honest echo).
// Slash menu: the init also announces `slash_commands` (the REAL commands
// this session exposes: /clear, /compact, /model, ... plus the custom ones
// from .claude/commands) and `terminal_slash_commands` (the subset tied to
// the terminal — exit/statusline — that a remote/web UI must HIDE from the
// menu).
export interface SdkInitMessage {
  type: 'system'
  subtype: 'init'
  session_id: string
  model?: string
  permissionMode?: string
  slash_commands?: string[]
  terminal_slash_commands?: string[]
}
export interface SdkStreamEvent {
  type: 'stream_event'
  event: {
    type: string // 'content_block_start' | 'content_block_delta' | 'message_delta' | ...
    content_block?: { type: string; name?: string; input?: unknown }
    delta?: { type: string; text?: string; partial_json?: string; thinking?: string }
    usage?: { output_tokens?: number }
  }
}
export interface SdkResultMessage {
  type: 'result'
  subtype: string
  session_id?: string
  total_cost_usd?: number
  result?: string
}
export interface SdkAssistantMessage {
  type: 'assistant'
  message?: unknown
}
// Resident: message the SDK emits when the claude.ai account's rate limit
// info changes (see node_modules/@anthropic-ai/claude-agent-sdk sdk.d.ts
// SDKRateLimitEvent/SDKRateLimitInfo) — resetsAt arrives in epoch ms.
export interface SdkRateLimitEvent {
  type: 'rate_limit_event'
  rate_limit_info: {
    status: 'allowed' | 'allowed_warning' | 'rejected'
    resetsAt?: number
    rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'
    utilization?: number
  }
}
export type SdkMessage = SdkInitMessage | SdkStreamEvent | SdkResultMessage | SdkAssistantMessage | SdkRateLimitEvent | { type: string; [k: string]: unknown }

export interface SdkQueryHandle extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>
  /** the engine's status of every MCP server the process knows
   *  (sdk.d.ts Query.mcpServerStatus) — optional: a fake or an older SDK may
   *  not have it (turn-status.ts then records nothing) */
  mcpServerStatus?(): Promise<unknown[]>
  /** the first-connect answer (sdk.d.ts Query.initializationResult): the
   *  account the process is signed in as — the check names its login by it */
  initializationResult?(): Promise<unknown>
  /** ends the process (sdk.d.ts Query.close): the check closes it on its
   *  answer and at its bound */
  close?(): void
}
export interface QueryArgs {
  /** a turn's prompt; the check hands a stream that never yields — no
   *  prompt is ever sent (loads/check.ts) */
  prompt: string | AsyncIterable<never>
  options: Record<string, unknown>
}
export type QueryFn = (args: QueryArgs) => SdkQueryHandle
