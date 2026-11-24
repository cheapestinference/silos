// build.ts — "is the bundle I'm running the one the server serves?"
//
// Root cause this exists for: Silos is served as a static dist and a tab
// can live for days. Every `vite build` leaves open tabs executing old
// code against fresh data — which reads as bugs that don't exist (three
// "broken" reports once turned out to be one stale tab). The tab
// can't be pushed a fix, but it CAN know it's stale: compare the id this
// bundle was built with against the id the server says it serves
// (/api/overview `build`), and offer a reload. Same principle as live.ts:
// no pushed "you're current" state — two verifiable facts compared at
// look-time.
declare const __BUILD_ID__: string | undefined

// stamped by vite.config.ts (define). 'dev' under the dev server; absent
// (null) only in environments without the define (vitest without config).
export const ownBuild: string | null = typeof __BUILD_ID__ === 'undefined' ? null : __BUILD_ID__

export function updateAvailable(own: string | null, server: string | undefined): boolean {
  // 'dev': HMR already keeps the page current, and the dev proxy talks to
  // a server whose dist id would ALWAYS mismatch — never banner there.
  return own !== null && own !== 'dev' && server !== undefined && server !== own
}
