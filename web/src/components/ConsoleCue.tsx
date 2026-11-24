// ConsoleCue.tsx — the sentence a new real console was opened to send
// (store consoleCue: «Sign in ›» on a Tools row that waits), in a slim strip
// above the pane, with a copy button. Claude Code has no documented way to
// prefill an interactive prompt without sending it, and Silos never types
// into a console for the owner: the owner pastes it and presses Enter.
// The second line is the step after: the engine's sign-in link redirects
// to localhost on the machine running Claude Code, so a browser elsewhere
// ends on a connection error — its address goes back into the console.
import { useState, type ReactElement } from 'react'
import { Check, Copy, X } from 'lucide-react'

export function ConsoleCue({ text, onDrop }: { text: string; onDrop: () => void }): ReactElement {
  const [copied, setCopied] = useState(false)
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return // no clipboard (an http origin): the sentence is selectable
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div data-testid="console-cue" className="shrink-0 border-b border-line bg-panel px-4 py-2 text-[12px] leading-snug text-ink-2">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1">
          <span className="text-ink-3">Send this in the console: </span>
          <span data-testid="console-cue-text" className="select-all break-words font-mono text-[11.5px] text-ink">
            {text}
          </span>
        </p>
        <button
          type="button"
          onClick={() => void copy()}
          data-testid="console-cue-copy"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-veil-dark/[0.05] hover:text-terracotta"
        >
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDrop} aria-label="Hide this sentence" className="shrink-0 rounded-md p-0.5 text-ink-3 hover:text-ink">
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      <p className="mt-0.5 text-ink-3">
        Claude gives you a link to open. If your browser ends on a connection error, copy its full address and paste it back into the console.
      </p>
    </div>
  )
}
