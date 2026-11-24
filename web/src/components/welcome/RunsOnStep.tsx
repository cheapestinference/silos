// RunsOnStep.tsx — the first run's «runs on»: what the picked engine can
// run on (providerOptions — the same narrowing the New agent form uses),
// the machine's own login first and recommended. A signed-out machine
// account opens Claude's own sign-in in place; «Connect another» opens the
// same connect pieces Settings › Accounts & providers uses, for the kinds
// this engine runs — and a provider connected here is picked.
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { providerOptions } from '../../lib/providers'
import { RUNS_ON_ABOUT, RUNS_ON_ASK } from '../../lib/new-agent'
import type { HarnessDescriptor, ProviderView } from '../../lib/types'
import { ClaudeSignIn } from '../ClaudeSignIn'
import { CheapestCard, ConnectAccount, CustomCard, EngineCustomCard } from '../ProvidersTab'
import { isCheapestProvider } from '../../lib/providers'
import { ChoiceGroup, ChoiceRow } from './ChoiceRow'
import { EngineSignIn } from '../EngineSignIn'

type KeyProvider = Extract<ProviderView, { kind: 'anthropic-compatible' }>

export function RunsOnStep({
  engine,
  providers,
  provider,
  onPick,
  onChanged,
}: {
  engine: HarnessDescriptor
  providers: readonly ProviderView[] | null
  provider: string
  onPick: (id: string) => void
  onChanged: () => void // a provider was connected or signed in: reload (the host picks the new one)
}) {
  const [connecting, setConnecting] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const list = providers ?? []
  const options = providerOptions([...list], engine.id)
  const machine = list.find((p): p is Extract<ProviderView, { kind: 'claude-account' }> => p.kind === 'claude-account' && p.id === 'default') ?? null
  const kinds = engine.providerKinds
  const byKey = list.filter((p): p is KeyProvider => p.kind === 'anthropic-compatible')

  // the '' row: the engine's own login, or the machine's Claude subscription
  const ownTitle = engine.ui.ownLogin ? `${engine.label}’s own sign-in` : 'Your Claude subscription'
  const ownNote = engine.ui.ownLogin ? (
    'Whatever this machine’s ' + engine.label + ' is already signed in to.'
  ) : machine?.account.loggedIn ? (
    <>
      Signed in as <span className="text-ink">{machine.account.email ?? 'this machine'}</span>
      {machine.account.plan ? ` · ${machine.account.plan}` : ''}
    </>
  ) : machine ? (
    'This machine isn’t signed in to Claude yet.'
  ) : (
    'The Claude login on this machine.'
  )

  return (
    <section data-testid="tour-runs-on">
      <h2 className="font-display text-[22px] leading-tight tracking-tight text-ink">{RUNS_ON_ASK}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{RUNS_ON_ABOUT}</p>
      {providers === null ? (
        <p className="mt-4 text-[13px] text-ink-3">Reading what this machine is signed in to…</p>
      ) : (
        <ChoiceGroup label="Runs on">
          {options.map((o) => (
            <ChoiceRow
              key={o.value || 'own'}
              name="tour-runs-on"
              value={o.value}
              checked={provider === o.value}
              disabled={o.needsKey}
              recommended={o.value === ''}
              title={o.value === '' ? ownTitle : o.label}
              note={o.value === '' ? ownNote : o.needsKey ? 'Its key needs pasting again — Settings › Accounts & providers.' : undefined}
              onPick={() => onPick(o.value)}
            >
              {o.value === '' && !engine.ui.ownLogin && machine && !machine.account.loggedIn ? (
                signingIn ? (
                  <ClaudeSignIn
                    account="default"
                    onSignedIn={() => {
                      setSigningIn(false)
                      onChanged()
                    }}
                    onCancel={() => setSigningIn(false)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setSigningIn(true)}
                    className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
                  >
                    Sign in to Claude ›
                  </button>
                )
              ) : null}
            </ChoiceRow>
          ))}
        </ChoiceGroup>
      )}

      {/* the engine's own sign-in by link (a ChatGPT subscription on
          OpenCode): offered right here, what it signs in to is its answer */}
      {engine.ui.signIn ? (
        <div className="mt-4">
          <EngineSignIn d={engine} onSignedIn={() => onChanged()} />
        </div>
      ) : null}

      {connecting ? (
        <div className="mt-4 flex flex-col gap-3" data-testid="tour-connect">
          {kinds.includes('claude-account') ? <ConnectAccount onCreated={onChanged} /> : null}
          {kinds.includes('anthropic-compatible') ? (
            <>
              <CheapestCard providers={byKey.filter(isCheapestProvider)} onChange={onChanged} />
              <CustomCard onChange={onChanged} />
            </>
          ) : null}
          {kinds.includes('harness-provider') ? <EngineCustomCard d={engine} logins={[]} onChange={onChanged} /> : null}
        </div>
      ) : (
        <button type="button" onClick={() => setConnecting(true)} className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink">
          <Plus size={13} aria-hidden="true" />
          Use another subscription or an API key
        </button>
      )}
    </section>
  )
}
