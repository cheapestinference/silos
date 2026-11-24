// harnesses/opencode/auto-mode — the cockpit's permission mode in OpenCode's
// dialect (Claude: `--dangerously-skip-permissions` / `--permission-mode`).
//
// The cockpit cascade (agent → conversation → turn, cockpit.ts) resolves a
// permission mode for every turn and every console on BOTH engines; it
// defaults to bypass. The Claude console and the SDK honour it; the OpenCode
// console did not — it ran on OpenCode's own defaults and asked for every
// edit and command (by default it must not ask for permissions — what in
// Claude Code is --dangerously-skip-permissions).
//
// OpenCode's equivalent is `--auto` ("auto-approve permissions that are not
// explicitly denied"), on the TUI and on `run`; explicit deny rules — the
// territory fence (fence.ts) — are still enforced, so a fenced agent in auto
// mode stays fenced. Both list `--auto` on every OpenCode Silos runs: the
// minimum (version.ts OPENCODE_MINIMUM, 1.19.4) has it, and an older binary
// is refused by the compatibility gate before any console or turn starts —
// no capability probe, no per-binary fallback.
//
// The other two modes:
//   · `plan` → `--agent plan`, OpenCode's built-in primary agent whose rules
//     deny `edit` everywhere but its own plan files (verified 1.19.4,
//     `opencode agent list`). The TUI keeps a command-line `--agent` even
//     when it restores a resumed session's last agent; `run` takes it too.
//     No `--auto`: the plan agent's own asks stay asks.
//   · `acceptEdits` → no flag and no config change. Every OpenCode agent
//     already resolves `*: allow` (verified 1.19.4, `opencode debug agent
//     build --pure`), so edits flow by default; a config base of ours would
//     only override the operator's OWN earlier-layer `edit` denies — the
//     opposite of the mode. OpenCode's defaults and the operator's own asks
//     and denies stay in force; under headless `run` any ask that does
//     arise is auto-rejected (headless.ts says so per run).
//   · In plan mode a fenced agent can still edit its own state folder: the
//     fence's own-state allow comes after the plan agent's deny — intended.

/** The argv that carries the cockpit's permission mode to OpenCode (the
 *  TUI and `run` alike): bypass → `--auto`, plan → the plan agent;
 *  acceptEdits (OpenCode's own defaults stand), none or unknown → nothing:
 *  OpenCode asks as it would by itself. */
export function modeArgs(permissionMode: string | undefined): string[] {
  if (permissionMode === 'plan') return ['--agent', 'plan']
  if (permissionMode === 'bypassPermissions') return ['--auto']
  return []
}
