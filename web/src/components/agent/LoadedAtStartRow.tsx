// LoadedAtStartRow.tsx — Knows & can › Loaded at start: what every
// conversation of the agent receives before its first message, as its
// engine reads it from disk (GET /api/agents/:id/loaded). An observed view:
// nothing here is a switch (capability states live with Skills and the
// project's Tools). Four parts, each drawn only when it has something:
//   · injected by start hooks — one line per plugin / settings file / Silos,
//     with what its last observed start added (a hairline as long as its
//     share, and the opening words), or "not seen yet";
//   · instructions — one door line to Memory, their one house (count,
//     ≈ tokens at start, how many load only in a subfolder);
//   · output style — the setting, or the plugin standing in for one;
//   · MCP servers — configured, from plugins (folded), claude.ai connectors
//     as seen in its conversations — with ONE door to the project's Tools,
//     where they are governed.
// What a plugin the Claude account sends brings (its start hooks, its MCP
// servers) is drawn under «Claude account · <login>», never as the
// machine's; a plugin's placeholder entries and the servers it shares with
// another plugin are said quietly, apart from its servers of its own.
// The engine can't say (null) → the row is not drawn at all (KnowsCard).
import { useState } from 'react'
import { basename } from '../../lib/routes'
import { useGoHome } from '../knows/go-home'
import type { LoadedAtStart, LoadedInjection } from '../../lib/types'
import { approxTokens } from '../../lib/knows-anatomy'
import {
  formatChars,
  injectionRows,
  instructionGroups,
  mcpGroups,
  observedTotal,
  serverCounts,
  type InjectionRow,
  type PluginServers,
} from '../../lib/loaded-at-start'
import type { ScopeId } from '../knows/ScopePill'
import { OwnerLabel } from '../OwnerLabel'

const ORIGIN: Record<LoadedInjection['origin'], { scope: ScopeId; label: string; title: string }> = {
  silos: { scope: 'global', label: 'Silos', title: "Silos' own plugin: the briefing, the fleet roster and its unread messages" },
  plugin: { scope: 'global', label: 'plugin', title: 'An enabled Claude Code plugin — it runs in every folder' },
  user: { scope: 'global', label: 'your settings', title: 'A hook in your own settings — it runs in every folder' },
  managed: { scope: 'global', label: 'managed', title: "The machine's managed settings" },
  project: { scope: 'project', label: 'this folder', title: "The folder's .claude/settings.json" },
  local: { scope: 'project', label: 'this folder', title: "The folder's .claude/settings.local.json" },
}

function Part({ label, aside, children }: { label: string; aside?: string | null; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <h5 className="text-[12px] font-medium text-ink-2">{label}</h5>
        {aside ? <span className="ml-auto text-[11px] tabular-nums text-ink-3">{aside}</span> : null}
      </div>
      {children}
    </div>
  )
}

function Fold({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="text-[12px] text-ink-2 hover:text-terracotta">
      {children}{' '}
      <span aria-hidden="true" className="text-ink-3">
        {open ? '‹' : '›'}
      </span>
    </button>
  )
}

function InjectionLine({ row, max }: { row: InjectionRow; max: number }) {
  const o = ORIGIN[row.origin]
  const when = row.on.length > 0 ? `on ${row.on.join(', ')}` : null
  const share = row.chars !== null && max > 0 ? Math.max(row.chars / max, row.chars > 0 ? 0.015 : 0) : 0
  return (
    <li className="py-1.5 first:pt-0" data-testid="loaded-injection" title={`${row.commands.join('\n')}\n— declared in ${row.files.join(', ')}`}>
      <div className="flex items-baseline gap-2">
        <span className={`min-w-0 truncate font-mono text-[12px] ${row.offBySilos ? 'text-ink-3 line-through decoration-ink-3/60' : 'text-ink'}`}>
          {row.name}
        </span>
        {/* where it comes from, in words; the group's head says its origin */}
        <span className="shrink-0 text-[11px] text-ink-3" title={o.title}>
          {o.label}
        </span>
        {row.hooks > 1 ? <span className="shrink-0 text-[11px] text-ink-3">{row.hooks} hooks</span> : null}
        <span className="ml-auto shrink-0 text-right text-[11px] tabular-nums text-ink-3">
          {when ? <span className="mr-2">{when}</span> : null}
          {row.failed ? (
            <span className="text-terracotta">failed at its last start</span>
          ) : row.chars === null ? (
            row.unseenIn !== null ? (
              <span
                title={`Not recorded in the last ${row.unseenIn} start${row.unseenIn === 1 ? '' : 's'} — Claude Code keeps a start hook only when it prints`}
              >
                prints nothing
              </span>
            ) : (
              'not seen yet'
            )
          ) : row.chars === 0 ? (
            'adds nothing'
          ) : (
            formatChars(row.chars)
          )}
        </span>
      </div>
      {row.chars !== null && row.chars > 0 ? (
        <div className="mt-1 h-[2px] overflow-hidden rounded-full bg-line/60" aria-hidden="true">
          <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: `var(--scope-${o.scope})` }} />
        </div>
      ) : null}
      {row.excerpt ? (
        <p className="mt-1 truncate text-[12px] italic text-ink-3" title={row.excerpt}>
          “{row.excerpt}”
        </p>
      ) : null}
      {row.offBySilos ? (
        <p className="mt-0.5 text-[11px] text-ink-2">Off in the conversations Silos starts — the agent's output style below replaces it.</p>
      ) : row.outputStyle ? (
        <p className="mt-0.5 text-[11px] text-ink-2">Stands in for an output style — it tells the agent how to write every reply.</p>
      ) : null}
    </li>
  )
}

/** «From Your Claude account · sam@example.com», or the type alone when the login is unknown. */
function AccountHead({ login }: { login: string | null }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <OwnerLabel owner="account" ctx={login ? { accountName: login } : {}} size="sm" from />
      {login ? null : <span className="text-[11px] text-ink-3">a login Silos can't name yet</span>}
    </span>
  )
}

const PLACEHOLDER_TITLE =
  'A placeholder: the plugin declares it with no address and leaves this tool to a connector of your Claude account — not a server of its own'

/** The folded body of «N from M plugins»: one line per plugin, its servers
 *  of its own first, then the entries that are not (placeholders, and
 *  copies of a server another plugin already connects). */
function PluginServerList({ plugins }: { plugins: PluginServers[] }) {
  return (
    <ul className="mt-1.5 space-y-0.5 border-l border-line pl-3">
      {plugins.map((p) => {
        const own = p.servers.filter((m) => !m.placeholder && !m.sameAs)
        const quiet = p.servers.filter((m) => m.placeholder || m.sameAs)
        return (
          <li key={p.plugin} className="flex items-baseline gap-2">
            <span className="shrink-0 text-ink-2">{p.plugin}</span>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono text-[11px]">
              {own.map((m) => (
                <span key={m.name} className="text-ink-3" title={m.engineName ?? m.name}>
                  {m.name}
                </span>
              ))}
              {quiet.map((m) => (
                <span
                  key={m.name}
                  className="text-ink-3/60 underline decoration-dotted decoration-ink-3/40 underline-offset-2"
                  title={m.placeholder ? PLACEHOLDER_TITLE : `The same server as ${m.sameAs} — one address, which Claude Code connects once`}
                >
                  {m.name}
                </span>
              ))}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** «9 from 3 plugins», then what is not a server of its own, quietly. */
function pluginsSummary(plugins: PluginServers[]): { lead: string; aside: string | null } {
  const c = serverCounts(plugins.flatMap((p) => p.servers))
  const aside = [
    c.placeholders > 0 ? `${c.placeholders} ${c.placeholders === 1 ? 'placeholder' : 'placeholders'}` : null,
    c.shared > 0 ? `${c.shared} shared with another plugin` : null,
  ]
    .filter(Boolean)
    .join(', ')
  return { lead: `${c.own} from ${plugins.length === 1 ? 'a plugin' : `${plugins.length} plugins`}`, aside: aside || null }
}

export function LoadedAtStartRow({
  loaded,
  agentName,
  folder = null,
  onOpenMemory,
}: {
  loaded: LoadedAtStart
  agentName: string
  folder?: string | null
  onOpenMemory: () => void
}) {
  const goHome = useGoHome()
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState<string | null>(null)

  const rows = injectionRows(loaded.injections)
  const total = observedTotal(rows)
  const max = Math.max(0, ...rows.map((r) => r.chars ?? 0))
  const { atStart, onDemand } = instructionGroups(loaded.instructions)
  const mcp = mcpGroups(loaded.mcp)
  const pluginServers = mcp.plugins.reduce((n, p) => n + p.servers.length, 0)
  const machinePlugins = pluginsSummary(mcp.plugins)
  // the account's hooks, one group per login (its owner, not the machine)
  const accountLogins = [...new Set(rows.filter((r) => r.account).map((r) => r.account!.login))]
  const styleStandIns = rows.filter((r) => r.outputStyle && !r.offBySilos)

  return (
    <div data-testid="loaded-at-start">
      <p className="mb-3 text-[13px] text-ink-2">
        What every conversation of {agentName} receives before its first message, as {loaded.engine} loads it — read from disk, never run.
      </p>

      <div className="divide-y divide-line/50 [&>*]:py-3 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        {rows.length > 0 ? (
          <Part label="Injected by start hooks" aside={total !== null ? `${formatChars(total)} at its last start` : null}>
            {(['global', 'project'] as const).map((scope) => {
              const inScope = rows.filter((r) => !r.account && ORIGIN[r.origin].scope === scope)
              if (inScope.length === 0) return null
              return (
                <div key={scope} className="mt-2 first:mt-0">
                  {/* the group's origin, in the one label grammar (no pill) */}
                  <div className="mb-1">
                    <OwnerLabel owner={scope === 'global' ? 'you' : 'project'} ctx={{ folder: folder ?? null }} size="sm" from />
                  </div>
                  <ul>
                    {inScope.map((r) => (
                      <InjectionLine key={r.key} row={r} max={max} />
                    ))}
                  </ul>
                </div>
              )
            })}
            {accountLogins.map((login) => (
              <div key={`account:${login ?? ''}`} className="mt-2 first:mt-0" data-testid="loaded-account-hooks">
                <div className="mb-1">
                  <AccountHead login={login} />
                </div>
                <ul>
                  {rows
                    .filter((r) => r.account && r.account.login === login)
                    .map((r) => (
                      <InjectionLine key={r.key} row={r} max={max} />
                    ))}
                </ul>
              </div>
            ))}
          </Part>
        ) : null}

        {loaded.instructions.length > 0 ? (
          // instruction files have one house, Memory (spec memory-places §5):
          // here one door line with the count and what they weigh at start
          <Part label="Instructions">
            <button
              type="button"
              data-testid="at-start-instructions"
              onClick={onOpenMemory}
              className="text-left text-[12.5px] text-ink-2 hover:text-terracotta"
            >
              {loaded.instructions.length} {loaded.instructions.length === 1 ? 'file' : 'files'}
              {atStart.length > 0 ? <> · ≈ {approxTokens(atStart.reduce((n, i) => n + i.bytes, 0))} tokens at start</> : null}
              {onDemand.length > 0 ? <> · {onDemand.length} when it works in a subfolder</> : null}
              <span className="text-ink"> · Memory ›</span>
            </button>
          </Part>
        ) : null}

        {loaded.outputStyle || styleStandIns.length > 0 ? (
          <Part label="Output style">
            {loaded.outputStyle ? (
              <p className="text-[12px] text-ink">
                <span className="font-mono">{loaded.outputStyle.name}</span>
                <span className="text-ink-3">
                  {' '}
                  — {loaded.outputStyle.silos ? `${loaded.outputStyle.from}; a conversation can pin its own in Run on…` : `set in ${loaded.outputStyle.from}`}
                </span>
              </p>
            ) : (
              <p className="text-[12px] text-ink-2">
                None set; <span className="font-mono text-ink">{styleStandIns.map((r) => r.name).join(', ')}</span>{' '}
                {styleStandIns.length === 1 ? 'acts as one' : 'act as one'}, through its start hook above.
              </p>
            )}
          </Part>
        ) : null}

        {loaded.mcp.length > 0 ? (
          <Part label="MCP servers">
            <div className="space-y-1.5 text-[12px]">
              {mcp.own.length > 0 ? (
                <p className="flex flex-wrap items-baseline gap-x-2">
                  {mcp.own.map((m) => (
                    <span key={`agent:${m.name}`} className="font-mono text-ink" title={`only ${agentName}`}>
                      {m.name}
                    </span>
                  ))}
                  <span className="text-ink-3">its own — only {agentName}</span>
                </p>
              ) : null}
              {mcp.configured.length > 0 ? (
                <p className="flex flex-wrap items-baseline gap-x-2">
                  {mcp.configured.map((m) => (
                    <span
                      key={`${m.source}:${m.name}`}
                      className="font-mono text-ink"
                      title={`${m.from}${m.source === 'user' ? ' — every folder' : ' — this folder'}`}
                    >
                      {m.name}
                    </span>
                  ))}
                  <span className="text-ink-3">configured for {mcp.configured.every((m) => m.source === 'project') ? 'this folder' : 'its sessions'}</span>
                </p>
              ) : null}
              {pluginServers > 0 ? (
                <div>
                  <Fold open={pluginsOpen} onToggle={() => setPluginsOpen((v) => !v)}>
                    {machinePlugins.lead}
                  </Fold>
                  {machinePlugins.aside ? <span className="ml-2 text-[11px] text-ink-3">{machinePlugins.aside}</span> : null}
                  {pluginsOpen ? <PluginServerList plugins={mcp.plugins} /> : null}
                </div>
              ) : null}
              {mcp.accountPlugins.map((g) => {
                const key = g.login ?? ''
                const sum = pluginsSummary(g.plugins)
                return (
                  <div key={`account:${key}`} data-testid="loaded-account-plugins">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <Fold open={accountOpen === key} onToggle={() => setAccountOpen((v) => (v === key ? null : key))}>
                        {sum.lead}
                      </Fold>
                      <AccountHead login={g.login} />
                      {sum.aside ? <span className="text-[11px] text-ink-3">{sum.aside}</span> : null}
                    </div>
                    {accountOpen === key ? <PluginServerList plugins={g.plugins} /> : null}
                  </div>
                )
              })}
              {mcp.account.length > 0 ? (
                <p className="flex flex-wrap items-baseline gap-x-2">
                  {/* known only by the id its tool names carry: shown as that id, never turned back */}
                  {mcp.account.map((m) => (
                    <span key={m.name} className="font-mono text-ink">
                      {m.name}
                    </span>
                  ))}
                  <span className="text-ink-3">claude.ai connectors its conversations used</span>
                </p>
              ) : null}
              {loaded.toolsDoor ? (
                <button
                  type="button"
                  onClick={() => goHome({ kind: 'project', folder: loaded.folder, tab: 'tools' })}
                  className="text-[12px] text-ink-2 hover:text-terracotta"
                  data-testid="loaded-tools-door"
                >
                  Tools in {basename(loaded.folder)} ›
                </button>
              ) : null}
            </div>
          </Part>
        ) : null}
      </div>

      {loaded.notes.length > 0 ? (
        <ul className="mt-3 space-y-0.5 text-[11px] text-ink-3">
          {loaded.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
