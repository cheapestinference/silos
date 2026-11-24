// no-typing-into-consoles.test.ts — «no Enter in open dialogs»:
// Silos never types into a console on the owner's
// behalf. Give, Write and Open reach an agent through a task note, a wake or
// a briefed launch — never keystrokes. Only three callers may type: the
// explicit `POST /api/console/:key/send` (the owner's own words), the
// owner's pick on an open question (`/api/sessions/:folder/:id/answer` —
// the digit the TUI itself asks for) and the `/model` the console's model
// pick sends (server-hooks) — the /send and the /model type nothing while the screen
// shows a dialog (consoleSendLiteral's guard). Another caller is a
// new decision, not a refactor: this test fails until the spec says so.
// Read from a real parse (identifiers only — comments never count).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codeWords } from './helpers/module-specifiers.js'

const SRC = new URL('../src/', import.meta.url).pathname
const ALLOWED = ['harnesses/claude-code/server-hooks.ts', 'routes/console.ts', 'routes/sessions.ts', 'terminal-service.ts'].sort()
const TYPING = ['consoleSendLiteral', 'consoleSendKeys']

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : n.endsWith('.ts') && !n.endsWith('.d.ts') ? [p] : []
  })
}

describe('Silos never types into a console', () => {
  it('only the explicit /send, the question answer, the /model pick and their definition name the typing verbs', () => {
    const naming = files(SRC)
      .filter((f) => {
        const words = new Set(codeWords(readFileSync(f, 'utf8'), f))
        return TYPING.some((w) => words.has(w))
      })
      .map((f) => relative(SRC, f))
      .sort()
    expect(naming).toEqual(ALLOWED)
  })
})
