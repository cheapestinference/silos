// pass.ts — what is read once per SYNCHRONOUS pass (a live
// profile showed every task's flow was evaluated three to five times inside one
// tick — the inbox, Task mode's look, the escalation, the board — and the
// event loop the owner's consoles ride on froze for hundreds of ms).
//
// A pass is one synchronous stretch of the event loop: it ends at the next
// microtask, so nothing kept here survives an `await`, a timer, a file event
// or a request — what the next pass reads is computed anew. Inside a pass a
// WRITER ends it early (`endPass()`): whatever was read before the write is
// never handed out after it. The writers of the facts a task's flow reads
// call it — Task mode's store and its turns in flight, the agent registry,
// the territory store, the kernel's refresh, the thread cache's drop.
//
// The ONE mechanism for «compute once, never stale across an await»: the
// task flows (silos/task-flow.ts) and the task snapshots (index.ts) both
// keep their pass here, never in a cache of their own.

let gen = 0
let armed = false

/** The current pass. Reading it arms the pass's end at the next microtask. */
export function passGeneration(): number {
  if (!armed) {
    armed = true
    queueMicrotask(() => {
      armed = false
      gen++
    })
  }
  return gen
}

/** A writer inside the pass: what was read before it is read again. */
export function endPass(): void {
  gen++
}

/** A value computed at most once per pass; `drop()` forgets it now. */
export function perPass<T>(compute: () => T): { get(): T; drop(): void } {
  let at = -1
  let value: T | undefined
  return {
    get(): T {
      const g = passGeneration()
      if (at !== g) {
        value = compute()
        // a write inside compute ended the pass: the value is not this pass's
        at = g === gen ? g : -1
      }
      return value as T
    },
    drop(): void {
      at = -1
    },
  }
}
