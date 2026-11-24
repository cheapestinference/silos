// harnesses/claude-code/console.ts — the argv the real console runs for
// Claude Code, and the per-console hooks it carries (rotation on /clear,
// context news on every prompt). Pure, so the flags are unit-testable
// without a tmux; TerminalService (../../terminal-service.ts) launches it.
import { CLAUDE_CMD } from './binary.js'
import { CONTEXT_GIVEN_HEADING, CONTEXT_NEWS_HEADING } from '../../context-service.js'
import type { FenceOverlay } from '../../territory.js'
import type { ConsoleTheme } from '../../terminal-service.js'
import { outputStyleSettings } from './output-styles.js'
import { withLaunchEntries } from './loads/launch-entries.js'
import { worktreeCarry } from './local-holds.js'

// The env a Claude console runs with on top of the clean env — see the
// CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN note in TerminalService.ensureConsole.
export const CLAUDE_CONSOLE_ENV = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' }

export type ConsoleCommandOpts = {
  resumeId?: string
  sessionId?: string
  appendFile?: string
  permissionMode?: string
  model?: string
  outputStyle?: string
  theme?: ConsoleTheme
  rotationHook?: { dir: string; key: string }
  contextNews?: { dir: string; key: string; cwd: string; agentId: string; queue?: string }
  fence?: FenceOverlay
  rolePluginDir?: string
  prompt?: string
  carried?: unknown[]
  loginDirs?: string[]
  cwd?: string
}

// The SessionStart(clear) hook the console's claude runs: reads the hook
// payload from stdin and files `<dir>/<new session id>.json = {from: key}`
// so the server (LineageStore.absorbRotations) can hang the rotated
// session from this console's. Plain `node -e` (node is what runs Silos —
// no curl, no token, no network: local file, 0600 by the dir's mode).
// Never throws inside claude: any failure is swallowed (the console must
// keep working even if the dir vanished).
export function rotationHookCommand(dir: string, key: string): string {
  // Both land inside a shell string: allowlist first (a key is a session
  // id; a dir is a path under the data dir, spaces allowed), escape second.
  if (!/^[\w-]+$/.test(key)) throw new Error('invalid console key')
  if (!/^[\w./ -]+$/.test(dir)) throw new Error('rotations dir has characters a shell string cannot carry')
  const js = `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const s=JSON.parse(d).session_id;if(typeof s==='string'&&/^[\\w-]+$/.test(s))require('fs').writeFileSync(require('path').join(${JSON.stringify(dir)},s+'.json'),JSON.stringify({from:${JSON.stringify(key)}}))}catch{}})`
  // sh -c "node -e \"...\"": the JS uses single quotes only, so it rides inside
  // double quotes — every character sh expands there (" \ $ `) is escaped.
  return `node -e "${js.replace(/["\\$`]/g, (c) => '\\' + c)}"`
}

// The UserPromptSubmit hook the console's claude runs on EVERY prompt: lists
// the context files (<cwd>/context/shared + <cwd>/context/<agent>) newer than
// the console's marker (<dir>/<key>.ctx, its own last prompt), prints them
// (a hook's stdout joins the turn's context — the documented channel), and
// bumps the marker. The same words the SDK turn gets (context-service.ts
// awarenessNote newSince). First prompt: primes the marker, prints nothing
// (the launch append already listed everything). Never throws inside claude.
//
// `queue`: the thread's queue of files the owner GAVE this conversation
// (context-news.ts, baked in at launch — the thread id is the server's
// resolution, never the hook's). Every prompt drains it: RENAME it aside,
// then read, then delete — a line the server appends meanwhile lands in a
// fresh file for the next prompt, never lost to a read-then-truncate.
export function contextNewsHookCommand(dir: string, key: string, cwd: string, agentId: string, queue?: string): string {
  if (!/^[\w-]+$/.test(key)) throw new Error('invalid console key')
  if (!/^[\w-]+$/.test(agentId)) throw new Error('invalid agent id for the context hook')
  if (!/^[\w./ -]+$/.test(dir) || !/^[\w./ -]+$/.test(cwd)) throw new Error('paths with characters a shell string cannot carry')
  if (queue !== undefined && !/^[\w./ -]+$/.test(queue)) throw new Error('paths with characters a shell string cannot carry')
  const given =
    queue === undefined
      ? ''
      : `let g=[];const q=${JSON.stringify(queue)},a=q+'.'+process.pid+'.draining';try{f.renameSync(q,a);try{g=f.readFileSync(a,'utf8').split('\\n').filter(Boolean)}finally{f.unlinkSync(a)}}catch{}if(g.length)console.log(${JSON.stringify(CONTEXT_GIVEN_HEADING)}+'\\n'+g.map(x=>'- '+x).join('\\n'));`
  const js = `try{const f=require('fs'),p=require('path');${given}const m=p.join(${JSON.stringify(dir)},${JSON.stringify(key)}+'.ctx');let s=0;try{s=f.statSync(m).mtimeMs}catch{}const o=[];for(const d of ['shared',${JSON.stringify(agentId)}]){const r=p.join(${JSON.stringify(cwd)},'context',d);let n=[];try{n=f.readdirSync(r)}catch{}for(const x of n){if(x[0]==='.')continue;try{const t=f.statSync(p.join(r,x));if(t.isFile()&&s>0&&t.mtimeMs>s)o.push('- context/'+d+'/'+x)}catch{}}}f.mkdirSync(${JSON.stringify(dir)},{recursive:true});f.writeFileSync(m,'');if(o.length)console.log(${JSON.stringify(CONTEXT_NEWS_HEADING)}+'\\n'+o.join('\\n'))}catch{}`
  return `node -e "${js.replace(/["\\$`]/g, (c) => '\\' + c)}"`
}

// The command the real console runs. Exported (and pure) so the flags are
// unit-testable without a tmux.
export function defaultConsoleCommand({
  resumeId,
  sessionId,
  appendFile,
  permissionMode,
  model,
  outputStyle,
  theme,
  rotationHook,
  contextNews,
  fence,
  rolePluginDir,
  prompt,
  carried,
  loginDirs,
  cwd,
}: ConsoleCommandOpts): string[] {
  // ONE --settings carries every per-process override (theme, hooks, the
  // territory fence's permissions — flag-tier deny rules hold even under
  // --dangerously-skip-permissions).
  const base: Record<string, unknown> = {
    ...(theme === 'light' ? { theme: 'light' } : {}),
    ...(rotationHook || contextNews
      ? {
          hooks: {
            ...(rotationHook
              ? { SessionStart: [{ matcher: 'clear', hooks: [{ type: 'command', command: rotationHookCommand(rotationHook.dir, rotationHook.key) }] }] }
              : {}),
            ...(contextNews
              ? {
                  UserPromptSubmit: [
                    {
                      hooks: [
                        {
                          type: 'command',
                          command: contextNewsHookCommand(contextNews.dir, contextNews.key, contextNews.cwd, contextNews.agentId, contextNews.queue),
                        },
                      ],
                    },
                  ],
                }
              : {}),
          },
        }
      : {}),
    ...(fence ? { permissions: fence.permissions } : {}),
    // the cockpit's style (conversation pin › agent default): read at
    // SessionStart, so a change reaches a live console on relaunch only
    ...outputStyleSettings(outputStyle),
    // started in a worktree of a folder: the folder's own local excludes
    // ride too, said for the worktree's root (local-holds.ts worktreeCarry)
    ...(cwd && worktreeCarry(cwd).length > 0 ? { claudeMdExcludes: worktreeCarry(cwd) } : {}),
  }
  // what Silos keeps for this agent's launches (loads-scopes.ts), through
  // the allowlist (loads/launch-entries.ts): into the SAME object, every
  // key above kept — none: the argv is byte-identical
  // — every login known at this launch for a personal-instructions «off»
  const settings = withLaunchEntries(base, carried, { ...(loginDirs ? { loginDirs } : {}), ...(cwd ? { cwd } : {}) })
  return [
    CLAUDE_CMD,
    ...(appendFile ? ['--append-system-prompt-file', appendFile] : []),
    // the SAME permission cascade the chat engine resolves — without it
    // the console fell to the CLI default and its auto classifier
    // blocked what the other engine allowed.
    ...(permissionMode === 'bypassPermissions' ? ['--dangerously-skip-permissions'] : permissionMode ? ['--permission-mode', permissionMode] : []),
    // the cockpit's model (conversation pin › agent default), as the CLI
    // takes it: an alias (opus) or a full id. Nothing when nobody opined —
    // the CLI's own default stands (the column's pick must
    // reach the console on both engines).
    ...(model ? ['--model', model] : []),
    // the role's own skills (agent-state/<id>/plugin, role-plugin.ts):
    // a documented session-only plugin load — never written into any
    // settings file, exactly like the fence above.
    ...(rolePluginDir ? ['--plugin-dir', rolePluginDir] : []),
    // The console follows Silos' theme: xterm paints the
    // light/dark palette, but claude has ITS OWN theme (its dim greys are
    // invisible on a cream background), so the CLI must be told too.
    // `--settings` is a per-process override — the owner's
    // ~/.claude/settings.json is never touched. Only sent when it differs
    // from the CLI's usual dark, so the dark command stays byte-identical.
    ...(Object.keys(settings).length > 0 ? ['--settings', JSON.stringify(settings)] : []),
    ...(resumeId ? ['--resume', resumeId] : []),
    // a NEW conversation is born with its id: the console's key IS the
    // session id from the first byte, so the JSONL that shows up later
    // maps to THIS claude (open → reattach, trash → kill), never to a
    // twin `--resume` of it.
    ...(sessionId ? ['--session-id', sessionId] : []),
    // the conversation's FIRST prompt (task mode's «Work on this» briefing):
    // the CLI's documented positional prompt — `claude "query"` starts the
    // interactive session with it, `claude -r <id> "query"` resumes with it.
    // One argv element (the launcher exec()s argv untouched); last, so it
    // is never read as a flag's value.
    ...(prompt && prompt.trim() !== '' ? [prompt] : []),
  ]
}
