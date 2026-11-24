// harnesses/opencode/tui-client — hands a prompt to a running OpenCode TUI
// through its own HTTP server (`opencode --port <p> --hostname 127.0.0.1`,
// basic auth `silos:<console record's serverPassword>`), instead of tmux
// keystrokes. Two calls, in order — the TUI's own gesture: type, then Enter.
//
// Bodies as OpenCode 1.14.22 declares them
// (@opencode-ai/sdk dist/v2/gen/types.gen.d.ts):
//   TuiAppendPromptData  { body?: { text: string }; url: "/tui/append-prompt" }
//   TuiSubmitPromptData  { body?: never;            url: "/tui/submit-prompt" }
//
// The password and the Authorization header never reach a log or an error
// message: a failure names the step and the status only.

export class TuiSendError extends Error {}

export interface AppendAndSubmitInput {
  port: number
  password: string
  text: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function appendAndSubmit({ port, password, text, fetchImpl = fetch, timeoutMs = 5_000 }: AppendAndSubmitInput): Promise<void> {
  const authHeader: Record<string, string> = { Authorization: `Basic ${Buffer.from(`silos:${password}`).toString('base64')}` }
  const post = async (path: string, body?: unknown): Promise<void> => {
    let res: Response
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { ...authHeader, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new TuiSendError(`the OpenCode console did not answer ${path}`)
    }
    // drain the body so the socket is released
    await res.text().catch(() => '')
    if (!res.ok) throw new TuiSendError(`the OpenCode console refused ${path} (${res.status})`)
  }
  await post('/tui/append-prompt', { text })
  await post('/tui/submit-prompt')
}

// ---- the TUI's model picker -------------------------------------------------
// A RESUMED session restores agent AND model from its last user message when
// the TUI opens it (packages/tui/src/component/prompt/index.tsx, 1.19.4):
// only `--agent` survives, `--model` and the session's stored model do not
// (live test 27-10: relaunch with --model, or POST /session/{id}/model 3 s
// after launch — the header stayed on the last message's model). The TUI's
// own gesture is what remains: `tui.command.execute` `model.list` through
// /tui/publish opens its model picker on screen, and the owner picks there.

export interface OpenModelPickerInput {
  port: number
  password: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function openModelPicker({ port, password, fetchImpl = fetch, timeoutMs = 5_000 }: OpenModelPickerInput): Promise<void> {
  const authHeader: Record<string, string> = { Authorization: `Basic ${Buffer.from(`silos:${password}`).toString('base64')}` }
  let res: Response
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/tui/publish`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tui.command.execute', properties: { command: 'model.list' } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new TuiSendError('the OpenCode console did not answer /tui/publish')
  }
  await res.text().catch(() => '')
  if (!res.ok) throw new TuiSendError(`the OpenCode console refused /tui/publish (${res.status})`)
}

// ---- the model ON SCREEN ----------------------------------------------------
// What the TUI will send the next prompt with is its own selection, and no
// endpoint reads it back. Two things are true (1.19.4, source + live tests
// 27-10): the header shows it ("Build auto · <model name> <provider name>"),
// and the TUI's own `model.cycle_recent` command walks its recent list,
// where `--model` at launch sits first. So the pin is reached the way the
// owner would reach it — cycle, look at the screen, stop when it reads the
// pin — and verified by the screen, never assumed.

export interface TuiNames {
  provider: Map<string, string>
  model: Map<string, string>
} // providerID → name · "providerID/modelID" → name

/** GET /config/providers → the display names the header uses. */
export async function tuiNames({
  port,
  password,
  fetchImpl = fetch,
  timeoutMs = 5_000,
}: {
  port: number
  password: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<TuiNames> {
  const authHeader: Record<string, string> = { Authorization: `Basic ${Buffer.from(`silos:${password}`).toString('base64')}` }
  let res: Response
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/config/providers`, { headers: authHeader, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    throw new TuiSendError('the OpenCode console did not answer /config/providers')
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new TuiSendError(`the OpenCode console refused /config/providers (${res.status})`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new TuiSendError('the OpenCode console answered /config/providers with no JSON')
  }
  const list = (raw as { providers?: unknown })?.providers
  const out: TuiNames = { provider: new Map(), model: new Map() }
  for (const p of Array.isArray(list) ? list : []) {
    const id = (p as { id?: unknown }).id,
      name = (p as { name?: unknown }).name
    if (typeof id !== 'string') continue
    out.provider.set(id, typeof name === 'string' ? name : id)
    const models = (p as { models?: unknown }).models
    if (models && typeof models === 'object') {
      for (const [mid, m] of Object.entries(models as Record<string, unknown>)) {
        const mname = (m as { name?: unknown } | null)?.name
        out.model.set(`${id}/${mid}`, typeof mname === 'string' ? mname : mid)
      }
    }
  }
  return out
}

/** Whether a screen capture shows the header on this model and provider. */
export function screenShowsModel(screen: string, modelName: string, providerName: string): boolean {
  return screen.includes(`· ${modelName} ${providerName}`)
}

export interface SettleModelInput {
  port: number
  password: string
  providerID: string
  modelID: string
  /** the console's screen, read fresh on each call (terminal-service consoleScreen) */
  screen: () => string | Promise<string>
  fetchImpl?: typeof fetch
  /** at most this many recent-cycle steps (the recent list is short) */
  maxSteps?: number
  /** how long the TUI gets to repaint after a step */
  settleMs?: number
}

export type SettleModelResult = 'settled' | 'unreachable' | 'unknown-model'

/** Cycle the TUI's recent models until the screen shows the pin. `unknown-model`:
 *  the TUI does not list that provider/model (the pin cannot be shown by this
 *  process — a relaunch with `--model` adds it to the recent list first). */
export async function settleModelOnScreen({
  port,
  password,
  providerID,
  modelID,
  screen,
  fetchImpl = fetch,
  maxSteps = 12,
  settleMs = 350,
}: SettleModelInput): Promise<SettleModelResult> {
  const names = await tuiNames({ port, password, fetchImpl })
  const modelName = names.model.get(`${providerID}/${modelID}`)
  const providerName = names.provider.get(providerID)
  if (modelName === undefined || providerName === undefined) return 'unknown-model'
  const shows = async (): Promise<boolean> => screenShowsModel(await screen(), modelName, providerName)
  if (await shows()) return 'settled'
  const authHeader: Record<string, string> = { Authorization: `Basic ${Buffer.from(`silos:${password}`).toString('base64')}` }
  for (let i = 0; i < maxSteps; i++) {
    let res: Response
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/tui/publish`, {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tui.command.execute', properties: { command: 'model.cycle_recent' } }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      throw new TuiSendError('the OpenCode console did not answer /tui/publish')
    }
    await res.text().catch(() => '')
    if (!res.ok) throw new TuiSendError(`the OpenCode console refused /tui/publish (${res.status})`)
    await new Promise((r) => setTimeout(r, settleMs))
    if (await shows()) return 'settled'
  }
  return 'unreachable'
}

/** Wait until the TUI's server knows the session (it answers only once up). */
export async function waitForSession({
  port,
  password,
  sessionId,
  fetchImpl = fetch,
  readyTimeoutMs = 30_000,
  pollMs = 500,
}: {
  port: number
  password: string
  sessionId: string
  fetchImpl?: typeof fetch
  readyTimeoutMs?: number
  pollMs?: number
}): Promise<void> {
  const authHeader: Record<string, string> = { Authorization: `Basic ${Buffer.from(`silos:${password}`).toString('base64')}` }
  const base = `http://127.0.0.1:${port}/api/session/${encodeURIComponent(sessionId)}`
  const deadline = Date.now() + readyTimeoutMs
  for (;;) {
    try {
      const res = await fetchImpl(base, { headers: authHeader, signal: AbortSignal.timeout(2_000) })
      await res.text().catch(() => '')
      if (res.ok) return
      if (res.status === 401 || res.status === 403) throw new TuiSendError(`the OpenCode console refused the session read (${res.status})`)
    } catch (err) {
      if (err instanceof TuiSendError) throw err
    }
    if (Date.now() >= deadline) throw new TuiSendError('the OpenCode console did not come up in time')
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

// ---- the session's model ----------------------------------------------------
// A RESUMED OpenCode session keeps the model it last ran on: `--model` and
// the config's `model` only name a NEW session's model (verified on 1.19.4,
// 27-10 — the TUI showed GLM-5.1 whatever the flag said): the TUI restores
// the last user message's model on open, and neither --model nor the
// session's stored model moves its selection (7ad16785). The switch Silos
// uses is the TUI's own gesture — settleModelOnScreen above cycles its
// recent models and verifies each step on the console's screen.

/** `silos-ci/mimo-v2.6-flash` → provider `silos-ci`, model `mimo-v2.6-flash`
 *  (a model id may hold slashes of its own: `openrouter/anthropic/claude-x`
 *  → provider `openrouter`, model `anthropic/claude-x`). null: no slash. */
export function splitModelRef(ref: string): { providerID: string; modelID: string } | null {
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return null
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}
