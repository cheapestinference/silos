// claude-console-dialogs.test.ts — the Claude Code TUI's dialogs read from
// its screen (harnesses/claude-code/dialogs.ts), before Silos types a prompt
// + Enter: the trust, permission, question and plan dialogs are seen; the
// normal prompt, a reply with a numbered list, an OpenCode screen and an
// empty one always pass (a false block would break every send).
import { describe, expect, it } from 'vitest'
import { claudeDialogOnScreen } from '../src/harnesses/claude-code/dialogs.js'
import { harnessById, fallbackHarness } from '../src/harnesses/index.js'

const screen = (...lines: string[]): string => ['', ...lines, '', ''].join('\n')

const TRUST_OLD = screen(
  '╭──────────────────────────────────────────────────────────────╮',
  '│ Do you trust the files in this folder?                       │',
  '│                                                              │',
  '│ /work/project                                                │',
  '│                                                              │',
  '│ Claude Code may read, write, or execute files contained in   │',
  '│ this directory. This can pose security risks, so only use    │',
  '│ files from trusted sources.                                  │',
  '│                                                              │',
  '│ ❯ 1. Yes, proceed                                            │',
  '│   2. No, exit                                                │',
  '╰──────────────────────────────────────────────────────────────╯',
  '   Enter to confirm · Esc to exit',
)

const TRUST_NEW = screen(
  '────────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ' /work/project',
  '',
  ' Quick safety check: Is this a project you created or one you',
  ' trust? (Like your own code, a well-known open source project, or',
  " work from your team). If not, take a moment to review what's in",
  ' this folder first.',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
)

const PERMISSION = screen(
  "● I'll list the files.",
  '',
  '╭──────────────────────────────────────────────────────────────╮',
  '│ Bash command                                                 │',
  '│                                                              │',
  '│   ls -la src                                                 │',
  '│   List the source files                                      │',
  '│                                                              │',
  '│ Do you want to proceed?                                      │',
  '│ ❯ 1. Yes                                                     │',
  "│   2. Yes, and don't ask again for ls commands in /work      │",
  '│   3. No, and tell Claude what to do differently (esc)        │',
  '╰──────────────────────────────────────────────────────────────╯',
)

const EDIT = screen(
  ' Edit file',
  ' src/app.ts',
  ' - const a = 1',
  ' + const a = 2',
  ' Do you want to make this edit to app.ts?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No, and tell Claude what to do differently (esc)',
)

const QUESTION = screen(
  '────────────────────────────────────────────────────────────────',
  ' ☐ Database',
  '',
  ' Which database should the service use?',
  '',
  ' ❯ 1. Postgres',
  '      Relational, the team knows it',
  '   2. SQLite',
  '      A file, no server',
  '   3. Type something.',
  '────────────────────────────────────────────────────────────────',
  '   4. Chat about this',
  '',
  ' Enter to select · ↑/↓ to navigate · Esc to cancel',
)

const PLAN = screen(
  ' Ready to code?',
  '',
  " Here is Claude's plan:",
  ' ╭─────────────────────────────────────────╮',
  ' │ 1. Add the route                        │',
  ' │ 2. Test it                              │',
  ' ╰─────────────────────────────────────────╯',
  '',
  ' Would you like to proceed?',
  '',
  ' ❯ 1. Yes, and auto-accept edits',
  '   2. Yes, and manually approve edits',
  '   3. No, keep planning',
  '',
  ' ctrl-g to edit in your editor',
)

const PROMPT = screen(
  '> fix the failing test',
  '',
  '● Done. The test passes now:',
  '  1. the fixture was stale',
  '  2. the assertion now reads the new shape',
  '',
  '╭──────────────────────────────────────────────────────────────╮',
  '│ >                                                            │',
  '╰──────────────────────────────────────────────────────────────╯',
  '  ? for shortcuts',
)

// a reply that QUOTES a dialog's words above the live prompt (a pointer
// line included): the prompt's footer below says it is text, not a dialog
const PROMPT_QUOTING_A_DIALOG = screen(
  '● The trust dialog looks like this:',
  '  Do you trust the files in this folder?',
  '  ❯ 1. Yes, proceed',
  '    2. No, exit',
  '  Enter to confirm · Esc to exit',
  '',
  '────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────',
  '  ? for shortcuts',
)

// the owner's input line is «❯ » and they typed «1. foo» — no neighbour
const PROMPT_TYPING_A_NUMBER = screen(
  '● Which step first?',
  '',
  '────────────────────────────────────────────────────────────────',
  '❯ 1. foo',
  '────────────────────────────────────────────────────────────────',
)

const OPENCODE = screen('  ┃  Build auto · claude-sonnet-4 anthropic', '  ┃', '  ┃  > ask anything', '', '  enter send   ctrl+x h help')

describe('claudeDialogOnScreen', () => {
  it.each([
    ['the folder-trust dialog (older words)', TRUST_OLD, 'trust'],
    ['the folder-trust dialog (newer words)', TRUST_NEW, 'trust'],
    ['a tool permission (Bash)', PERMISSION, 'permission'],
    ['an edit permission', EDIT, 'permission'],
    ['an AskUserQuestion', QUESTION, 'question'],
    ['a plan approval', PLAN, 'plan'],
  ] as const)('%s → %s', (_n, s, kind) => {
    expect(claudeDialogOnScreen(s)).toBe(kind)
  })

  it.each([
    ['the normal prompt after a reply with a numbered list', PROMPT],
    ['a reply quoting a dialog above the live prompt', PROMPT_QUOTING_A_DIALOG],
    ['the input line holding «1. foo»', PROMPT_TYPING_A_NUMBER],
    ['an OpenCode screen', OPENCODE],
    ['an empty screen', ''],
    ['blank lines only', '\n\n\n'],
  ] as const)('%s → null (passes)', (_n, s) => {
    expect(claudeDialogOnScreen(s)).toBeNull()
  })

  it('a pointer list with no known words and no hint is unknown → passes', () => {
    expect(claudeDialogOnScreen(screen(' Pick one', ' ❯ 1. Alpha', '   2. Beta'))).toBeNull()
  })

  it('an unnamed list that says «Enter to confirm» is a dialog', () => {
    expect(claudeDialogOnScreen(screen(' Pick one', ' ❯ 1. Alpha', '   2. Beta', ' Enter to confirm · Esc to cancel'))).toBe('question')
  })

  it('a dialog already answered and scrolled far above the live area passes', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `● line ${i}`)
    expect(claudeDialogOnScreen([TRUST_OLD, ...filler].join('\n'))).toBeNull()
  })

  it('the pointer on a later option still reads', () => {
    expect(claudeDialogOnScreen(screen(' Do you want to proceed?', '   1. Yes', ' ❯ 2. No'))).toBe('permission')
  })
})

describe('the contract', () => {
  it('Claude Code declares it; OpenCode (prompts over its HTTP API) never blocks', () => {
    expect(fallbackHarness().console.dialogOnScreen).toBe(claudeDialogOnScreen)
    expect(harnessById('opencode').console.dialogOnScreen).toBeUndefined()
  })
})
