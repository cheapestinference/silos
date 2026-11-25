// harnesses/claude-code/models.ts — Claude Code's model catalog source for
// ModelCatalog (../../model-catalog.ts): the SDK's supportedModels(). See
// model-catalog.ts's header for the verified cost and isolation.
import { tmpdir } from 'node:os'
import { envForProvider } from './env.js'
import { withClaudeExecutable } from './binary.js'
import type { FetchModels, ModelInfo } from '../../model-catalog.js'

// ---- real source (SDK) -----------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000

// Dynamic import of the SDK on purpose: this module is imported by tests
// (and buildServer via types) without ever loading the real SDK — only
// index.ts ends up executing this function. Same isolation criterion as the
// titler's one-shot: empty settingSources, hooks disabled, env cleaned of
// the machine's login (envForProvider(null)), and cwd under os.tmpdir();
// persistSession false ⇒ the ephemeral-noise rule isn't even needed (no
// JSONL is written at all — verified, see header).
export function fetchModelsWithSdk(): FetchModels {
  return async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const abort = new AbortController()
    // A prompt that never emits a message — the CLI's init still runs and
    // brings the catalog; the abort below releases it.
    async function* never(): AsyncGenerator<never> {
      await new Promise((resolve) => abort.signal.addEventListener('abort', () => resolve(undefined)))
    }
    // the `claude` on PATH, like every SDK query (sdk.ts) — checked before
    // the timer: no binary, no catalog fetch
    let opts: object
    try {
      opts = withClaudeExecutable({})
    } catch (err) {
      throw new Error(`could not fetch the model catalog from the SDK: ${err instanceof Error ? err.message : String(err)}`)
    }
    const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)
    const q = query({
      prompt: never() as never,
      options: {
        ...opts,
        cwd: tmpdir(),
        persistSession: false,
        settingSources: [],
        settings: { disableAllHooks: true, autoMemoryEnabled: false },
        abortController: abort,
        env: envForProvider(null) as never,
      },
    })
    try {
      const models = (await q.supportedModels()) as ModelInfo[]
      return models
    } catch (err) {
      throw new Error(`could not fetch the model catalog from the SDK: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
  }
}
