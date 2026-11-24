// RunsOnCard.tsx — what the agent runs on, the second card of its Settings:
// its engine, model, provider, the voice it answers in, the folders it
// works in, and its territory with its token. Read first; Edit swaps the
// editor in for the body, in this card (the values were shown on a
// «Runs on» sub-tab whose Edit jumped to Identity's form — a value is
// edited where it is shown). Its territory is switched on its line — the
// same write as the roster's row (Settings › Territory), which stays the
// fleet's view of the three surfaces and the door for network and paths.
import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { modelLabel, providerRunsOn } from '../../lib/runs-on'
import { territoriesOf } from '../../lib/territory'
import { useHarness } from '../../lib/harnesses'
import { FenceScopeLines } from '../FenceScope'
import { Section, SectionAction } from './Section'
import { SettingsTab } from './SettingsTab'
import type { AgentTerritory, AgentView } from '../../lib/types'

export function RunsOnCard({ agent, editing, onEditingChange }: { agent: AgentView; editing: boolean; onEditingChange: (v: boolean) => void }) {
  const changePage = useStore((s) => s.changePage)
  const providers = useStore((s) => s.providers)
  const catalog = useStore((s) => s.catalog)
  const engine = useHarness(agent.framework)
  // the fence as the engines launch it (GET /api/agents/:id/territory) —
  // null while loading or when the server has no territory route
  const [territory, setTerritory] = useState<AgentTerritory | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.agents.territory(agent.id))
      .then((t) => {
        if (!cancelled) setTerritory(t ?? null)
      })
      .catch(() => {
        if (!cancelled) setTerritory(null)
      })
    return () => {
      cancelled = true
    }
  }, [agent.id, agent.folder, agent.folders])
  const [rotate, setRotate] = useState<'idle' | 'rotating' | 'done' | 'error'>('idle')
  useEffect(() => {
    setRotate('idle')
  }, [agent.id])
  async function rotateToken(): Promise<void> {
    setRotate('rotating')
    try {
      await api.agents.rotateToken(agent.id)
      setRotate('done')
    } catch {
      setRotate('error')
    }
  }
  const also = territoriesOf(agent).filter((t) => t !== agent.folder)
  const toRoster = (): void => changePage({ kind: 'settings', tab: 'territory' })
  // the switch: this agent in or out of the fenced list — read fresh, so a
  // change made on the roster meanwhile is never undone by this one
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  async function setFence(on: boolean): Promise<void> {
    setSwitching(true)
    setSwitchError(null)
    try {
      const now = (await api.territory.get()).enabled ?? []
      await api.territory.setEnabled(on ? [...new Set([...now, agent.id])] : now.filter((x) => x !== agent.id))
      setTerritory((await api.agents.territory(agent.id)) ?? null)
      void useStore.getState().loadOverview()
    } catch (e) {
      setSwitchError(e instanceof Error ? e.message : String(e))
    } finally {
      setSwitching(false)
    }
  }
  const term = 'text-[12px] text-ink-3'
  const value = 'min-w-0 text-[13px] text-ink'

  return (
    <Section
      id="runs-on"
      label="Runs on"
      action={
        editing ? null : (
          <SectionAction onClick={() => onEditingChange(true)} ariaLabel="Edit what it runs on">
            Edit
          </SectionAction>
        )
      }
    >
      {editing ? (
        <SettingsTab agent={agent} inline fields="runs" onDone={() => onEditingChange(false)} />
      ) : (
        <>
          <dl className="grid grid-cols-1 items-baseline gap-x-3 gap-y-0.5 sm:grid-cols-[6.5rem_1fr] sm:gap-y-1.5">
            <dt className={term}>Engine</dt>
            <dd className={value}>{engine.label}</dd>
            <dt className={term}>Model</dt>
            <dd className={`${value} truncate`} data-testid="runs-on-model">
              {modelLabel(catalog, agent.model)}
            </dd>
            <dt className={term}>Provider</dt>
            <dd className={`${value} truncate`}>{providerRunsOn(providers, agent)}</dd>
            {engine.caps.outputStyles ? (
              <>
                <dt className={term}>Answers in</dt>
                <dd className={`${value} truncate ${agent.outputStyle ? '' : 'text-ink-2'}`} data-testid="runs-on-style">
                  {agent.outputStyle ? (agent.outputStyle === 'default' ? 'Default' : agent.outputStyle) : 'your Claude Code setting'}
                </dd>
              </>
            ) : null}
            <dt className={term}>Folder</dt>
            <dd className={`${value} truncate font-mono text-[12px]`} title={agent.folder ?? undefined}>
              {agent.folder ?? 'any project'}
            </dd>
            {also.length > 0 ? (
              <>
                <dt className={term}>Also works in</dt>
                <dd className={`${value} flex flex-col font-mono text-[12px]`}>
                  {also.map((t) => (
                    <span key={t} className="truncate" title={t}>
                      {t}
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
            {territory ? (
              <>
                <dt className={term}>Territory</dt>
                <dd className={value} data-testid="runs-on-territory" title={territory.fenced ? `${territory.deny} deny rules` : undefined}>
                  {territory.territories.length === 0 ? (
                    <span className="text-ink-2">None — without a folder it works anywhere</span>
                  ) : (
                    <>
                      {territory.fenced ? 'On' : <span className="text-terracotta">Off</span>}
                      {' · '}
                      <button
                        type="button"
                        disabled={switching}
                        onClick={() => void setFence(!territory.fenced)}
                        data-testid="runs-on-territory-switch"
                        className={
                          territory.fenced
                            ? 'text-[12px] text-ink-2 hover:text-terracotta disabled:opacity-50'
                            : 'text-[12px] font-medium text-terracotta underline-offset-2 hover:underline disabled:opacity-50'
                        }
                      >
                        {territory.fenced ? 'Turn off' : 'Turn on'}
                      </button>
                      {' · '}
                      <button type="button" onClick={toRoster} className="text-[12px] text-ink-2 hover:text-terracotta">
                        Network and private paths ›
                      </button>
                    </>
                  )}
                  {switchError ? (
                    <span role="alert" className="block text-[12px] text-terracotta">
                      {switchError}
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
            {territory?.fenced ? (
              <>
                <dt className={term}>Token</dt>
                <dd className={`${value} flex flex-wrap items-baseline gap-x-2`}>
                  <span className="text-ink-2">its identity on Silos' API</span>
                  <button
                    type="button"
                    onClick={() => void rotateToken()}
                    disabled={rotate === 'rotating'}
                    className="text-[12px] text-ink-2 hover:text-terracotta disabled:opacity-50"
                  >
                    Rotate
                  </button>
                  {rotate === 'done' ? <span className="text-[12px] text-ink-2">Rotated — restart its console for the new token</span> : null}
                  {rotate === 'error' ? (
                    <span role="alert" className="text-[12px] text-terracotta">
                      The token didn’t rotate — try again
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
          </dl>
          {territory?.scope && territory.territories.length > 0 ? (
            <div className="mt-3 rounded-md border border-line/70 px-3 py-2.5" data-testid="runs-on-fence-scope">
              <FenceScopeLines scope={territory.scope} on={territory.fenced} kept preview />
            </div>
          ) : null}
        </>
      )}
    </Section>
  )
}
