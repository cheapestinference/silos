// console-dialog.ts — a prompt refused because the console shows a dialog
// (TerminalService.consoleSendLiteral, HarnessConsole.dialogOnScreen): its
// Enter would have picked the highlighted option. Typed so the send route
// answers 409 with the dialog's kind and a background sender skips. A leaf
// (types only besides this class), so an adapter can name it without
// loading terminal-service (and node:child_process with it).
import type { ConsoleDialog } from './harnesses/contract.js'

export class ConsoleDialogError extends Error {
  constructor(readonly dialog: ConsoleDialog) {
    super('the console is showing a dialog')
  }
}
