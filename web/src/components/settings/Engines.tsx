// settings/Engines.tsx — Settings › Engines (each thing has one
// house). The machine the agents run on, one section per engine: its
// version and the one button that updates it, Silos' compatibility verdict,
// and what Silos writes into that engine's own settings (Claude Code's
// transcript retention and Silos' hooks). Every «update your engine» door
// of the product lands here — Home's engine rows, a task that couldn't
// start, an agent's skipped start, its first meeting.
//
// Not here, on purpose: the engine's accounts and providers (Accounts &
// providers), its console colours (Appearance), its phone push (Notifications).
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { descriptorIn, useHarnessDescriptors } from '../../lib/harnesses'
import { relTimeOf } from '../../lib/rel-time'
import type { EngineCompat, EnginePageLine, HarnessDescriptor, HarnessStatus, HarnessUpdate, OtherHarnessStatus } from '../../lib/types'
import { Page, QUIET_BTN, Section, SettingRow } from './primitives'

export function EnginesTab() {
  // one /api/harness per visit: Claude Code's row reads it, and the other
  // engines' sections are drawn from its `others`
  const [harness, setHarness] = useState<HarnessStatus | null>(null)
  const descriptors = useHarnessDescriptors()
  return (
    <Page>
      <ClaudeCodeSection onHarness={setHarness} />
      {(harness?.others ?? []).map((o) => (
        <EngineSection
          key={o.harness}
          status={o}
          descriptor={descriptorIn(descriptors, o.harness)}
          compat={harness?.compat?.find((c) => c.harness === o.harness) ?? null}
        />
      ))}
    </Page>
  )
}

// x.y.z numeric comparison (prerelease ignored): true when a is newer.
function newer(a: string, b: string): boolean {
  const pa = a.split('-')[0]!.split('.').map(Number)
  const pb = b.split('-')[0]!.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

const mono = (x: string) => <span className="font-mono text-ink">{x}</span>

// The harness's version, and the one button that updates it.
// ONE Claude Code: the `claude` on PATH runs consoles and chats alike, so
// `claude update` moves both; the Agent SDK library ships with Silos and is
// shown with the release it is paired with, never offered a button. The
// engine's compatibility verdict (server harness.ts) is said under the
// versions in its own words: terracotta when Silos refuses something on it.
function HarnessRow({ onStatus }: { onStatus?: (s: HarnessStatus) => void }) {
  const [info, setInfo] = useState<HarnessStatus | null | undefined>(undefined)
  const [state, setState] = useState<'idle' | 'updating' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<HarnessUpdate | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.harness())
      .then((v) => {
        if (cancelled) return
        setInfo(v ?? null)
        if (v) onStatus?.(v)
      })
      .catch(() => {
        if (!cancelled) setInfo(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function update(): Promise<void> {
    if (!info) return
    setState('updating')
    setError(null)
    try {
      const r = await api.updateHarness()
      setDone(r)
      setInfo({ ...info, console: { ...info.console, version: r.after ?? info.console.version } })
      setState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }

  if (info === undefined) return <SettingRow label="Version" hint="Checking…" />
  if (info === null) return <SettingRow label="Version" hint={<span className="text-terracotta">Could not read Claude Code&rsquo;s version.</span>} />

  const installed = info.console.version
  // the verdict as of the update, when one ran: a fresh status says it again
  const compat = done ? null : (info.compat?.find((c) => c.harness === info.harness) ?? null)
  // an engine older than Silos needs is updated here even when npm could
  // not be asked for its latest (the verdict already says it is behind)
  const canUpdate = installed !== null && ((info.latest !== null && newer(info.latest, installed)) || compat?.state === 'outdated')
  // «up to date» only when it is: a verdict that is not ok (a newer line than
  // Silos' library — Silos is the one to update) says itself instead
  const upToDate = info.latest !== null && installed !== null && (compat === null || compat.state === 'ok')

  return (
    <SettingRow
      label="Version"
      hint={
        <>
          <span className="block">
            Consoles and chats run {installed ? mono(installed) : 'an unknown version'}
            {info.library?.version ? (
              <>
                {' '}
                · {info.library.name} {mono(info.library.version)}
                {info.library.pairedWith ? <> (paired with {mono(info.library.pairedWith)})</> : null}
              </>
            ) : null}
            {info.latest ? <> · latest {mono(info.latest)}</> : null}.
          </span>
          {done ? (
            done.after && done.after !== done.before ? (
              <span className="block">
                Updated to {mono(done.after)}. New consoles use {done.after}; open ones keep theirs until they restart.
              </span>
            ) : (
              <span className="block">
                {done.after ? (
                  <>Already the newest — claude update found nothing newer than {mono(done.after)}.</>
                ) : (
                  'claude update finished; the version could not be read.'
                )}
              </span>
            )
          ) : null}
          <CompatLine compat={compat} />
          {info.latest === null ? <span className="block">Could not check npm for a newer version.</span> : null}
          {state === 'error' ? <span className="block text-terracotta">Update failed — {error}</span> : null}
        </>
      }
    >
      {canUpdate || state === 'updating' ? (
        <button type="button" onClick={() => void update()} disabled={state === 'updating'} className={QUIET_BTN}>
          {state === 'updating' ? 'Updating…' : info.latest !== null && newer(info.latest, installed ?? '') ? `Update to ${info.latest}` : 'Update'}
        </button>
      ) : upToDate ? (
        <span className="text-xs text-ink-2">✓ up to date</span>
      ) : null}
    </SettingRow>
  )
}

// An engine's compatibility verdict, in the server's one line (harness-run.ts
// EngineCompat): terracotta when Silos refuses its consoles or chats, quiet
// when it only has to catch up (a newer engine than its library). Nothing
// when ok.
// `ahead` is Silos' own update, never the engine's (no button of this page
// does it): said so, with the command that updates THIS Silos — else the
// owner clicks another engine's Update and nothing happens.
function CompatLine({ compat }: { compat: EngineCompat | null | undefined }) {
  if (!compat || compat.state === 'ok' || !compat.message) return null
  if (compat.state === 'ahead') {
    return (
      <span className="block text-ink-2" title={compat.message}>
        {compat.name} {compat.installed ? mono(compat.installed) : null} is newer than this Silos was built for — chats keep running. This is Silos&rsquo;
        update, not {compat.name}&rsquo;s{compat.update ? <>: {mono(compat.update)}</> : '.'}
      </span>
    )
  }
  return <span className={`block ${compat.refuses.length > 0 ? 'text-terracotta' : 'text-ink-2'}`}>{compat.message}</span>
}

// Claude Code: its version, then what Silos keeps in ~/.claude/settings.json
// for it — how long transcripts live, and Silos' two hooks. Claude Code
// deletes transcripts older than cleanupPeriodDays (default 30); for a
// product that promises history and routines that never die, Silos
// surfaces it and offers to pin it.
function ClaudeCodeSection({ onHarness }: { onHarness?: (s: HarnessStatus) => void }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.claudeSettings>> | null | undefined>(undefined)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [hooksStatus, setHooksStatus] = useState<'idle' | 'saving' | 'removing' | 'error'>('idle')
  const [backup, setBackup] = useState<string | null>(null)
  // the editable number: a draft string so typing is free;
  // Save is the only writer. Synced from the server view when it lands.
  const [days, setDays] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.claudeSettings())
      .then((v) => {
        if (!cancelled) {
          setInfo(v)
          setDays(String(v.cleanupPeriodDays))
        }
      })
      .catch(() => {
        if (!cancelled) setInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function installHooks(): Promise<void> {
    if (!info) return
    setHooksStatus('saving')
    try {
      const r = await api.installClaudeHooks()
      setInfo({ ...info, hooks: r.view.hooks })
      setHooksStatus('idle')
    } catch {
      setHooksStatus('error')
    }
  }

  // the way out: Silos' two entries leave settings.json, nothing else does
  async function uninstallHooks(): Promise<void> {
    if (!info) return
    setHooksStatus('removing')
    try {
      const r = await api.uninstallClaudeHooks()
      setInfo({ ...info, hooks: r.view.hooks })
      setHooksStatus('idle')
    } catch {
      setHooksStatus('error')
    }
  }

  const [todoStatus, setTodoStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  async function saveTodoTools(enabled: boolean): Promise<void> {
    if (!info) return
    setTodoStatus('saving')
    try {
      const r = await api.setTodoTools(enabled)
      setInfo({ ...info, todoTools: r.view.todoTools })
      setTodoStatus('idle')
    } catch {
      setTodoStatus('error')
    }
  }

  async function saveDays(value: number): Promise<void> {
    if (!info) return
    setStatus('saving')
    try {
      const r = await api.setCleanupPeriodDays(value)
      setInfo({ ...info, ...r.view })
      setDays(String(r.view.cleanupPeriodDays))
      setBackup(r.backup)
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }

  const parsedDays = /^\d+$/.test(days.trim()) ? Number(days.trim()) : null
  const daysValid = parsedDays !== null && info != null && parsedDays >= 1 && parsedDays <= info.keepForeverDays
  const daysDirty = info != null && parsedDays !== info.cleanupPeriodDays
  // the two Silos hooks, each installed / broken / missing (settings.ts HookWiring)
  const hooks = info ? [info.hooks.briefing, info.hooks.cronGate] : []

  return (
    <Section
      title="Claude Code"
      description="The engine every Claude agent runs on, in consoles and chats alike. It cleans old transcripts from disk; Silos keeps its own history and routines — the retention below decides whether the transcripts under them survive."
    >
      <HarnessRow onStatus={onHarness} />
      {info === undefined ? (
        <SettingRow label="Transcript retention" hint="Reading settings.json…" />
      ) : info === null ? (
        <SettingRow label="Transcript retention" hint={<span className="text-terracotta">Could not read ~/.claude/settings.json.</span>} />
      ) : (
        <>
          <SettingRow
            label={<label htmlFor="cc-retention">Transcript retention (days)</label>}
            hint={
              <>
                {info.cleanupPeriodDays < info.keepForeverDays ? (
                  <>
                    Claude Code deletes transcripts after <span className="font-mono">{info.cleanupPeriodDays}</span> idle days
                    {info.explicit ? '' : ' — its default, not set'}.
                  </>
                ) : (
                  <>Kept (~{Math.round(info.cleanupPeriodDays / 365)} years).</>
                )}
                {status === 'saved' ? ` Saved${backup ? ` · backup: ${backup}` : ''}.` : ''}
                {status === 'error' ? <span className="text-terracotta"> Could not write settings.json.</span> : null}
              </>
            }
          >
            <span className="flex items-center gap-2">
              <input
                id="cc-retention"
                type="number"
                min={1}
                max={info.keepForeverDays}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                disabled={status === 'saving'}
                className="w-20 rounded-md border border-line bg-panel px-2 py-1 text-right font-mono text-xs text-ink"
              />
              <button
                type="button"
                onClick={() => {
                  if (parsedDays !== null) void saveDays(parsedDays)
                }}
                disabled={status === 'saving' || !daysValid || !daysDirty}
                className={QUIET_BTN}
              >
                {status === 'saving' ? 'Saving…' : 'Save'}
              </button>
              {info.cleanupPeriodDays < info.keepForeverDays ? (
                <button type="button" onClick={() => void saveDays(info.keepForeverDays)} disabled={status === 'saving'} className={QUIET_BTN}>
                  Keep forever
                </button>
              ) : null}
            </span>
          </SettingRow>
          <SettingRow
            label="Checklist on current models"
            hint={
              <>
                The engine ships its checklist (TaskCreate) on only for 4.x models — on the current 5 family a conversation shows no step list. On writes the
                documented <span className="font-mono">CLAUDE_CODE_ENABLE_TODO_TOOLS=1</span> under <span className="font-mono">env</span> in{' '}
                <span className="font-mono">~/.claude/settings.json</span>, for every Claude Code session on this machine; off removes only that key.
                {todoStatus === 'error' ? <span className="text-terracotta"> Could not write settings.json.</span> : null}
              </>
            }
          >
            <button type="button" onClick={() => void saveTodoTools(!info.todoTools)} disabled={todoStatus === 'saving'} className={QUIET_BTN}>
              {todoStatus === 'saving' ? 'Saving…' : info.todoTools ? 'On — turn off' : 'Off — turn on'}
            </button>
          </SettingRow>
          <SettingRow
            label="Silos hooks"
            hint={
              <>
                Installing adds two entries to <span className="font-mono">~/.claude/settings.json</span> that every Claude Code session on this machine runs:
                the Silos briefing at session start, and a gate that sends an agent’s recurring crons to Silos automations (in sessions you start yourself only
                durable ones — /loop keeps working).
                {hooks.includes('broken') ? (
                  <span className="text-terracotta">
                    {' '}
                    {hooks.every((h) => h === 'broken') ? 'Both hooks point' : 'A hook points'} at a script that is no longer there (the Silos folder moved?) —
                    every session logs a hook error until you repair it.
                  </span>
                ) : null}
                {hooksStatus === 'error' ? <span className="text-terracotta"> Could not write settings.json.</span> : null}
              </>
            }
          >
            <span className="flex items-center gap-2">
              {hooks.every((h) => h === 'installed') ? (
                <span className="text-xs text-ink-2">✓ installed</span>
              ) : (
                <button
                  type="button"
                  onClick={() => void installHooks()}
                  disabled={hooksStatus === 'saving' || hooksStatus === 'removing'}
                  className={QUIET_BTN}
                >
                  {hooksStatus === 'saving'
                    ? 'Installing…'
                    : hooks.includes('broken')
                      ? 'Repair hooks'
                      : hooks.includes('installed')
                        ? 'Install missing hook'
                        : 'Install hooks'}
                </button>
              )}
              {hooks.some((h) => h !== 'missing') ? (
                <button
                  type="button"
                  onClick={() => void uninstallHooks()}
                  disabled={hooksStatus === 'saving' || hooksStatus === 'removing'}
                  className={QUIET_BTN}
                >
                  {hooksStatus === 'removing' ? 'Removing…' : 'Uninstall'}
                </button>
              ) : null}
            </span>
          </SettingRow>
          <p className="mt-3 truncate font-mono text-[11px] text-ink-2" title={info.path}>
            {info.path}
          </p>
        </>
      )}
      <EngineChanges />
    </Section>
  )
}

// What the engine changed in its own configuration (GET /api/seals
// `pageLines`, the seal's cache keeps the last 50): a settings file where only
// its own keys moved (an «Always allow»), a plugin it moved to another
// version. Both are Claude Code's — its settings files and its plugin record —
// so they live under its section: one house, quiet, dated, newest first; no
// Needs-you row, no badge, nothing at all when there are none. An engine
// auto-update is seen here and nowhere else.
const CHANGES_AT_REST = 5
function EngineChanges() {
  const [lines, setLines] = useState<EnginePageLine[]>([])
  const [all, setAll] = useState(false)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.seals.pageLines())
      .then((v) => {
        if (!cancelled) setLines(Array.isArray(v) ? [...v].reverse() : [])
      })
      .catch(() => {
        /* unread: the list simply isn't drawn */
      })
    return () => {
      cancelled = true
    }
  }, [])
  if (lines.length === 0) return null
  const now = Date.now()
  const shown = all ? lines : lines.slice(0, CHANGES_AT_REST)
  return (
    <div data-testid="engine-changes" className="mt-5 border-t border-line pt-3">
      <div className="text-sm text-ink">Changed by the engine itself</div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {shown.map((l, i) => {
          const at = relTimeOf(l.at, now)
          return (
            <li key={`${l.at}:${i}`} className="flex min-w-0 items-baseline gap-2 text-xs leading-relaxed text-ink-2">
              <span className="min-w-0 truncate" title={l.kind === 'engineKeys' ? l.file : l.plugin}>
                {changeWords(l)}
              </span>
              {at ? <span className="shrink-0 tabular-nums text-ink-3">{at}</span> : null}
            </li>
          )
        })}
      </ul>
      {lines.length > CHANGES_AT_REST ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1.5 text-xs text-ink-3 hover:text-ink">
          {all ? 'Show fewer' : `${lines.length - CHANGES_AT_REST} earlier ›`}
        </button>
      ) : null}
    </div>
  )
}

// «superpowers 7.0.1 → 7.0.2» · «permissions.allow in docs-site/.claude/settings.local.json»
function changeWords(l: EnginePageLine): string {
  if (l.kind === 'pluginVersion') return l.text
  const where =
    l.folder !== '' && l.file.startsWith(`${l.folder}/`) ? `${l.folder.split('/').filter(Boolean).pop() ?? l.folder}${l.file.slice(l.folder.length)}` : l.file
  return `${l.keys.join(', ')} in ${where}`
}

// Every other engine (GET /api/harness `others` — today OpenCode), same row
// anatomy as Claude Code's. Update runs its own command (`opencode
// upgrade`); there is no published-latest lookup, so the button is always
// there while the engine is installed.
function EngineSection({ status, descriptor, compat }: { status: OtherHarnessStatus; descriptor: HarnessDescriptor; compat?: EngineCompat | null }) {
  const [version, setVersion] = useState(status.version)
  const [state, setState] = useState<'idle' | 'updating' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<HarnessUpdate | null>(null)

  async function update(): Promise<void> {
    setState('updating')
    setError(null)
    try {
      const r = await api.updateHarness(status.harness)
      setDone(r)
      if (r.after) setVersion(r.after)
      setState('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }

  return (
    <Section title={status.name} description={descriptor.ui.settingsAbout ?? undefined}>
      {version === null ? (
        <SettingRow
          label="Version"
          hint={
            <>
              <span className="block">{`${status.name} not installed`}</span>
              <CompatLine compat={compat} />
            </>
          }
        />
      ) : (
        <SettingRow
          label="Version"
          hint={
            <>
              <span className="block">
                {status.name} {mono(version)}
                {status.path ? (
                  <>
                    {' '}
                    · <span className="font-mono">{status.path}</span>
                  </>
                ) : null}
              </span>
              {done ? (
                done.after && done.after !== done.before ? (
                  <span className="block">
                    Updated to {mono(done.after)}
                    {`. New ${status.name} consoles use it; open ones keep theirs until they restart.`}
                  </span>
                ) : (
                  <span className="block">
                    {done.after ? (
                      <>
                        {`Already the newest — ${descriptor.ui.updateLabel ?? `${status.name} update`} found nothing newer than `}
                        {mono(done.after)}.
                      </>
                    ) : (
                      `${descriptor.ui.updateLabel ?? `${status.name} update`} finished; the version could not be read.`
                    )}
                  </span>
                )
              ) : null}
              {done ? null : <CompatLine compat={compat} />}
              {state === 'error' ? <span className="block text-terracotta">Update failed — {error}</span> : null}
            </>
          }
        >
          <button type="button" onClick={() => void update()} disabled={state === 'updating'} className={QUIET_BTN}>
            {state === 'updating' ? 'Updating…' : 'Update'}
          </button>
        </SettingRow>
      )}
    </Section>
  )
}
