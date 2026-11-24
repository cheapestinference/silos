// harnesses/claude-code/output-styles.ts — the cockpit's sixth field on
// Claude Code: which OUTPUT STYLE a conversation answers in — an explanatory
// option settable per agent or per conversation, applied systematically.
//
// Facts verified on Claude Code 2.1.316 with a zero-token probe (a local
// fake API capturing the request body; re-verify when it updates):
// - the native setting is `outputStyle`; its value is the style's NAME,
//   case-sensitive: built-ins `default · Proactive · Concise · Explanatory ·
//   Learning` (the same five in the SDK's bundled 2.1.304), a custom style
//   is the `name:` of its frontmatter (the file name only when it has none);
//   an unknown name falls back to default IN SILENCE — so Silos only ever
//   passes a name it found.
// - the style lands as a `# Output Style: <name>` block in the turn; the
//   `explanatory-output-style` PLUGIN (a SessionStart hook injecting the
//   same insights) is a separate channel a style setting does NOT turn off.
// - `--settings` (the flag tier) outranks ~/.claude/settings.json: an
//   `enabledPlugins: {<id>: false}` there keeps a globally enabled plugin
//   out of that one process.
//
// The rule: when Silos has a style for the conversation (agent default or
// conversation pin), the process gets `outputStyle` AND the output-style
// plugins off, so the cockpit field is the single truth and no global
// plugin overrides it. When nobody set one: nothing — the operator's own
// config, exactly as before.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OUTPUT_STYLE_ID_RE } from '../../cockpit.js'

import type { OutputStyleInfo } from '../contract.js'

export const CLAUDE_BUILTIN_STYLES: readonly OutputStyleInfo[] = [
  { id: 'default', description: 'Claude Code’s usual voice', source: 'built-in' },
  { id: 'Explanatory', description: 'Explains its implementation choices and codebase patterns', source: 'built-in' },
  { id: 'Learning', description: 'Pauses and asks you to write small pieces of code', source: 'built-in' },
  { id: 'Concise', description: 'Terse: leads with results, skips preamble and narration', source: 'built-in' },
  { id: 'Proactive', description: 'Executes immediately, minimizes interruptions', source: 'built-in' },
]

// the official plugins that inject a style of their own at SessionStart —
// off for a process whose style Silos sets (disabling one that is not
// installed is a no-op, verified)
export const OUTPUT_STYLE_PLUGINS = ['explanatory-output-style@claude-plugins-official', 'learning-output-style@claude-plugins-official'] as const

/** The per-process settings for a style: {} when nobody set one. Merged
 *  into the ONE `--settings` of a console and the SDK's `settings`. */
export function outputStyleSettings(style: string | undefined): Record<string, unknown> {
  if (style === undefined || style === '') return {}
  return {
    outputStyle: style,
    enabledPlugins: Object.fromEntries(OUTPUT_STYLE_PLUGINS.map((p) => [p, false])),
  }
}

const MAX_STYLE_FILES = 100
const MAX_STYLE_BYTES = 256 * 1024

// a style file's frontmatter name/description — a small reader, not YAML:
// `key: value` lines between the leading `---` fences, optional quotes
function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    out[(kv[1] ?? '').toLowerCase()] = (kv[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function readDir(dir: string, source: 'user' | 'project'): OutputStyleInfo[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith('.md') && !n.startsWith('.'))
      .sort()
      .slice(0, MAX_STYLE_FILES)
  } catch {
    return []
  }
  const out: OutputStyleInfo[] = []
  for (const n of names) {
    const p = join(dir, n)
    try {
      const st = statSync(p)
      if (!st.isFile() || st.size > MAX_STYLE_BYTES) continue
      const fm = frontmatter(readFileSync(p, 'utf8'))
      const id = (fm.name ?? '').trim() || n.slice(0, -3)
      if (!OUTPUT_STYLE_ID_RE.test(id)) continue
      out.push({ id, description: fm.description ?? '', source })
    } catch {
      // an unreadable file is not a style
    }
  }
  return out
}

/** What the engine offers for a conversation in `cwd`: the built-ins, then
 *  the operator's own styles (~/.claude/output-styles), then the project's
 *  (<cwd>/.claude/output-styles). Read-only; a name already listed is not
 *  repeated (a project style that shares a user style's name is the
 *  project's). */
export function listClaudeOutputStyles(cwd: string | null, home: string = homedir()): OutputStyleInfo[] {
  const builtIns = [...CLAUDE_BUILTIN_STYLES]
  const user = readDir(join(home, '.claude', 'output-styles'), 'user')
  const project = cwd ? readDir(join(cwd, '.claude', 'output-styles'), 'project') : []
  const byId = new Map<string, OutputStyleInfo>()
  for (const s of [...builtIns, ...user, ...project]) {
    const prev = byId.get(s.id)
    if (prev?.source === 'built-in') continue
    byId.set(s.id, s)
  }
  return [...byId.values()]
}
