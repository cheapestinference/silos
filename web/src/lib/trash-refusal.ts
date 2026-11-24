// trash-refusal.ts — reading the trash route's 409 when a claude outside
// Silos still holds the conversation. The server names where it lives in
// `error` and hands the holders back structured with `canClose`; the client
// turns that into "the message + a Close-and-delete action" (ErrorStrip's
// errorAction). Any other failure is just its message.
export interface TrashHolder {
  pid: number
  tmux: string | null
  name: string | null
}

export interface TrashRefusal {
  message: string
  holders: TrashHolder[]
  canClose: boolean
}

// duck-typed on ApiError's shape (status + body), not `instanceof`: the
// api module is mocked wholesale in component tests
export function trashRefusalOf(e: unknown): TrashRefusal | null {
  if (typeof e !== 'object' || e === null || (e as { status?: unknown }).status !== 409) return null
  const body = (e as { body?: unknown }).body
  const message = e instanceof Error ? e.message : String((e as { message?: unknown }).message ?? 'refused')
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { holders?: unknown }).holders)) return null
  const raw = (body as { holders: unknown[]; canClose?: unknown }).holders
  const holders: TrashHolder[] = []
  for (const h of raw) {
    if (typeof h !== 'object' || h === null || typeof (h as { pid?: unknown }).pid !== 'number') continue
    const o = h as { pid: number; tmux?: unknown; name?: unknown }
    holders.push({ pid: o.pid, tmux: typeof o.tmux === 'string' ? o.tmux : null, name: typeof o.name === 'string' ? o.name : null })
  }
  if (holders.length === 0) return null
  return { message, holders, canClose: (body as { canClose?: unknown }).canClose === true }
}

/** the button's label: one holder → "Close it and delete", several → "Close them and delete" */
export function closeAndDeleteLabel(r: TrashRefusal, verb = 'delete'): string {
  return `Close ${r.holders.length === 1 ? 'it' : 'them'} and ${verb}`
}
