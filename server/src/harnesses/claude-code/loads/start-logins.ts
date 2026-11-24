// harnesses/claude-code/loads/start-logins.ts — the Claude login a
// conversation's start recorded: the account id of its `session-owner`
// record and the email its session_context names, read from the head of its
// transcript. Shared by Loaded at start and the inventory (the batches are
// matched to logins by account id — account-batches.ts).
import { closeSync, openSync, readSync } from 'node:fs'

type Json = Record<string, unknown>
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)

const TRANSCRIPT_HEAD_BYTES = 256 * 1024

/** The first bytes of a transcript, as whole lines. */
export function transcriptHead(path: string): string[] {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(TRANSCRIPT_HEAD_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const lines = text.split('\n')
    if (n === buf.length) lines.pop() // a partial last line
    return lines
  } catch {
    return []
  } finally {
    if (fd !== null)
      try {
        closeSync(fd)
      } catch {
        /* closed */
      }
  }
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/

/** The Claude login of the newest start that recorded one: the account id
 *  of its `session-owner` record and the email its session_context names.
 *  Transcripts in the order given (its own newest first); null = none did. */
export function startLogin(transcripts: string[]): { accountUuid: string; email: string | null } | null {
  return startLogins(transcripts, 1)[0] ?? null
}

/** Every distinct login the given starts recorded (by account id, the first
 *  email any of its starts names), in the order first met. */
export function startLogins(transcripts: string[], max = Infinity): { accountUuid: string; email: string | null }[] {
  const out: { accountUuid: string; email: string | null }[] = []
  for (const one of loginsOf(transcripts)) {
    const prev = out.find((l) => l.accountUuid === one.accountUuid)
    if (prev) {
      prev.email ??= one.email
      continue
    }
    if (out.length >= max) break
    out.push(one)
  }
  return out
}

function* loginsOf(transcripts: string[]): Generator<{ accountUuid: string; email: string | null }> {
  for (const t of transcripts) {
    let accountUuid: string | null = null
    let email: string | null = null
    for (const line of transcriptHead(t)) {
      if (line.includes('"session-owner"')) {
        try {
          const r = asObject(JSON.parse(line))
          if (r?.type === 'session-owner' && typeof r.accountUuid === 'string' && r.accountUuid !== '') accountUuid = r.accountUuid
        } catch {
          /* a torn line */
        }
      } else if (email === null && line.includes('"session_context"')) {
        try {
          const a = asObject(asObject(JSON.parse(line))?.attachment)
          const ctx = asObject(a?.context)
          const m = a?.type === 'session_context' && typeof ctx?.userEmail === 'string' ? EMAIL.exec(ctx.userEmail) : null
          if (m) email = m[0].replace(/\.+$/, '')
        } catch {
          /* a torn line */
        }
      }
    }
    if (accountUuid !== null) yield { accountUuid, email }
  }
}
