// cockpit.ts — cabin selectors: cascade
// `agent default → conversation override → turn override` for EXACTLY
// six controls: model · effort · permissionMode · fastMode · provider
// (which Claude account or key the turn runs on; agent level =
// agent.provider) · outputStyle (the voice the engine answers in — agent
// level = agent.outputStyle; only an engine whose caps.outputStyles says so
// takes it, the routes refuse it elsewhere). Nothing else from the
// inventory is covered.
//
// Hard rules (closed decision):
// - The DEFAULT permission mode stays bypassPermissions — the selector is
//   an opt-in override per conversation/turn, never a change to the default.
// - Dropping to 'default'/'dontAsk' would require a permissions UI
//   (canUseTool) that does NOT exist today ⇒ only bypass ↔ plan ↔
//   acceptEdits are valid values (see the nuance in the inventory table,
//   permissionMode row).
// - fastMode has no field in Options and no --fast flag (verified against
//   sdk.d.ts 0.3.233): it travels via `settings: { fastMode: true }` —
//   ChatService applies it, this module only resolves the boolean.

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

// SAFE subset of the SDK's PermissionMode (see the rule above).
export const PERMISSION_MODES = ['bypassPermissions', 'plan', 'acceptEdits'] as const
export type CockpitPermissionMode = (typeof PERMISSION_MODES)[number]

// A set of overrides — the same type serves the conversation level
// (persisted in conversation-prefs.json) and the turn level (travels in the
// POST /chat body). All fields optional: absent = "no opinion, fall through
// to the next level of the cascade".
export interface CockpitOverrides {
  model?: string
  effort?: EffortLevel
  permissionMode?: CockpitPermissionMode
  fastMode?: boolean
  provider?: string
  outputStyle?: string
}

// What comes out of the cascade: the EFFECTIVE values for the turn about to
// start. model stays undefined when nobody opines (= the CLI's default,
// honestly: we never invent an id); permissionMode always resolves
// (defaults to bypass).
export interface CockpitEffective {
  model?: string
  effort?: EffortLevel
  permissionMode: CockpitPermissionMode
  fastMode: boolean
  // a provider id ('default' · 'account:<name>' · a providers.json id);
  // undefined = nobody opined = the agent's own resolution.
  provider?: string
  // the style's exact name ('default', 'Explanatory', a custom style's
  // name); undefined = nobody opined = the operator's own config, untouched.
  outputStyle?: string
}

const FIELDS = ['model', 'effort', 'permissionMode', 'fastMode', 'provider', 'outputStyle'] as const
const MODEL_MAX_CHARS = 120
// provider ids are slugs with a namespace colon — never a path (an
// 'account:../x' would be resolved by ProvidersStore anyway, which checks
// the name, but it is rejected here first).
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/
// an output style is a NAME (a built-in, or a custom style's frontmatter
// name — spaces allowed), never a path. Whether that name exists for the
// conversation's engine and folder is the route's check (it knows the cwd).
export const OUTPUT_STYLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:()-]{0,63}$/

// Validation shared by the POST /chat body (turn overrides) and the
// conversation prefs PATCH. Throws with a plain English message (the server
// forwards it as 400 as-is — same pattern as validateProjects/agentErrors).
// `allowNull`: the PATCH accepts `null` on a field to DELETE that
// conversation override (fall back to the agent's default); in a turn's
// body a null means nothing and is rejected.
export function validateOverrides(v: unknown, opts?: { allowNull?: boolean }): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('overrides must be an object')
  }
  const o = v as Record<string, unknown>
  for (const key of Object.keys(o)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      throw new Error(`unknown field in overrides: ${key}`)
    }
  }
  const allowNull = opts?.allowNull === true
  const out: Record<string, unknown> = {}
  for (const field of FIELDS) {
    if (!(field in o)) continue
    const value = o[field]
    if (value === null) {
      if (!allowNull) throw new Error(`overrides.${field} does not accept null`)
      out[field] = null
      continue
    }
    switch (field) {
      case 'model':
        if (typeof value !== 'string' || value.trim() === '') throw new Error('overrides.model must be a non-empty string')
        if (value.length > MODEL_MAX_CHARS) throw new Error('overrides.model too long')
        out.model = value.trim() // ' sonnet ' must not reach the CLI with surrounding spaces
        break
      case 'effort':
        if (typeof value !== 'string' || !(EFFORT_LEVELS as readonly string[]).includes(value)) {
          throw new Error(`overrides.effort must be one of: ${EFFORT_LEVELS.join(', ')}`)
        }
        out.effort = value
        break
      case 'permissionMode':
        if (typeof value !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(value)) {
          // 'default'/'dontAsk' are rejected ON PURPOSE — without a
          // permissions UI they'd be a hung turn or a silently denied one
          // (see header).
          throw new Error(`overrides.permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`)
        }
        out.permissionMode = value
        break
      case 'fastMode':
        if (typeof value !== 'boolean') throw new Error('overrides.fastMode must be a boolean')
        out.fastMode = value
        break
      case 'provider': {
        if (typeof value !== 'string') throw new Error('overrides.provider must be a provider id')
        const id = value.trim()
        if (!PROVIDER_ID_RE.test(id)) throw new Error('overrides.provider must be a provider id (letters, digits, : _ -; max 80)')
        out.provider = id
        break
      }
      case 'outputStyle': {
        if (typeof value !== 'string') throw new Error('overrides.outputStyle must be a style name')
        const name = value.trim()
        if (!OUTPUT_STYLE_ID_RE.test(name)) throw new Error('overrides.outputStyle must be a style name (letters, digits, spaces, _ . : ( ) -; max 64)')
        out.outputStyle = name
        break
      }
    }
  }
  return out
}

// Null-free variant, already typed — for the turn level (POST /chat body).
export function validateTurnOverrides(v: unknown): CockpitOverrides {
  return validateOverrides(v) as CockpitOverrides
}

// The cascade: turn wins over conversation, conversation wins over the
// agent's default. Field by field, never the whole object — a turn that
// only opines on effort inherits the conversation's (or agent's) model
// untouched.
export function resolveCascade(
  agent: { model?: string; provider?: string; outputStyle?: string },
  conversation: CockpitOverrides | null | undefined,
  turn: CockpitOverrides | null | undefined,
): CockpitEffective {
  const conv = conversation ?? {}
  const t = turn ?? {}
  const provider = t.provider ?? conv.provider ?? agent.provider
  // '' at the agent level = cleared (the editor's empty choice)
  const outputStyle = t.outputStyle ?? conv.outputStyle ?? (agent.outputStyle ? agent.outputStyle : undefined)
  return {
    ...((t.model ?? conv.model ?? agent.model) ? { model: t.model ?? conv.model ?? agent.model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(outputStyle !== undefined ? { outputStyle } : {}),
    ...((t.effort ?? conv.effort) ? { effort: (t.effort ?? conv.effort) as EffortLevel } : {}),
    // There's no agent-level default for permissionMode today (bypass is a
    // global decision) — the agent level of this control IS the bypass constant.
    permissionMode: t.permissionMode ?? conv.permissionMode ?? 'bypassPermissions',
    fastMode: t.fastMode ?? conv.fastMode ?? false,
  }
}
