// harnesses/opencode/models.ts — OpenCode's model catalog source for
// ModelCatalog (../../model-catalog.ts): `opencode models`.
import { defaultRun, type RunFn } from '../../harness-run.js'
import type { ModelInfo } from '../../model-catalog.js'

// ---- real source (OpenCode) ------------------------------------------------

const OPENCODE_MODELS_MS = 30_000
const OPENCODE_MODEL_LINE = /^([a-z0-9][a-z0-9-]*)\/(\S+)$/

/** `opencode models` prints one `provider/model` per line (verified 26-10,
 *  1.14.22) → `{ value: 'provider/model', displayName: model, description:
 *  provider }`. Anything else on the output (warnings, colour) is skipped;
 *  duplicates once. */
export async function fetchOpenCodeModels(run: RunFn = defaultRun, bin: string = process.env.SILOS_OPENCODE_BIN || 'opencode'): Promise<ModelInfo[]> {
  const r = await run(bin, ['models'], { timeoutMs: OPENCODE_MODELS_MS })
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const raw of r.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n')) {
    const line = raw.trim()
    const m = OPENCODE_MODEL_LINE.exec(line)
    if (!m || seen.has(line)) continue
    seen.add(line)
    out.push({ value: line, displayName: m[2]!, description: m[1]! })
  }
  return out
}
