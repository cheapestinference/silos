// CockpitChips.tsx — the cockpit's chips: a compact row INSIDE the
// composer, bottom-left (claude.ai's model picker placement). What it runs
// on — model and account — is SHOWN here and edited in ONE place, «Run on»
// (ProviderPanel.tsx): those two chips open it. What is per
// turn stays a chip with its own menu: effort, fast mode and permission mode.
//
// Principles:
// - A chip ALWAYS shows the cascade's effective truth (agent default →
//   conversation override → turn override) — lib/cockpit.ts mirrors the
//   server's resolution. A TURN override is one-shot: marked "next turn"
//   in amber, travels with the next send, and clears itself.
// - The cockpit's voice: mono 11px ink-2, the same family as the
//   affordances row (! for shell · / skills · @ files). No forms.
// - Amber = a visible restricted mode (a shield outside bypass) and the
//   echo's warn (what the SDK's init says started vs. what was requested)
//   — never terracotta, which is action/live.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Check, ChevronDown, Shield, UserRound, Zap } from 'lucide-react'
import { useStore } from '../store'
import { mismatchedEchoes, permissionLabel, modelInfo, modelName, fieldOrigin, resolveEffective, type PrefsPatch } from '../lib/cockpit'
import { canonicalProviderId, providerLabel, providerShortLabel } from '../lib/runs-on'
import { providerModelId } from '../lib/providers'
import { useModelOptions } from '../hooks/useModelOptions'
import { useHarness } from '../lib/harnesses'
import type { CockpitPermissionMode, ConvPrefs, EffortLevel } from '../lib/types'

type OpenMenu = 'effort' | 'fast' | 'shield' | null

const PERMISSIONS: Array<{ mode: CockpitPermissionMode; label: string; desc: string }> = [
  { mode: 'bypassPermissions', label: 'Bypass', desc: 'Run tools without asking (default)' },
  { mode: 'plan', label: 'Plan mode', desc: 'Read-only: plan first, execute nothing' },
  { mode: 'acceptEdits', label: 'Accept edits', desc: 'Auto-accept file edits, ask for the rest' },
]

// a one-shot mark shared by the chips
function NextTurnMark() {
  return <span className="ml-1 text-amber-700 dark:text-amber-400">· next turn</span>
}

function MenuRow({ checked, onClick, children, desc }: { checked?: boolean; onClick: () => void; children: ReactNode; desc?: string }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked === true}
      onClick={onClick}
      title={desc}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-panel"
    >
      <span className={`w-3.5 shrink-0 ${checked ? '' : 'invisible'}`} aria-hidden="true">
        <Check size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

export function CockpitChips() {
  const catalog = useStore((s) => s.catalog)
  const convPrefs = useStore((s) => s.convPrefs)
  const pendingConvPrefs = useStore((s) => s.pendingConvPrefs)
  const turnOverrides = useStore((s) => s.turnOverrides)
  const selected = useStore((s) => s.selected)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const agents = useStore((s) => s.agents)
  const active = useStore((s) => s.active)
  const setPref = useStore((s) => s.setConversationPref)
  const setTurn = useStore((s) => s.setTurnOverride)
  const openProviderPanel = useStore((s) => s.openProviderPanel)
  const providers = useStore((s) => s.providers)

  const [menu, setMenu] = useState<OpenMenu>(null)
  // "Next turn only" — the scope of the NEXT click in the open menu: off
  // = sets the conversation (persisted), on = a turn one-shot.
  const [turnOnly, setTurnOnly] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // closes on an outside click — the same lightweight criterion as the composer's caret.
  useEffect(() => {
    if (!menu) return
    function onPointerDown(e: PointerEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenu(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [menu])

  // no agent, no cascade to show
  const agent = agents.find((a) => a.id === selectedAgentId)
  // the visible conversation level: the open session's, or a new chat's
  // pending one (assigned to the real conversation at its chat-init).
  const conv: ConvPrefs = selected ? convPrefs : pendingConvPrefs
  const effective = resolveEffective(agent?.model, conv, turnOverrides, agent?.provider)
  // a per-provider engine's models (OpenCode): the SAME filter as the agent
  // form (useModelOptions) — the catalogue its provider reaches, or a typed id
  // for an Anthropic-compatible gateway. A 'catalog' engine (Claude Code)
  // keeps the SDK catalog; a 'none' engine has no list at all.
  const ocPick = useModelOptions(agent?.framework, effective.provider, effective.model ?? '', [], providers)
  const d = useHarness(agent?.framework)
  if (!agent) return null

  // model ids are `provider/model`, read raw, one list per provider
  const byProvider = d.ui.models === 'provider-model'
  // "default" is the engine's own login, never a machine Claude account
  const ownLogin = d.ui.ownLogin
  const models = d.ui.models === 'catalog' ? catalog : ocPick.models
  const info = modelInfo(models, effective.model)
  // the account chip: the conversation's effective provider, and whether
  // the agent's fallback is diverting THIS conversation right now (only
  // when its primary is the one that hit the limit — the server's rule).
  const primaryId = canonicalProviderId(effective.provider)
  const diverted = agent.onFallback !== undefined && canonicalProviderId(agent.onFallback.from) === primaryId ? agent.onFallback : null
  const accountOrigin = fieldOrigin('provider', conv, turnOverrides)
  // On an own-login engine (OpenCode) the default is "no Silos provider":
  // the engine's own login, never a Claude account's name
  const nameOf = (id: string | undefined, short: boolean): string =>
    ownLogin && canonicalProviderId(id) === 'default'
      ? short
        ? `${d.label} login`
        : `${d.label}’s own login`
      : short
        ? providerShortLabel(providers, id)
        : providerLabel(providers, id)

  function openMenu(which: Exclude<OpenMenu, null>): void {
    setTurnOnly(false)
    setMenu((m) => (m === which ? null : which))
  }
  // model and account are edited in Run on — the chip is its door
  function openRunOn(): void {
    setMenu(null)
    openProviderPanel(null)
  }

  function apply(patch: PrefsPatch): void {
    if (turnOnly) setTurn(patch)
    else setPref(patch)
    setMenu(null)
  }

  // a field's "default" = removing it from BOTH override levels — the chip
  // goes back to showing the agent's default (or the CLI's), which is the truth.
  function revertToDefault(field: keyof ConvPrefs): void {
    setTurn({ [field]: null })
    setPref({ [field]: null })
    setMenu(null)
  }

  // Esc closes the open menu and CONSUMES the event (preventDefault) — the
  // global Esc contract (AgentPage) checks e.defaultPrevented and won't
  // cancel the turn / close the conversation over this same Esc. The same
  // criterion as the composer's dropdown.
  function onRootKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape' && menu !== null) {
      e.preventDefault()
      e.stopPropagation()
      setMenu(null)
    }
  }

  const chipBase =
    'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40'
  const chipQuiet = `${chipBase} text-ink-2 hover:bg-panel hover:text-ink`
  const chipAmber = `${chipBase} border border-amber-500/40 bg-amber-500/[0.07] text-amber-700 hover:bg-amber-500/[0.12] dark:text-amber-400`
  const menuClass = 'absolute bottom-full left-0 z-10 mb-1 w-60 rounded-lg border border-line bg-canvas p-1 shadow-lg'

  const restricted = effective.permissionMode !== 'bypassPermissions'
  // the chip's name: a gateway's model as it runs (silos-<id>/<model>)
  // An OpenCode model is named by its full provider/model id (glm-5.3 exists
  // under two providers) — the id the launch names (silos-<id>/… for a gateway)
  // the model as the owner knows it: a key's model bare (the account chip
  // beside it already names the key — never OpenCode's `silos-<uuid>/` id);
  // a catalogue provider's model under its provider id, as OpenCode lists it
  const ocName = (m: string | undefined, provider = effective.provider): string => {
    const id = providerModelId(providers, provider, m)
    if (id === null) return 'Default'
    return id.startsWith('silos-') ? id.slice(id.indexOf('/') + 1) : id
  }
  const chipModel = byProvider ? ocName(effective.model) : modelName(models, effective.model)

  // an EXISTING override never becomes invisible. If the effective model
  // doesn't support effort/fast per the catalog, the chip/toggle stays
  // visible as long as the override exists — in amber "unsupported" and
  // clearable (the server already discards it on send; here it must be
  // SEEN and cleared). With no override and no support, the original gate applies (hidden).
  const effortSupported = info?.supportsEffort === true
  const hasEffortOverride = conv.effort !== undefined || turnOverrides.effort !== undefined
  const effortUnsupported = !effortSupported && hasEffortOverride
  const fastSupported = info?.supportsFastMode === true
  const fastUnsupported = !fastSupported && effective.fastMode

  // an honest echo of the turn in progress (or just finished): the SDK's
  // init against what was requested — a mismatch = an amber warn chip, no drama.
  const mismatches = active?.requested && active.echo ? mismatchedEchoes(active.requested, active.echo, catalog) : []

  // the "Next turn only" footer of each menu
  const scopeRow = (
    <>
      <div className="mx-1 my-1 border-t border-line" aria-hidden="true" />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={turnOnly}
        onClick={() => setTurnOnly((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11px] text-ink-2 hover:bg-panel"
      >
        <span
          className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-sm border ${turnOnly ? 'border-amber-500/60 bg-amber-500/20 text-amber-700 dark:text-amber-400' : 'border-line'}`}
          aria-hidden="true"
        >
          {turnOnly ? <Check size={9} /> : null}
        </span>
        next turn only
      </button>
    </>
  )

  return (
    // the outer wrapper (relative, NO scroll) anchors the menus; only the
    // inner row scrolls horizontally (mobile). A menu anchored inside
    // overflow-x-auto would get clipped by the scroll container (CSS:
    // overflow-x auto also forces vertical clipping).
    <div ref={rootRef} onKeyDown={onRootKeyDown} className="relative flex min-w-0 flex-1 items-center">
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
        {/* the model — shown here, changed in Run on */}
        <button
          type="button"
          aria-label={`Model: ${chipModel} — change in Run on`}
          aria-haspopup="dialog"
          data-testid="chip-model"
          data-panel-owned="run-on"
          onClick={openRunOn}
          title="Change the model in Run on"
          className={chipQuiet}
        >
          {chipModel}
          {fieldOrigin('model', conv, turnOverrides) === 'turn' ? <NextTurnMark /> : null}
          <ChevronDown size={10} aria-hidden="true" />
        </button>

        {/* effort — when the catalog confirms support, or while an
            override exists (even if the model doesn't support it: amber "unsupported") */}
        {effortSupported || hasEffortOverride ? (
          <button
            type="button"
            aria-label="effort selector"
            aria-haspopup="menu"
            aria-expanded={menu === 'effort'}
            onClick={() => openMenu('effort')}
            className={effortUnsupported ? chipAmber : chipQuiet}
          >
            effort · {effective.effort ?? 'default'}
            {effortUnsupported ? <span className="ml-1">· unsupported</span> : null}
            {fieldOrigin('effort', conv, turnOverrides) === 'turn' ? <NextTurnMark /> : null}
            <ChevronDown size={10} aria-hidden="true" />
          </button>
        ) : null}

        {/* fast mode — a per-turn dial like effort, when the model has it (or
            while it is on over one that doesn't: amber "unsupported") */}
        {fastSupported || effective.fastMode ? (
          <button
            type="button"
            aria-label="fast mode selector"
            aria-haspopup="menu"
            aria-expanded={menu === 'fast'}
            onClick={() => openMenu('fast')}
            className={fastUnsupported ? chipAmber : effective.fastMode ? `${chipBase} text-terracotta hover:bg-panel` : chipQuiet}
          >
            <Zap size={10} aria-hidden="true" />
            {effective.fastMode ? 'fast · on' : 'fast'}
            {fastUnsupported ? <span className="ml-1">· unsupported</span> : null}
            {fieldOrigin('fastMode', conv, turnOverrides) === 'turn' ? <NextTurnMark /> : null}
            <ChevronDown size={10} aria-hidden="true" />
          </button>
        ) : null}

        {/* permission mode — a shield; amber when it's NOT bypass */}
        <button
          type="button"
          aria-label="permission mode selector"
          aria-haspopup="menu"
          aria-expanded={menu === 'shield'}
          onClick={() => openMenu('shield')}
          className={restricted ? chipAmber : chipQuiet}
        >
          <Shield size={10} aria-hidden="true" />
          {permissionLabel(effective.permissionMode)}
          {fieldOrigin('permissionMode', conv, turnOverrides) === 'turn' ? <NextTurnMark /> : null}
          <ChevronDown size={10} aria-hidden="true" />
        </button>

        {/* account — which Claude login or key this conversation spends,
            shown here and changed in Run on; amber while the agent's
            fallback is diverting it */}
        <button
          type="button"
          aria-label={`Account: ${nameOf(diverted ? diverted.providerId : primaryId, true)} — change in Run on`}
          aria-haspopup="dialog"
          data-testid="chip-account"
          data-panel-owned="run-on"
          onClick={openRunOn}
          className={diverted ? chipAmber : chipQuiet}
          title={`${nameOf(diverted ? diverted.providerId : primaryId, false)} — change in Run on`}
        >
          <UserRound size={10} aria-hidden="true" />
          {diverted ? `${nameOf(diverted.providerId, true)} · fallback` : nameOf(primaryId, true)}
          {accountOrigin === 'turn' ? <NextTurnMark /> : null}
          <ChevronDown size={10} aria-hidden="true" />
        </button>

        {/* an honest echo: what genuinely started, if it doesn't match what was requested */}
        {mismatches.map((msg) => (
          <span
            key={msg}
            role="status"
            title="The SDK process reported different settings than requested"
            className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/[0.07] px-1.5 py-0.5 font-mono text-[11px] text-amber-700 dark:text-amber-400"
          >
            ⚠ {msg}
          </span>
        ))}
      </div>

      {menu === 'effort' ? (
        <div role="menu" aria-label="effort" className={menuClass}>
          <MenuRow checked={effective.effort === undefined} onClick={() => revertToDefault('effort')} desc="Let the model decide">
            Model default
          </MenuRow>
          {effortSupported ? (
            (info?.supportedEffortLevels ?? []).map((level) => (
              <MenuRow key={level} checked={effective.effort === level} onClick={() => apply({ effort: level as EffortLevel })}>
                {level}
              </MenuRow>
            ))
          ) : (
            // with an override hanging off a model with no support, the
            // menu explains and only offers to clear it — not a list the catalog can't back.
            <div className="px-2 py-1.5 font-mono text-[10px] text-ink-2">This model doesn't support effort — clear it or switch model.</div>
          )}
          {scopeRow}
        </div>
      ) : null}

      {menu === 'fast' ? (
        <div role="menu" aria-label="fast mode" className={menuClass}>
          {/* off = the default: clearing the override at both levels, never a
              persisted false */}
          <MenuRow checked={!effective.fastMode} onClick={() => revertToDefault('fastMode')} desc="The model's usual speed">
            Off
          </MenuRow>
          <MenuRow checked={effective.fastMode} onClick={() => apply({ fastMode: true })} desc="Faster output on the same model">
            On
            {fastUnsupported ? <span className="ml-1.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">· unsupported</span> : null}
          </MenuRow>
          {scopeRow}
        </div>
      ) : null}

      {menu === 'shield' ? (
        <div role="menu" aria-label="permission mode" className={menuClass}>
          {PERMISSIONS.map((p) => (
            <MenuRow
              key={p.mode}
              checked={effective.permissionMode === p.mode}
              onClick={() => (p.mode === 'bypassPermissions' ? revertToDefault('permissionMode') : apply({ permissionMode: p.mode }))}
              desc={p.desc}
            >
              {p.label}
              <span className="ml-1.5 font-mono text-[10px] text-ink-2">{p.desc}</span>
            </MenuRow>
          ))}
          {scopeRow}
        </div>
      ) : null}
    </div>
  )
}
