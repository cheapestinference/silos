// harnesses/claude-code/loads/carries.ts — what a Claude Code plugin carries,
// read from its manifest and its folders: skills, slash commands, subagent
// types, hooks (how many, on which events), MCP servers and placeholders,
// LSP servers, output styles. Counts and names only — nothing is executed.
//
// The layout is Claude Code's documented plugin layout: `skills/<name>/
// SKILL.md`, `commands/*.md`, `agents/*.md`, `output-styles/*.md`,
// `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, each of which the manifest
// may point elsewhere (a path, a list of paths, or the map inline); custom
// paths add to the default folders.
//
// A plugin tree is walked once and remembered by the modification times of
// its directory, its manifest and its default folders (§10: plugin trees are
// remembered by directory mtime) — a new version or an edit is a new stamp.
// Tolerant: an unreadable piece is an empty one.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { LoadsCarries } from '../../contract.js'
import { pluginServerEntries } from './plugin-servers.js'

type Json = Record<string, unknown>
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const readJson = (path: string): Json | null => {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}
const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs
  } catch {
    return -1
  }
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
const list = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith('.'))
      .sort()
  } catch {
    return []
  }
}

const MAX_ENTRIES = 400
const DEFAULT_DIRS = ['skills', 'commands', 'agents', 'output-styles', 'hooks'] as const

/** The paths a manifest field names (a string or a list of strings), resolved in the plugin. */
function pathsOf(dir: string, v: unknown): string[] {
  const raw = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return raw.map((p) => resolve(dir, p))
}

/** Markdown entries of a folder (or a single file), as names without `.md`. */
function markdownNames(paths: string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (isFile(p)) {
      if (p.endsWith('.md')) out.add(basename(p, '.md'))
      continue
    }
    for (const n of list(p).slice(0, MAX_ENTRIES)) if (n.endsWith('.md') && isFile(join(p, n))) out.add(n.slice(0, -3))
  }
  return [...out].sort()
}

/** Skill folders (`<name>/SKILL.md`) under each path, or a path that is one. */
function skillNames(paths: string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (isFile(join(p, 'SKILL.md'))) {
      out.add(basename(p))
      continue
    }
    for (const n of list(p).slice(0, MAX_ENTRIES)) if (isFile(join(p, n, 'SKILL.md'))) out.add(n)
  }
  return [...out].sort()
}

/** The hooks a map declares: how many inner hooks, on which events. */
export function hookCounts(map: unknown): { count: number; events: string[] } {
  const m = asObject(map)
  if (!m) return { count: 0, events: [] }
  let count = 0
  const events: string[] = []
  for (const event of Object.keys(m).sort()) {
    const entries = m[event]
    if (!Array.isArray(entries)) continue
    let n = 0
    for (const e of entries) {
      const inner = asObject(e)?.hooks
      if (Array.isArray(inner)) n += inner.filter((h) => asObject(h) !== null).length
    }
    if (n > 0) {
      count += n
      events.push(event)
    }
  }
  return { count, events }
}

function lspNames(dir: string, manifest: Json | null): string[] {
  const declared = manifest?.lspServers
  const file = typeof declared === 'string' ? readJson(resolve(dir, declared)) : (asObject(declared) ?? readJson(join(dir, '.lsp.json')))
  const map = asObject(file?.lspServers) ?? file
  return map ? Object.keys(map).sort() : []
}

/** What one plugin directory carries, read now (no cache). */
export function readCarries(dir: string, manifest: Json | null = readJson(join(dir, '.claude-plugin', 'plugin.json'))): LoadsCarries {
  const declaredHooks = manifest?.hooks
  const hooksMap = asObject(declaredHooks)
    ? (asObject(declaredHooks)!.hooks ?? declaredHooks)
    : readJson(typeof declaredHooks === 'string' ? resolve(dir, declaredHooks) : join(dir, 'hooks', 'hooks.json'))?.hooks
  const servers = pluginServerEntries(dir, manifest)
  return {
    skills: skillNames([join(dir, 'skills'), ...pathsOf(dir, manifest?.skills)]),
    commands: markdownNames([join(dir, 'commands'), ...pathsOf(dir, manifest?.commands)]),
    agents: markdownNames([join(dir, 'agents'), ...pathsOf(dir, manifest?.agents)]),
    hooks: hookCounts(hooksMap),
    mcp: servers.filter((s) => !s.placeholder).length,
    placeholders: servers.filter((s) => s.placeholder).length,
    lsp: lspNames(dir, manifest),
    outputStyles: markdownNames([join(dir, 'output-styles'), ...pathsOf(dir, manifest?.outputStyles)]),
  }
}

const cache = new Map<string, { stamp: string; carries: LoadsCarries }>()
const CACHE_MAX = 300

const stampOf = (dir: string): string =>
  [
    mtime(dir),
    mtime(join(dir, '.claude-plugin', 'plugin.json')),
    ...DEFAULT_DIRS.map((d) => mtime(join(dir, d))),
    mtime(join(dir, '.mcp.json')),
    mtime(join(dir, '.lsp.json')),
  ].join(':')

/** What a plugin carries, remembered per directory until its stamp moves. */
export function carriesOf(dir: string): LoadsCarries {
  if (!isDir(dir)) return readCarries(dir, null)
  const stamp = stampOf(dir)
  const hit = cache.get(dir)
  if (hit && hit.stamp === stamp) return hit.carries
  const carries = readCarries(dir)
  cache.delete(dir)
  cache.set(dir, { stamp, carries })
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return carries
}
