// claude-sign-in.ts — reading what `claude auth login` prints, for the
// sign-in block (components/ClaudeSignIn.tsx). Pure, over the raw PTY bytes.
//
// What the binary prints: "Opening browser to sign in…", then its
// authorize link (an OSC 8 hyperlink), then the prompt "Paste code here if
// prompted > ". Verified on 2.1.330: the pasted code is echoed, "Signing
// in…", and a wrong or stale code ends the process with its reason —
// "Couldn't log in: That code wasn't accepted. It may be incomplete,
// expired, …" (exit 1); one process, one try. Older releases (2.1.311)
// printed "Invalid code. …" and waited for another. A good code writes the
// login and exits 0.

// OSC 8: ESC ] 8 ; params ; URI (BEL | ESC \)
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/
const PLAIN_LINK = /https:\/\/claude\.(?:com|ai)\/\S*oauth\S+/

/** The sign-in link Claude printed — the OSC 8 target, or a bare claude.com
 *  oauth URL if the binary ever stops wrapping it. Only https. */
export function signInLink(raw: string): string | null {
  const m = OSC8.exec(raw)
  if (m) return m[1]!
  const p = PLAIN_LINK.exec(plainText(raw))
  return p ? p[0] : null
}

/** The bytes as text a person reads: escape sequences (OSC, CSI, the rest)
 *  and carriage returns removed. */
export function plainText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/\r/g, '')
}

/** The last thing Claude said since `from` (a raw offset) — the line that
 *  answers a pasted code. The prompt itself is not an answer. */
export function claudeReply(raw: string, from: number): string | null {
  const lines = plainText(raw.slice(from))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^Paste code here/i.test(l) && !/^Signing in/i.test(l))
  return lines.at(-1) ?? null
}

/** Claude refused the code (it keeps waiting for another). */
export function isRejection(reply: string | null): boolean {
  return reply !== null && /invalid|expired|error|failed|couldn.t|not accepted|wasn.t accepted/i.test(reply)
}
