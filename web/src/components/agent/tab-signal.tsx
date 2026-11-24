// tab-signal.tsx — an agent tab's signal (lib/agent-tabs.ts) as the tab bar
// and the header's tab menu draw it: the live dot, or the figure (terracotta
// when it waits on someone).
import type { ReactNode } from 'react'
import type { AgentTabSignal } from '../../lib/agent-tabs'

export function tabSignal(s: AgentTabSignal): ReactNode {
  if (s === null) return null
  if (s.kind === 'dot') return <span aria-label="working" className="inline-block h-1.5 w-1.5 rounded-full bg-terracotta" />
  return s.accent ? <span className="text-terracotta">{s.text}</span> : s.text
}
