// harnesses/claude-code/dialogs.ts — does the Claude Code TUI show a dialog
// right now? Read from the console's screen (tmux capture-pane), before
// Silos types a prompt + Enter into it: with a dialog open that Enter picks
// the highlighted option (once it chose «No, exit» on the folder-trust
// dialog and the console closed without a trace).
//
// CONSERVATIVE by contract (HarnessConsole.dialogOnScreen): a dialog is
// said only when the screen's tail carries BOTH
//  · a choice list — the selection pointer «❯» on a numbered option
//    («❯ 1. Yes») and the next (or previous) number a few lines away, and
//  · a known marker: a phrase of one of the TUI's own dialogs, or its
//    footer hint («Enter to confirm», «Esc to cancel», «Enter to select»),
// and the normal prompt's footer («? for shortcuts») is NOT drawn below the
// list. Anything else — an unknown screen, an empty one, a version whose
// words changed — passes: a missed dialog is the old behaviour, a false
// block would break every send.
import type { ConsoleDialog } from '../contract.js'

// How far up the dialog may start: the live area is the screen's bottom,
// what is above it is scrollback that was already answered.
const TAIL_LINES = 40

// The choice list: the pointer on a numbered option, and a plain one.
const POINTER_OPTION = /^\s*❯\s*(\d+)\.\s+\S/
const PLAIN_OPTION = /^\s*(\d+)\.\s+\S/
// an option's neighbour sits this close (an option may carry a
// description line or two under it)
const NEIGHBOUR_LINES = 8
// The normal input's footer: below a list, the list is a reply's text.
const PROMPT_FOOTER = /\? for shortcuts/

// Markers, in the order they classify (first match wins). Matched on the
// tail joined into one line (a phrase may wrap on a narrow pane).
const MARKERS: ReadonlyArray<readonly [ConsoleDialog, RegExp]> = [
  ['trust', /Do you trust the files in this folder\?|Is this a project you (?:created|trust)|Yes, I trust this folder|Accessing workspace:/i],
  ['plan', /Would you like to proceed\?.*(?:keep planning|auto-accept edits|manually approve edits)|Ready to code\?/i],
  ['permission', /Do you want to (?:proceed|make this edit|create|allow|delete|overwrite|run)\b|Yes, and don't ask again/i],
  ['question', /Enter to select|Type something\.|Chat about this|Submit answers/i],
]
const HINT = /Enter to confirm|Esc to (?:cancel|exit)|Enter to select/i

// box-drawing borders and frame glyphs, so `│ ❯ 1. Yes │` reads as an option
const FRAME = /[│┃║╭╮╰╯─━═┌┐└┘]/g

export function claudeDialogOnScreen(screen: string): ConsoleDialog | null {
  if (typeof screen !== 'string' || screen === '') return null
  const lines = screen.split('\n').map((l) => l.replace(FRAME, ' ').trimEnd())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const tail = lines.slice(-TAIL_LINES)

  // the live list is the lowest one
  let pointer = -1
  for (let i = tail.length - 1; i >= 0 && pointer < 0; i--) if (POINTER_OPTION.test(tail[i]!)) pointer = i
  if (pointer < 0) return null
  const n = Number(POINTER_OPTION.exec(tail[pointer]!)![1])
  const numberAt = (i: number): number | null => {
    const m = PLAIN_OPTION.exec(tail[i] ?? '')
    return m ? Number(m[1]) : null
  }
  let neighbour = false
  for (let d = 1; d <= NEIGHBOUR_LINES && !neighbour; d++) {
    neighbour = numberAt(pointer + d) === n + 1 || numberAt(pointer - d) === n - 1
  }
  if (!neighbour) return null
  if (tail.slice(pointer + 1).some((l) => PROMPT_FOOTER.test(l))) return null

  const text = tail.join(' ').replace(/\s+/g, ' ')
  for (const [kind, re] of MARKERS) if (re.test(text)) return kind
  // an unnamed dialog that still says how it is answered: Enter would pick
  return HINT.test(text) ? 'question' : null
}
