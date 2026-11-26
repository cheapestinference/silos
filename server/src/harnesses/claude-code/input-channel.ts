// input-channel.ts — the prompt of an interactive chat turn as a stream the
// owner can still write into while the turn runs (the SDK's streaming input:
// prompt: AsyncIterable<SDKUserMessage>). The first message is the turn's
// text; a later push is delivered at the turn's next step (priority 'next'),
// as a console delivers what is typed while it works. The stream ends when
// the turn does (close): the process then sees its input end and exits, so
// a turn stays one turn. A push after close is refused — the caller queues it.

export interface StreamedUserMessage {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  priority?: 'next'
}

export interface InputChannel {
  /** what query() takes as its prompt (`first`: the text the turn starts with) */
  readonly iterable: AsyncIterable<StreamedUserMessage> & { readonly first: string }
  /** the owner's message for the running turn; false once closed */
  push(text: string): boolean
  /** no more input: the stream ends after what is already pushed */
  close(): void
  readonly closed: boolean
}

export function inputChannel(first: string): InputChannel {
  const pending: StreamedUserMessage[] = [{ type: 'user', message: { role: 'user', content: first }, parent_tool_use_id: null }]
  let closed = false
  let wake: (() => void) | null = null
  const nudge = (): void => {
    const w = wake
    wake = null
    w?.()
  }
  const iterable: AsyncIterable<StreamedUserMessage> & { readonly first: string } = {
    first,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = pending.shift()
        if (next) {
          yield next
          continue
        }
        if (closed) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
  return {
    iterable,
    push(text: string): boolean {
      if (closed || text.trim() === '') return false
      pending.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, priority: 'next' })
      nudge()
      return true
    },
    close(): void {
      if (closed) return
      closed = true
      nudge()
    },
    get closed() {
      return closed
    },
  }
}

/** The text a turn starts with, whichever prompt it was handed — what a
 *  reader of the query's args (a test, a log) asks. */
export function promptText(prompt: unknown): string | null {
  if (typeof prompt === 'string') return prompt
  const first = (prompt as { first?: unknown } | null)?.first
  return typeof first === 'string' ? first : null
}
