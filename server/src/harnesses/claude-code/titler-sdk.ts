// harnesses/claude-code/titler-sdk.ts — the titler's real generator: a
// one-shot Claude Agent SDK turn (the Titler itself stays engine-neutral in
// ../../titler.ts).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envForProvider } from './env.js'
import type { QueryFn } from './sdk-types.js'
import { TITLER_TMP_PREFIX, type GenerateTitle } from '../../titler.js'

// ---- real generator (SDK) ------------------------------------------------

// Minimal one-shot against the SDK — the same machine login as ChatService
// (envForProvider(null) = the usual clean env), but WITHOUT tools, one
// turn, and a NEUTRAL cwd under os.tmpdir(): the helper session the SDK
// persists lands in a munged folder hanging off the tmpdir, and the
// ephemeral-noise rule (ephemeral.ts, verified: ClaudeReader.shouldSkip +
// watcher) hides it from the index. Never use an agent's folder — the
// helper would show up as a session of the project.
export const TITLER_MODEL = 'claude-haiku-4-5-20251001'

export function generateTitleWithSdk(queryFn: QueryFn): GenerateTitle {
  return async ({ excerpt, siblings }) => {
    const cwd = mkdtempSync(join(tmpdir(), TITLER_TMP_PREFIX))
    try {
      return await generateWithCwd(queryFn, cwd, excerpt, siblings)
    } finally {
      // Nothing else cleans up the cwd's tmpdir (the helper JSONL lives
      // under ~/.claude/projects, not here) — removed when done, best
      // effort: a cleanup failure never breaks generation.
      try {
        rmSync(cwd, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
}

async function generateWithCwd(queryFn: QueryFn, cwd: string, excerpt: string, siblings: string[]): Promise<string> {
  const avoid = siblings.length > 0 ? `\nIt must be distinct from these titles already in use: ${siblings.map((s) => `"${s}"`).join(', ')}.` : ''
  const prompt =
    'Below is the beginning of a conversation. Reply with ONLY a short channel-style topic slug for it: ' +
    'lowercase, words joined by hyphens (kebab-case), in the same language as the conversation. ' +
    'Use the FEWEST words that still clearly reference what the conversation is about — ideally one, ' +
    'but 2–4 when one word would be too vague. Examples: "invoice-payments", "deploy-vps", "home-chores". ' +
    `No "#", no quotes, no spaces, no trailing punctuation, no explanation — just the slug.${avoid}\n\n---\n${excerpt}`
  const handle = queryFn({
    prompt,
    options: {
      cwd,
      model: TITLER_MODEL,
      maxTurns: 1,
      allowedTools: [], // pure one-shot: no tools
      settingSources: [], // no user settings/hooks — this isn't an owner session
      // auto memory loads regardless of settingSources (SDK docs): off —
      // a title never needs the folder's memory index in its prompt
      settings: { disableAllHooks: true, autoMemoryEnabled: false },
      systemPrompt: 'You name conversations with short channel-style titles. Output only the title, nothing else.',
      env: envForProvider(null), // the machine's login, clean env (same criterion as ChatService's default)
    },
  })
  let assistantText = ''
  let resultText: string | undefined
  for await (const m of handle) {
    if (m.type === 'result') {
      const r = m as { result?: unknown }
      if (typeof r.result === 'string') resultText = r.result
    } else if (m.type === 'assistant') {
      const content = (m as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; text?: string }>) {
          if (block.type === 'text' && typeof block.text === 'string') assistantText += block.text
        }
      }
    }
  }
  return (resultText ?? assistantText).trim()
}
