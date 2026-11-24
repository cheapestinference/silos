// leave-guard.ts — "Discard changes?" for any way out of a page with
// unsaved work (e.g. the automation editor). Navigation in Silos is
// the store's `page` — every gesture (a sidebar click, ⌘K, back/forward
// through the router, a deep link) ends in a set() that changes it. While a
// guard is armed, the store (see guardedSet in store.ts) holds back the
// first set() that would move `page` AND every set() of the same tick (a
// composite gesture settles in one tick — see router.ts), and hands the
// held patches to the guard instead of applying them. The guard asks
// inline; "Discard" disarms it and replays the destination through the
// router (the URL it would have reached), "Keep editing" drops them.
//
// No dependencies: store.ts imports this, the guarding component imports
// both — no cycle.
export interface LeaveGuard {
  // called once per held gesture, after its tick settles, with the held
  // patches in order
  onBlocked(patches: readonly Record<string, unknown>[]): void
}

let current: LeaveGuard | null = null

export function armLeaveGuard(g: LeaveGuard): () => void {
  current = g
  return () => {
    if (current === g) current = null
  }
}

export function activeLeaveGuard(): LeaveGuard | null {
  return current
}

// tests only
export function __resetLeaveGuard(): void {
  current = null
}
