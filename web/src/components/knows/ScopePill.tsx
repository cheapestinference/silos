// ScopePill.tsx — the hue pill a secret's scope wears (Vault, an agent's
// Secrets), painted from the --scope-* tokens in theme.css. The colour is a
// second cue; the WORDS carry it, the one label per thing of owners.ts
// (spec scope-ui-review §3.1):
//   global  → «Every agent»     (every agent Silos starts — the Vault's own)
//   project → «Project · acme»
//   auto    → «Project · acme»  (memory the agents write: the same project)
//   agent   → «Agent · Builder»
// A zone labels a GROUP once — never the same pill on every row.

export type ScopeId = 'global' | 'project' | 'auto' | 'agent'

/** The one label per scope, used by pills and their sentences alike. */
export function scopeWords(scope: ScopeId, agentName?: string, projectName?: string | null): string {
  switch (scope) {
    case 'global':
      return 'Every agent'
    case 'project':
    case 'auto':
      return projectName ? `Project · ${projectName}` : 'Its project'
    case 'agent':
      return agentName ? `Agent · ${agentName}` : 'This agent'
  }
}

export function ScopePill({ scope, label }: { scope: ScopeId; label?: string }) {
  return (
    <span
      className="flex-none whitespace-nowrap rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium tracking-[0.02em]"
      style={{ color: `var(--scope-${scope})`, background: `var(--scope-${scope}-soft)` }}
    >
      {label ?? scope}
    </span>
  )
}

/** A 4px stacked bar, each part as wide as its share of the total; zero parts are not drawn. */
export function ScopeBar({ parts }: { parts: { scope: ScopeId; count: number }[] }) {
  const shown = parts.filter((p) => p.count > 0)
  const total = shown.reduce((sum, p) => sum + p.count, 0)
  return (
    <div className="flex overflow-hidden rounded-sm bg-line" style={{ height: '4px' }}>
      {shown.map((p) => (
        <span key={p.scope} data-scope={p.scope} className="h-full" style={{ width: `${(p.count / total) * 100}%`, background: `var(--scope-${p.scope})` }} />
      ))}
    </div>
  )
}
