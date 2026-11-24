// harnesses/claude-code/server-hooks.ts — Claude Code's branches of the
// server's routes (Harness.server), moved verbatim from server.ts: the
// console open of an existing session (reattach, else `--resume` over its
// cwd) and of a new conversation (a fresh claude born with its session id),
// and the live model push (`/model <id>` typed into its pane). Its answer
// and send-to-console are server.ts's neutral defaults (digit + Enter,
// literal keystrokes). TerminalService builds claude's argv itself (no
// `command` passed), with its lock/holder guard on a resume.

import { randomUUID } from 'node:crypto'
import type { HarnessServerHooks, RouteResult, ServerHookContext } from '../contract.js'
import { mungePath } from '../../agent-registry.js'
import { ConsoleDialogError } from '../../console-dialog.js'
import { consoleEnvForProvider } from './env.js'
import { sdkTurnSkills } from './headless.js'
import { carriedSkillKeys } from './loads/skills.js'
import { loginDirsNow } from './loads/launch-entries.js'
import type { ResolvedProvider } from '../../providers-store.js'
import { agentProcessEnv } from '../../agent-env.js'
import { ensureRolePluginManifest, rolePluginFor } from '../../role-plugin.js'
import { BRIEFED_ENV, briefingText, withBriefingAfter } from '../briefing.js'

export function claudeServerHooks(ctx: ServerHookContext): HarnessServerHooks {
  const { index, registry, native, chat, vault, agentState, territory, silosApi, loadsCarried } = ctx.deps
  // what Silos keeps for an agent's launches (loads-scopes.ts): a real
  // agent's only — and, for a console that resumes a conversation, its
  // thread's after them (a new console has none yet)
  // — with every login's dir known at this launch (a personal-instructions
  // «off» is computed against them, so a login added later is covered)
  const carriedOf = (agentId: string, cwd?: string, resumeId?: string): { carried?: unknown[]; loginDirs?: string[] } => {
    const c = registry.get(agentId) ? (loadsCarried?.(agentId, cwd, resumeId) ?? []) : []
    return c.length > 0 ? { carried: c, ...loginDirsNow(ctx.deps.accounts ? () => ctx.deps.accounts!.configDirs().map((a) => a.configDir) : undefined) } : {}
  }
  const { terminals, freshConsoles, consoleKeyFor, classifyAgentId } = ctx.helpers

  // the role's own skills (role-plugin.ts) as the console's --plugin-dir —
  // the same resolver the SDK turn and OpenCode use; present only when the
  // role HAS skills, the manifest ensured at launch. An unsafe id or no
  // state store → no plugin (never a throw on the open path).
  const rolePluginOf = (agentId: string, agentName?: string): { rolePluginDir: string } | Record<string, never> => {
    let stateDir: string | null = null
    try {
      stateDir = agentState?.pathFor(agentId) ?? null
    } catch {
      /* unsafe id: no role plugin */
    }
    const dir = rolePluginFor(agentId, stateDir)
    if (!dir) return {}
    ensureRolePluginManifest(dir, agentId, agentName)
    return { rolePluginDir: dir }
  }

  return {
    openSession: async (id, meta, input): Promise<RouteResult> => {
      const { theme, pick, pinPicks, prompt } = input
      // Reattaching needs no cwd — only spawning does. A console-born
      // session's first JSONL lines carry none (it arrives a few writes
      // later), and before the watcher indexes the file there is no meta
      // at all; the console that wrote it is already running under this
      // id. A 400 here bounced the owner to the chat engine, which forked
      // the console's session into an SDK twin.
      const attached = await terminals.reattachConsole(meta ? await consoleKeyFor(meta) : id)
      if (attached) return { code: 201, body: attached }
      if (!meta || meta.cwd === null) return { code: 400, body: { error: 'session has no cwd — cannot open console' } }
      const cid = classifyAgentId(meta)
      // classifyAgentId can fall through to a synthesized/default id that
      // isn't a real registry agent (native-owner classification, an
      // orphan session) — only merge agent-state env when it resolves to
      // one, otherwise dirFor() would either throw on a bad id or create
      // a junk state dir for something that isn't an agent.
      const key = await consoleKeyFor(meta)
      pinPicks(meta.cwd, id)
      // the provider's env goes FIRST: vault vars are validated never to
      // collide with the auth layer, and agent state is platform plumbing
      // — the same order as the chat engine's env (harnesses/claude-code/headless.ts).
      const provider = registry.get(cid) ? (chat.consoleProviderFor?.(cid, meta.cwd, id, pick || undefined) ?? null) : null
      const has = consoleSkills(meta.cwd, provider, carriedOf(cid, meta.cwd, id).carried)
      const { append, briefedEnv } = consoleAppend(chat.systemAppendFor?.(cid, has, { sessionId: key, cwd: meta.cwd }) ?? null, has)
      // the thread's queue of given files, drained by the console's per-prompt hook
      const contextQueue = registry.get(cid) ? (chat.contextQueueFor?.(key) ?? null) : null
      // then the agent's process env (agent-env.ts: Vault, agent state when
      // cid is a real agent, SILOS_API, and SILOS_SESSION_ID — the
      // conversation this console serves: a `claude -p` its claude runs
      // from Bash presents itself as this conversation's nested run,
      // plugin/hooks/birth.py).
      const consoleEnv = {
        ...consoleEnvForProvider(provider),
        ...agentProcessEnv({ vault, agentState: registry.get(cid) ? agentState : undefined, silosApi }, { id: cid }, meta.cwd, key),
        ...briefedEnv,
      }
      const permissionMode = chat.consolePermissionMode?.(meta.cwd, id)
      const consoleModel = registry.get(cid) ? chat.consoleModel?.(cid, meta.cwd, id) : undefined
      const outputStyle = registry.get(cid) ? chat.consoleOutputStyle?.(cid, meta.cwd, id) : undefined
      const fence = registry.get(cid) ? (territory?.fenceFor(cid) ?? null) : null
      const rolePlugin = registry.get(cid) ? rolePluginOf(cid, registry.get(cid)?.name) : {}
      return {
        code: 201,
        body: await terminals.ensureConsole({
          cwd: meta.cwd,
          key,
          resumeId: key,
          ...(registry.get(cid) ? { agentId: cid } : {}),
          ...rolePlugin,
          ...(fence ? { fence } : {}),
          ...carriedOf(cid, meta.cwd ?? undefined, id),
          ...(append ? { append } : {}),
          ...(Object.keys(consoleEnv).length > 0 ? { extraEnv: consoleEnv } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(consoleModel ? { model: consoleModel } : {}),
          ...(outputStyle ? { outputStyle } : {}),
          ...(theme ? { theme } : {}),
          ...(prompt ? { prompt } : {}),
          ...(contextQueue ? { contextQueue } : {}),
        }),
      }
    },

    // a new conversation → a fresh claude in the agent's folder, born
    // with its session id (`--session-id`) which is ALSO the console
    // key. Keyed by agent it was a bug: once that claude wrote
    // its JSONL, opening the session started a `--resume` twin, trash
    // killed only the twin and the original kept the session alive
    // (and the next "new conversation" reattached to the old chat).
    // The waiting claude is REUSED while nothing has been typed (its
    // session doesn't exist yet) — one idle claude per agent, as before.
    openNew: async (agent, input): Promise<RouteResult> => {
      const { theme, pick, pinPicks, prompt } = input
      const agentId = agent.id
      const pending = freshConsoles.get(agentId)
      const persisted = (id: string): boolean => index.allSessions().some((m) => m.id === id)
      // a conversation born WITH a first prompt is never the idle console
      // (it starts working at once) — it neither reuses nor becomes it
      const key = !prompt && pending && !persisted(pending) && (await terminals.hasConsole(pending)) ? pending : randomUUID()
      if (!prompt) freshConsoles.set(agentId, key)
      // Silos-born, so it says who gave birth — the same record the chat
      // engine writes at `system/init`. Without it a console-born thread
      // was classified by its transcript, and among agents sharing a folder
      // that meant the DEFAULT agent (a Builder console landed in Writer).
      native.register(mungePath(agent.folder), key, { agentId, createdAt: new Date().toISOString() })
      // `agent` is already confirmed real above — no guard needed here.
      pinPicks(agent.folder, key)
      const provider = chat.consoleProviderFor?.(agentId, agent.folder, key, pick || undefined) ?? null
      const has = consoleSkills(agent.folder, provider, carriedOf(agentId, agent.folder).carried)
      const { append, briefedEnv } = consoleAppend(chat.systemAppendFor?.(agentId, has, { sessionId: key, cwd: agent.folder }) ?? null, has)
      const contextQueue = chat.contextQueueFor?.(key) ?? null
      const consoleEnv = { ...consoleEnvForProvider(provider), ...agentProcessEnv({ vault, agentState, silosApi }, agent, agent.folder, key), ...briefedEnv }
      const permissionMode = chat.consolePermissionMode?.(agent.folder)
      // the picks were just pinned under `key` (pinPicks): the cascade reads them
      const consoleModel = chat.consoleModel?.(agentId, agent.folder, key)
      const outputStyle = chat.consoleOutputStyle?.(agentId, agent.folder, key)
      const fence = territory?.fenceFor(agentId) ?? null
      return {
        code: 201,
        body: await terminals.ensureConsole({
          cwd: agent.folder,
          key,
          sessionId: key,
          agentId,
          ...rolePluginOf(agentId, agent.name),
          ...(fence ? { fence } : {}),
          ...carriedOf(agentId, agent.folder),
          ...(append ? { append } : {}),
          ...(Object.keys(consoleEnv).length > 0 ? { extraEnv: consoleEnv } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(consoleModel ? { model: consoleModel } : {}),
          ...(outputStyle ? { outputStyle } : {}),
          ...(theme ? { theme } : {}),
          ...(prompt ? { prompt } : {}),
          ...(contextQueue ? { contextQueue } : {}),
        }),
      }
    },

    //  · Claude: the running CLI switches in place on `/model <id>` typed
    //    into its pane ('live'); an unpin (model null) has no in-place
    //    form and waits for the next launch ('next-turn').
    //  No console: nothing (null) — the pin simply waits for the next turn.
    //  · a style is read at SessionStart: a live console takes it only on
    //    relaunch ('restart' — the panel relaunches it right away).
    pushPin: async (_id, key, patch, prefs) => {
      let applied: 'live' | 'restart' | 'next-turn' | null = null
      if (key && 'outputStyle' in patch) return 'restart'
      // the account (CLAUDE_CONFIG_DIR) and a key's endpoint ride the
      // process ENV: a live claude can never switch login in place, so a
      // provider change relaunches it — otherwise the console kept the old
      // login (and its connectors, MCP and usage) while Silos said the new
      // one (if it changes, everything changes)
      if (key && 'provider' in patch) return 'restart'
      if (key) {
        if ('model' in patch && typeof prefs.model === 'string' && prefs.model !== '') {
          try {
            await terminals.consoleSendLiteral(key, `/model ${prefs.model}`)
            applied = 'live'
          } catch (e) {
            // a dialog open in the console (the guard typed nothing) or the
            // pane gone: the pin waits, never an Enter into a dialog
            if (e instanceof ConsoleDialogError) console.warn(`[silos] /model not typed into console ${key}: it shows a ${e.dialog} dialog`)
            applied = 'next-turn'
          }
        } else {
          applied = 'next-turn'
        }
      }
      return applied
    },
  }
}

// A console's --append-system-prompt-file: the agent's append (null for an
// unknown or archived agent: no file, and the SessionStart hook briefs it)
// with the static briefing after it, composed for the skills the console
// loads — the route an unattended turn already uses. In the system prompt
// it survives /clear and compaction and is never cut at the hook's
// 10,000-character cap; SILOS_BRIEFING tells the hook to send only what is
// dynamic (roster, inbox, the /clear reminder). Exported for its test.
export function consoleAppend(own: string | null, has: readonly string[], dir?: string): { append: string | undefined; briefedEnv: Record<string, string> } {
  if (own === null) return { append: undefined, briefedEnv: {} }
  let text = ''
  try {
    text = dir === undefined ? briefingText(has) : briefingText(has, dir)
  } catch {
    /* the briefing never breaks a launch */
  }
  const append = withBriefingAfter(own, text)
  return { append: append === '' ? undefined : append, briefedEnv: text !== '' ? { ...BRIEFED_ENV } : {} }
}

// The skills a console's claude loads, for its append (spec R7) — the one
// answer every launch reads (sdkTurnSkills -> loads/skills.ts
// launchSkillNames): the folder's own copies, the login's personal and
// account skills, without what any tier turns off — the files the console
// reads itself (all three sources) and what Silos carries for its launch,
// the agent's entries and, resumed, its conversation's (they ride its
// --settings: the flag tier).
function consoleSkills(cwd: string, provider: ResolvedProvider | null, carried?: readonly unknown[]): string[] {
  return sdkTurnSkills(
    cwd,
    ['user', 'project', 'local'],
    provider?.kind === 'claude-account' ? provider.configDir : null,
    undefined,
    undefined,
    carriedSkillKeys(carried),
  )
}
