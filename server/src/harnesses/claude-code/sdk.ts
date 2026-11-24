// harnesses/claude-code/sdk.ts — the one place the Claude Agent SDK's query()
// is bound to Silos' QueryFn. Every query runs the `claude` on PATH — the
// same binary the consoles launch (binary.ts withClaudeExecutable: never two
// Claude Code versions); the SDK's own bundled binaries are never used.
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from './sdk-types.js'
import { withClaudeExecutable } from './binary.js'

// Explicit adapter: the SDK boundary is typed on the return (iterator +
// interrupt + the servers' status, turn-status.ts) vs the input (options)
export const sdkQueryFn: QueryFn = (args) => {
  const handle = query({ prompt: args.prompt as Parameters<typeof query>[0]['prompt'], options: withClaudeExecutable((args.options ?? {}) as object) as never })
  return {
    [Symbol.asyncIterator]: () => handle[Symbol.asyncIterator](),
    interrupt: () => handle.interrupt(),
    mcpServerStatus: () => handle.mcpServerStatus(),
    initializationResult: () => handle.initializationResult(),
    close: () => handle.close(),
  }
}
