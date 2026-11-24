// harnesses/opencode/loaded-at-start — what an OpenCode session of an agent
// reads before its first message, from the files Silos itself passes
// (assemble.ts `instructions`) and the configs OpenCode merges. Observed,
// never executed, never written:
//  · instructions: Silos' briefing + roster (context.md) and role prompt
//    (role.md) as written at the last launch under the agent's state folder,
//    the project's AGENTS.md / CLAUDE.md / CONTEXT.md by OpenCode's own rule
//    (projectInstructions: the first name found from the folder up to the
//    worktree), and the operator's global ~/.config/opencode/AGENTS.md;
//  · no start hooks: Silos' OpenCode plugin adds nothing to the context;
//  · MCP servers: the `mcp` keys of the operator's opencode.json(c) and the
//    folder's own (a fenced agent launches without the project config).
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { LoadedAtStart, LoadedAtStartInput, LoadedInstruction, LoadedMcp } from '../contract.js'
import { projectInstructions } from './launch.js'
import { worktreeOf } from './worktree.js'
import { opencodeMcpEntries } from './loads.js'
import { ownMcpServerNames } from '../../role-plugin.js'

function bytesOf(path: string): number | null {
  try {
    const s = statSync(path)
    return s.isFile() ? s.size : null
  } catch {
    return null
  }
}

/** The `mcp` server names of an opencode.json(c) text; [] when it doesn't parse. */
export function opencodeMcpNames(text: string): string[] {
  return opencodeMcpEntries(text)
    .filter((e) => e.enabled !== false)
    .map((e) => e.name)
    .sort()
}

export function readOpencodeLoadedAtStart(input: LoadedAtStartInput): LoadedAtStart {
  const { folder, home } = input
  const shown = (p: string): string => {
    const r = relative(folder, p)
    if (r !== '' && !r.startsWith('..') && !isAbsolute(r)) return r
    const h = relative(home, p)
    return h !== '' && !h.startsWith('..') && !isAbsolute(h) ? `~/${h}` : p
  }
  const instructions: LoadedInstruction[] = []
  const add = (path: string, kind: LoadedInstruction['kind']): void => {
    const bytes = bytesOf(path)
    if (bytes !== null && !instructions.some((i) => i.path === path)) instructions.push({ path, rel: shown(path), kind, when: 'start', bytes })
  }
  if (input.agentStateDir) {
    add(join(input.agentStateDir, 'opencode', 'context.md'), 'silos')
    add(join(input.agentStateDir, 'opencode', 'role.md'), 'silos')
  }
  let worktree = folder
  try {
    worktree = worktreeOf(folder)
  } catch {
    /* not a repo: the folder itself */
  }
  for (const p of projectInstructions(folder, worktree)) add(p, 'project')
  add(join(home, '.config', 'opencode', 'AGENTS.md'), 'global')

  const mcp: LoadedMcp[] = []
  // its own servers (agent-tools.ts) — assemble.ts adds them to the config's `mcp`
  if (input.agentStateDir !== null) for (const n of ownMcpServerNames(input.agentStateDir)) mcp.push({ name: n, source: 'agent', from: input.agent.id })
  const read = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  }
  for (const [dir, source, from] of [
    [join(home, '.config', 'opencode'), 'user', '~/.config/opencode'],
    [folder, 'project', 'opencode.json'],
  ] as const) {
    for (const f of ['opencode.json', 'opencode.jsonc']) {
      const text = read(join(dir, f))
      if (text === null) continue
      for (const n of opencodeMcpNames(text))
        if (!mcp.some((m) => m.name === n && m.source === source)) mcp.push({ name: n, source, from: source === 'user' ? `${from}/${f}` : f })
    }
  }
  return {
    engine: 'OpenCode',
    folder,
    instructions,
    injections: [],
    outputStyle: null,
    mcp,
    toolsDoor: false,
    notes: ["Silos' plugin for OpenCode adds nothing to the context — the briefing travels as an instruction file."],
  }
}
