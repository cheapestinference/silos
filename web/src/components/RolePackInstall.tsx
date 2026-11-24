// RolePackInstall.tsx — installing a role pack, inside the New agent modal.
// The pack grants nothing
// by itself: this view says what installing will do — the agent, its
// skills, the silos it produces, each automation with its own opt-in, the
// secrets it needs — and only Install does it. Moment 3, Direct: a whole
// role, with its mission, in one gesture.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../store'
import type { RolePack, RolePackConsequences, RolePackReport } from '../lib/types'
import { slugify } from './AgentModal'

const input = 'w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta'

export function RolePackInstall({ pack, folder: initialFolder, onBack, onDone }: { pack: RolePack; folder: string; onBack: () => void; onDone: () => void }) {
  const [name, setName] = useState(pack.name)
  const [folder, setFolder] = useState(initialFolder)
  const id = slugify(name)
  const [c, setC] = useState<RolePackConsequences | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<string> | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ agentId: string; report: RolePackReport; startWarn?: string } | null>(null)

  useEffect(() => {
    let alive = true
    const h = setTimeout(() => {
      api.rolePacks.preview(pack, { id, name, folder }).then(
        (r) => {
          if (!alive) return
          setC(r)
          setError(null)
          setChosen((s) => s ?? new Set(r.automations.filter((a) => a.ready && !a.ownerOnly).map((a) => a.template)))
        },
        (e: unknown) => {
          if (alive) {
            setC(null)
            setError(e instanceof Error ? e.message : String(e))
          }
        },
      )
    }, 250)
    return () => {
      alive = false
      clearTimeout(h)
    }
  }, [pack, id, name, folder])

  async function install(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const filled = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ''))
      const commands = (c?.automations ?? []).filter((a) => a.ownerOnly && chosen?.has(a.template)).map((a) => a.template)
      const r = await api.rolePacks.install(pack, { id, name, folder }, [...(chosen ?? [])], filled, commands)
      await useStore.getState().loadOverview()
      setDone({ agentId: r.agent.id, report: r.report, ...(r.startWarn ? { startWarn: r.startWarn } : {}) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const problems = c?.problems ?? []
  const toggle = (t: string): void =>
    setChosen((s) => {
      const n = new Set(s ?? [])
      if (n.has(t)) n.delete(t)
      else n.add(t)
      return n
    })
  const files = useMemo(() => Object.keys(pack.files).length, [pack])

  if (done)
    return (
      <Installed
        name={name}
        report={done.report}
        {...(done.startWarn ? { startWarn: done.startWarn } : {})}
        onOpen={() => {
          onDone()
          useStore.getState().changePage({ kind: 'agent', id: done.agentId })
        }}
      />
    )

  return (
    <div data-testid="role-pack-install">
      <h2 className="font-display text-lg">
        {pack.emoji} Install {pack.name} from a role pack
      </h2>
      <p className="mt-0.5 text-xs text-ink-2">
        {pack.id} {pack.packVersion} · {files} files. It makes a new agent; the pack grants nothing you don’t see here.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <div>
          <label htmlFor="pack-name" className="mb-1 block text-xs text-ink-2">
            Name
          </label>
          <input id="pack-name" className={input} value={name} onChange={(e) => setName(e.target.value)} />
          <p className="mt-0.5 text-xs text-ink-2">id: {id || '—'}</p>
        </div>
        <div>
          <label htmlFor="pack-folder" className="mb-1 block text-xs text-ink-2">
            Folder it works in
          </label>
          <input
            id="pack-folder"
            className={`${input} font-mono text-[13px]`}
            value={folder}
            placeholder="/home/you/your-business"
            onChange={(e) => setFolder(e.target.value)}
          />
        </div>
      </div>

      {problems.length > 0 ? (
        <ul className="mt-3 space-y-0.5 text-sm text-terracotta" data-testid="pack-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mt-3 text-sm text-terracotta">{error}</p> : null}

      {c ? (
        <div className="mt-5 space-y-4 border-t border-line pt-4 text-sm text-ink-2" data-testid="pack-consequences">
          {/* everything the pack makes the agent READ is readable here before Install:
              its mission (in every conversation it has), each skill's files, each
              automation's prompt (a security requirement) */}
          {c.agent.mission ? (
            <Part title="Its mission">
              <p className="mb-1 text-xs">Every conversation it has starts with it — read it before you install.</p>
              <div className="rounded-lg bg-panel px-3 py-2" data-testid="pack-mission">
                <p className="whitespace-pre-wrap font-display text-[14.5px] leading-snug text-ink">{c.agent.mission.text}</p>
                {c.agent.mission.never.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5 text-[13px]">
                    {c.agent.mission.never.map((r, i) => (
                      <li key={i}>
                        <span className="text-ink">Never:</span> {r}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </Part>
          ) : null}
          {c.skills.length > 0 ? (
            <Part title="Its skills">
              <ul className="space-y-1">
                {c.skills.map((s) => (
                  <li key={s.name}>
                    <span className="text-ink">{s.name}</span>
                    {s.files > 1 ? ` · ${s.files} files` : ''}
                    {s.verified ? ` · checked ${s.verified}` : ''}
                    <Readable
                      files={Object.entries(pack.files)
                        .filter(([p]) => p.startsWith(`skills/${s.name}/`))
                        .map(([p, t]) => [p.slice(`skills/${s.name}/`.length), t] as [string, string])}
                    />
                  </li>
                ))}
              </ul>
            </Part>
          ) : null}
          {c.silos.length > 0 ? (
            <Part title="What it keeps">
              <ul>
                {c.silos.map((s) => (
                  <li key={s.silo}>
                    <span className="text-ink">{s.silo}</span>{' '}
                    {s.action === 'bind' ? (
                      `— it becomes its producer${s.version ? ` (installed ${s.version})` : ''}`
                    ) : s.action === 'submit' ? (
                      '— comes with the pack; it waits for your OK in Settings › Silos'
                    ) : (
                      <span className="text-terracotta">— not installed here, and the pack doesn’t carry it</span>
                    )}
                  </li>
                ))}
              </ul>
            </Part>
          ) : null}
          {c.automations.length > 0 ? (
            <Part title="Its automations">
              <ul className="space-y-1">
                {c.automations.map((a) => (
                  <li key={a.template}>
                    <label className={`flex items-start gap-2 ${a.ready ? 'cursor-pointer' : ''}`}>
                      <input
                        type="checkbox"
                        className="mt-1 accent-terracotta"
                        disabled={!a.ready}
                        checked={a.ready && !!chosen?.has(a.template)}
                        onChange={() => toggle(a.template)}
                        data-testid={`pack-auto-${a.template}`}
                      />
                      <span>
                        <span className="text-ink">{a.name}</span>
                        {a.ready ? '' : ` — saved as a template; fill in ${a.blanks.join(', ')} later`}
                      </span>
                    </label>
                    {a.command ? (
                      <span className="ml-6 mt-1 block">
                        <span className="block text-xs">It runs this command on this machine, without Claude — tick it only if you trust it:</span>
                        <code
                          className="mt-0.5 block whitespace-pre-wrap break-all rounded bg-panel px-2 py-1 font-mono text-[12px] text-ink"
                          data-testid={`pack-command-${a.template}`}
                        >
                          {a.command}
                        </code>
                      </span>
                    ) : null}
                    <Readable files={[['what it asks', promptOf(pack, a.template)]]} />
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs">Every one is also saved to your templates.</p>
            </Part>
          ) : null}
          {c.secrets.length > 0 ? (
            <Part title="Secrets it needs">
              <ul className="space-y-2">
                {c.secrets.map((s) => (
                  <li key={s.name}>
                    <span className="font-mono text-[12px] text-ink">{s.name}</span>
                    {s.why ? ` — ${s.why}` : ''}
                    {s.present ? null : <span className="text-xs"> · goes to the Vault, for this agent only</span>}
                    {s.present ? (
                      <span className="block text-xs">Already in your Vault for it.</span>
                    ) : (
                      <input
                        type="password"
                        autoComplete="off"
                        aria-label={s.name}
                        data-testid={`pack-secret-${s.name}`}
                        className={`${input} mt-1 font-mono text-[13px]`}
                        placeholder="paste it, or leave it for later"
                        value={secrets[s.name] ?? ''}
                        onChange={(e) => setSecrets((m) => ({ ...m, [s.name]: e.target.value }))}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </Part>
          ) : null}
          {c.territory.length > 0 ? (
            <Part title="It asks for">
              <p>{c.territory.join(', ')} — a request; its territory is yours to set in Settings › Territory.</p>
            </Part>
          ) : null}
          {c.engine.note ? <p className="text-xs">{c.engine.note}</p> : null}
        </div>
      ) : null}

      <div className="mt-6 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-sm text-ink-2 hover:text-ink">
          Back
        </button>
        <button
          type="button"
          disabled={busy || !c || problems.length > 0}
          onClick={() => void install()}
          data-testid="pack-install"
          className="rounded-lg bg-terracotta px-4 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Installing…' : `Install ${name || pack.name}`}
        </button>
      </div>
    </div>
  )
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-[13px] font-medium text-ink">{title}</h3>
      {children}
    </section>
  )
}

function Installed({ name, report, startWarn, onOpen }: { name: string; report: RolePackReport; startWarn?: string; onOpen: () => void }) {
  const made = report.automations.filter((a) => a.automationId).length
  const lines: { text: string; bad?: boolean }[] = [
    ...(report.skillFiles > 0 ? [{ text: `${report.skillFiles} skill file${report.skillFiles === 1 ? '' : 's'} in place` }] : []),
    ...report.silos.map((s) => ({
      text:
        s.done === 'bound'
          ? `Producer of ${s.silo}`
          : s.done === 'submitted'
            ? `${s.silo} waits for your OK in Settings › Silos`
            : s.done === 'missing'
              ? `${s.silo} is not installed here`
              : `${s.silo}: ${s.error ?? 'failed'}`,
      bad: s.done === 'missing' || s.done === 'failed',
    })),
    { text: made > 0 ? `${made} automation${made > 1 ? 's' : ''} made` : 'No automation made — its templates are in Automations › New' },
    ...report.automations.filter((a) => a.error).map((a) => ({ text: `${a.template}: ${a.error}`, bad: true })),
    ...report.secrets.map((s) => ({
      text:
        s.state === 'stored'
          ? `${s.name} stored in the Vault for it`
          : s.state === 'present'
            ? `${s.name} already reaches it`
            : `${s.name} still missing — add it in its Vault`,
      bad: s.state === 'missing',
    })),
    // what its project starts with could not be set (starting-set.ts)
    ...(startWarn ? [{ text: `${startWarn} Switch it in the project’s Tools.`, bad: true }] : []),
  ]
  return (
    <div data-testid="role-pack-installed">
      <h2 className="font-display text-lg">{name} is in place</h2>
      <ul className="mt-3 space-y-1 text-sm">
        {lines.map((l, i) => (
          <li key={i} className={l.bad ? 'text-terracotta' : 'text-ink-2'}>
            {l.text}
          </li>
        ))}
      </ul>
      <div className="mt-6 flex justify-end">
        <button type="button" onClick={onOpen} className="rounded-lg bg-terracotta px-4 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90">
          Open {name}
        </button>
      </div>
    </div>
  )
}

// what a template will ask the agent, as written in the pack
function promptOf(pack: RolePack, template: string): string {
  try {
    return String((JSON.parse(pack.files[`automations/${template}.json`] ?? '{}') as { automation?: { prompt?: unknown } }).automation?.prompt ?? '')
  } catch {
    return ''
  }
}

// «Read» — a file the agent will read, shown whole before anything lands
function Readable({ files }: { files: [string, string][] }) {
  const [open, setOpen] = useState(false)
  if (files.length === 0 || files.every(([, t]) => t === '')) return null
  return (
    <span className="ml-1">
      <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} className="text-xs text-ink-2 underline underline-offset-2 hover:text-ink">
        {open ? 'Hide' : 'Read'}
      </button>
      {open ? (
        <span className="mt-1 block space-y-2">
          {files.map(([name, text]) => (
            <span key={name} className="block">
              {files.length > 1 || name === 'what it asks' ? <span className="block font-mono text-[11px] text-ink-3">{name}</span> : null}
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-panel px-3 py-2 font-sans text-[13px] leading-relaxed text-ink">
                {text}
              </pre>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  )
}
