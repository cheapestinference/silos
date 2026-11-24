// task-native-bind.ts — a console key written on a task before its engine
// sealed the conversation's native id (OpenCode: the console key, then its
// `ses_…`) gets that id listed beside it (OpenCode):
//   - on the neutral `native-bound(key, id)` event of TerminalService
//     (bindNativeId, only for a NEW pair with key ≠ id), and
//   - once, when the index is warm and Plans reads (the rehydrations of a
//     restart bind before the Plans reading is ready).
// The append is the plans verb's own (idempotent: an id already listed is
// not added twice). Neutral: no engine named, Plans reached only through
// the tasks and the append it is handed.
export interface ListedTask {
  key: string
  conversations: readonly string[]
}

// the tasks listing `key` and not yet `id` → the id appended to each
export function bindNativeOnTasks(tasks: readonly ListedTask[], key: string, id: string, append: (taskKey: string, sessionId: string) => void): string[] {
  if (key === id || key === '' || id === '') return []
  const out: string[] = []
  for (const t of tasks) {
    if (!t.conversations.includes(key) || t.conversations.includes(id)) continue
    append(t.key, id)
    out.push(t.key)
  }
  return out
}

// the one pass: every listed id whose native id is known and not listed
export function nativeBindPass(
  tasks: readonly ListedTask[],
  nativeIdOf: (key: string) => string | null,
  append: (taskKey: string, sessionId: string) => void,
): number {
  let n = 0
  for (const t of tasks) {
    for (const c of t.conversations) {
      const id = nativeIdOf(c)
      if (!id || id === c || t.conversations.includes(id)) continue
      append(t.key, id)
      n++
    }
  }
  return n
}
