// SettingsPage.tsx — the platform's settings, reached from the Sidebar
// footer's ⚙ Settings (always visible, not a data preset). One shell: a
// vertical, GROUPED nav on the left (the same terracotta left accent the
// Sidebar uses for the open item, so selection reads the same everywhere)
// and ONE content column on the right that every section shares (Page →
// Section → SettingRow). On phones the nav folds into a horizontally
// scrolling row of pills above the content. The open section IS the URL's
// (/settings/<tab>): every door elsewhere names its tab.
//
// The tabs group by what each thing IS (one house per thing,
// edited where it is shown; a tab is never «the rest» or «configuration»):
//   You           Access · Appearance · Notifications
//   Fleet         Accounts & providers · Engines · Territory · Archived agents
//   Library       Memories · Skills · Silos
//   This install  Maintenance · About
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Moon, Sun } from 'lucide-react'
import { useStore, TERMINAL_FONT_DEFAULT, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, type SettingsTab } from '../store'
import { api } from '../lib/api'
import { fetchAuthConfig, getGoogleIdentity, signOutEverywhere } from '../lib/auth'
import { useDarkMode } from './Sidebar'
import { PageHeader } from './PageHeader'
import { NotificationsTab } from './NotificationsTab'
import { ProvidersTab } from './ProvidersTab'
import { SessionsMaintenance } from './settings/SessionsMaintenance'
import { EnginesTab } from './settings/Engines'
import { MemoriesTab } from './settings/Memories'
import { Page, QUIET_BTN, Section, SettingRow } from './settings/primitives'
import { MASTER_ID } from '../lib/constants'
import { SkillsCatalogTab } from './SkillsInventory'
import { settingsSection } from '../lib/routes'
import { descriptorIn, useHarnessDescriptors } from '../lib/harnesses'
import { TerritorySection } from './settings/Territory'
import { LookRows } from './settings/Look'
import { SilosPage } from './silo/SilosPage'
import type { AgentSummary, HarnessDescriptor } from '../lib/types'
import { missionLine } from '../lib/mission'

// the nav's groups say WHAT a section is about: you (the person at the
// keyboard), the fleet (what the agents run on and may reach), the library
// they share, and this install's own housekeeping.
const GROUPS: { label: string; tabs: { id: SettingsTab; label: string }[] }[] = [
  {
    label: 'You',
    tabs: [
      { id: 'access', label: 'Access' },
      { id: 'appearance', label: 'Appearance' },
      { id: 'notifications', label: 'Notifications' },
    ],
  },
  {
    label: 'Fleet',
    tabs: [
      { id: 'accounts', label: 'Accounts & providers' },
      { id: 'engines', label: 'Engines' },
      { id: 'territory', label: 'Territory' },
      { id: 'archived', label: 'Archived agents' },
    ],
  },
  // Silos: installing, retiring and the catalog are platform
  // management; the silos in use are tiles on Home
  {
    label: 'Library',
    tabs: [
      { id: 'memories', label: 'Memories' },
      { id: 'skills', label: 'Skills' },
      { id: 'silos', label: 'Silos' },
    ],
  },
  // housekeeping — reached only from here, on purpose: it is
  // not a product surface
  {
    label: 'This install',
    tabs: [
      { id: 'maintenance', label: 'Maintenance' },
      { id: 'about', label: 'About' },
    ],
  },
]

// the catalog sections are two-pane (list + detail) and the ledger wants
// the whole height; every other section is a single reading column.
const FULL_BLEED: ReadonlySet<SettingsTab> = new Set<SettingsTab>(['memories', 'skills', 'maintenance'])

function Identity({ letter, photo, name, email }: { letter: string; photo?: string | null; name: string; email?: string | null }) {
  return (
    <div className="flex items-center gap-3">
      {photo ? (
        <img src={photo} alt="" referrerPolicy="no-referrer" className="h-10 w-10 shrink-0 rounded-full" />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-terracotta-soft font-display text-sm text-terracotta">{letter}</div>
      )}
      <div className="min-w-0">
        <p className="truncate text-sm text-ink">{name}</p>
        {email ? <p className="truncate text-xs">{email}</p> : null}
      </div>
    </div>
  )
}

// Access — who can open this Silos. Google login is opt-in (Silos ID: the
// server's SILOS_ID_URL, in its environment or <data dir>/server.env): with
// it on, visits from elsewhere sign in with Google and
// this browser's identity is shown with a discreet sign out (clears the
// local token and identity, revokes the session on the server, reloads —
// AuthGate shows the login screen again). The identity only exists after a
// login the server verified (consumeSilosIdLanding in lib/auth.ts). The machine's
// Claude login is NOT here: it is an account the agents run on (Accounts &
// providers › This machine).
function AccessTab() {
  const [identity] = useState(() => getGoogleIdentity())
  const [signingOut, setSigningOut] = useState(false)
  const [google, setGoogle] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(fetchAuthConfig())
      .then((c) => {
        if (!cancelled) setGoogle(c?.enabled === true)
      })
      .catch(() => {
        if (!cancelled) setGoogle(null)
      })
    return () => {
      cancelled = true
    }
  }, [])
  const local = typeof window !== 'undefined' && ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)
  return (
    <Page>
      <Section
        title="Access"
        description={
          google
            ? 'Visits from other machines sign in with Google; only the emails this server allows get in. On this machine Silos opens without it.'
            : 'Silos opens on this machine. Google sign-in, for visits from elsewhere, is off — it turns on when the server is given a Silos ID (SILOS_ID_URL, in its environment or in server.env in its data folder).'
        }
      >
        {identity ? (
          <SettingRow
            label={
              <Identity
                letter={(identity.name ?? identity.email).slice(0, 1).toUpperCase()}
                photo={identity.photo}
                name={identity.name ?? identity.email}
                email={identity.email}
              />
            }
          >
            <button
              type="button"
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true)
                void signOutEverywhere()
              }}
              className={QUIET_BTN}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </SettingRow>
        ) : (
          <SettingRow
            label="This browser"
            hint={local ? 'On this machine — no sign-in needed.' : google ? 'Not signed in with Google.' : 'Opened with the server’s token.'}
          />
        )}
      </Section>
    </Page>
  )
}

// An engine console's colours (ui.consoleColours; its own pref,
// prefs.consoleTheme[<engine id>]): like the Claude console, it follows
// Silos' light/dark by default (OpenCode: server console-theme.ts, its
// `system` theme over a pane styled with Silos' colours); or the engine's own
// theme, changed the way ui.consoleColoursHint says. A console keeps the
// colours it was born with — the ↻ in its banner applies a change.
function ConsoleColours({ descriptor }: { descriptor: HarnessDescriptor }) {
  const label = descriptor.label
  const [value, setValue] = useState<'silos' | 'own' | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.prefs())
      .then((p) => {
        if (!cancelled) setValue(p?.consoleTheme?.[descriptor.id] ?? 'silos')
      })
      .catch(() => {
        if (!cancelled) setValue('silos')
      })
    return () => {
      cancelled = true
    }
  }, [descriptor.id])
  async function choose(v: 'silos' | 'own'): Promise<void> {
    const before = value
    setValue(v)
    setError(null)
    try {
      await api.patchPrefsConsoleTheme(descriptor.id, v)
    } catch (e) {
      setValue(before)
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const opt = (v: 'silos' | 'own', text: string) => (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-2 has-[:checked]:text-ink">
      <input
        type="radio"
        name={`${descriptor.id}-console-theme`}
        checked={value === v}
        onChange={() => void choose(v)}
        className="h-3.5 w-3.5 accent-terracotta"
      />
      {text}
    </label>
  )
  return (
    <SettingRow
      label={`${label} console colours`}
      hint={
        <>
          <span className="block">
            {value === 'own'
              ? descriptor.ui.consoleColoursHint
                ? `${label}’s own theme — ${descriptor.ui.consoleColoursHint}.`
                : `${label}’s own theme.`
              : 'Light or dark with Silos, like the Claude console.'}{' '}
            An open console keeps its colours until you restart it (↻).
          </span>
          {error ? <span className="block text-terracotta">{error}</span> : null}
        </>
      }
    >
      {value === null ? null : (
        <div role="radiogroup" aria-label={`${label} console colours`} className="flex items-center gap-3">
          {opt('silos', 'Follow Silos')}
          {opt('own', `${label}’s own`)}
        </div>
      )}
    </SettingRow>
  )
}

// Appearance — how Silos and its consoles look: light or dark, the look
// (theme + accent, settings/Look.tsx), the consoles'
// text size, and the colours of every installed engine whose console has its
// own (ui.consoleColours).
function AppearanceTab() {
  const [dark, toggle] = useDarkMode()
  const fontSize = useStore((s) => s.terminalFontSize)
  const setFontSize = useStore((s) => s.setTerminalFontSize)
  const descriptors = useHarnessDescriptors()
  const [installed, setInstalled] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.harness())
      .then((h) => {
        if (!cancelled) setInstalled((h?.others ?? []).filter((o) => o.version !== null).map((o) => o.harness))
      })
      .catch(() => {
        /* no engine rows: nothing more to colour */
      })
    return () => {
      cancelled = true
    }
  }, [])
  const coloured = installed.map((id) => descriptorIn(descriptors, id)).filter((d) => d.ui.consoleColours)
  return (
    <Page>
      <Section title="Appearance">
        <SettingRow label="Light or dark" hint={`Follows your system until you pick one. Now ${dark ? 'dark' : 'light'}.`}>
          <button type="button" onClick={toggle} className={`flex items-center gap-1.5 ${QUIET_BTN}`}>
            {dark ? <Sun size={13} /> : <Moon size={13} />}
            {dark ? 'Switch to light theme' : 'Switch to dark theme'}
          </button>
        </SettingRow>
        <LookRows dark={dark} />
        <SettingRow
          label="Console text size"
          hint={`The real console and the terminal tabs. Open panes follow at once. ${fontSize === TERMINAL_FONT_DEFAULT ? 'Default.' : `Default is ${TERMINAL_FONT_DEFAULT}.`}`}
        >
          <div className="flex items-center gap-1.5" role="group" aria-label="Console text size">
            <button
              type="button"
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= TERMINAL_FONT_MIN}
              className={`${QUIET_BTN} px-2 tabular-nums`}
              aria-label="Smaller console text"
            >
              A−
            </button>
            <span className="min-w-[3.5ch] text-center font-mono text-xs tabular-nums text-ink" aria-live="polite">
              {fontSize}px
            </span>
            <button
              type="button"
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= TERMINAL_FONT_MAX}
              className={`${QUIET_BTN} px-2 tabular-nums`}
              aria-label="Larger console text"
            >
              A+
            </button>
            {fontSize !== TERMINAL_FONT_DEFAULT ? (
              <button
                type="button"
                onClick={() => setFontSize(TERMINAL_FONT_DEFAULT)}
                className="ml-1 text-xs text-ink-2 underline-offset-2 hover:text-ink hover:underline"
              >
                Reset
              </button>
            ) : null}
          </div>
        </SettingRow>
        {coloured.map((d) => (
          <ConsoleColours key={d.id} descriptor={d} />
        ))}
      </Section>
    </Page>
  )
}

// Archived agents — what used to be the Sidebar footer's "Archived"
// accordion: out of the sidebar, conversations kept, one Restore each. The
// same refetch-on-churn criterion as the Sidebar's archived agents: a
// signal derived from id+archived, not the raw `agents` array.
function ArchivedTab() {
  const loadOverview = useStore((s) => s.loadOverview)
  const agents = useStore((s) => s.agents)
  const [list, setList] = useState<AgentSummary[] | null>(null)

  async function load(): Promise<void> {
    const all = await api.agents.list(true)
    setList(all.filter((a) => a.archived && a.id !== MASTER_ID))
  }

  const agentsSignal = agents.map((a) => `${a.id}:${a.archived ? 1 : 0}`).join(',')
  useEffect(() => {
    void load()
  }, [agentsSignal])

  async function restore(id: string): Promise<void> {
    await api.agents.unarchive(id)
    await Promise.all([load(), loadOverview()])
  }

  return (
    <Page>
      <Section
        title={`Archived agents${list !== null && list.length > 0 ? ` (${list.length})` : ''}`}
        description="Out of the sidebar, conversations kept. Restore brings one back where it was."
      >
        {list === null ? (
          <p>Loading…</p>
        ) : list.length === 0 ? (
          <p>No archived agents.</p>
        ) : (
          <ul role="list">
            {list.map((a) => (
              <li key={a.id}>
                <SettingRow
                  label={
                    <span className="truncate">
                      {a.emoji} {a.name}
                    </span>
                  }
                  hint={missionLine(a) || undefined}
                >
                  <button type="button" onClick={() => void restore(a.id)} className={QUIET_BTN}>
                    Restore
                  </button>
                </SettingRow>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Page>
  )
}

// Muted folders, folded under the Sessions ledger: the folders Silos never
// lists. Read-only — changing the list live would require re-filtering the
// index already built in memory (SessionIndex/watcher receive it at
// startup, see server/src/index.ts); ~/.silos/muted.json is edited by hand
// and Silos restarted.
function MutedFolders() {
  const [muted, setMuted] = useState<string[] | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.muted())
      .then((m) => {
        if (!cancelled) setMuted(m ?? [])
      })
      .catch(() => {
        if (!cancelled) setMuted([])
      })
    return () => {
      cancelled = true
    }
  }, [])
  if (muted === null) return null
  return (
    <div className="mt-2 text-[12px] text-ink-2" data-testid="muted-folders">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-left hover:text-ink">
        <ChevronRight size={12} aria-hidden="true" className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        {muted.length === 0 ? 'No muted folders' : `${muted.length} muted ${muted.length === 1 ? 'folder' : 'folders'}`} — never listed, never counted
      </button>
      {open ? (
        <div className="mt-1.5 pl-4">
          {muted.length > 0 ? (
            <ul className="space-y-0.5 font-mono text-[11px] text-ink">
              {muted.map((m) => (
                <li key={m} className="truncate" title={m}>
                  {m}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 max-w-prose leading-relaxed">
            Edit <code className="font-mono text-[11px] text-ink">~/.silos/muted.json</code> and restart Silos to change it. Sessions under a system temp
            directory are left out too — test harnesses and scratch runs.
          </p>
        </div>
      ) : null}
    </div>
  )
}

function AboutTab() {
  return (
    <Page>
      <Section title="About">
        <SettingRow label="Silos — local, v1" hint={typeof window !== 'undefined' ? window.location.host : '127.0.0.1:3210'} />
      </Section>
    </Page>
  )
}

export function SettingsPage() {
  const page = useStore((s) => s.page)
  const changePage = useStore((s) => s.changePage)
  // the painted section IS the URL's: derived from `page`, never a local
  // copy — a copy kept the previous section when the footer ⚙ / ⌘K
  // «Settings» navigated to a bare /settings.
  const tab: SettingsTab = settingsSection(page?.kind === 'settings' ? page.tab : undefined)
  // every section has its URL (/settings/<tab>): a click
  // NAVIGATES, so the address bar, ⌘K, reload and back/forward all agree.
  const openTab = (t: SettingsTab): void => changePage({ kind: 'settings', tab: t })

  // Every per-provider model list (ui.models 'provider-model' — today
  // OpenCode's) is refreshed when Settings opens: `opencode
  // models` is cheap and the agent form reads the cache. Best effort — not
  // installed (502) leaves the cache as it was. Once per engine per mount:
  // the effect follows the list, so an engine that arrives with
  // /api/harnesses after mount is refreshed too, and none twice.
  const descriptors = useHarnessDescriptors()
  const refreshed = useRef(new Set<string>())
  useEffect(() => {
    for (const d of descriptors) {
      if (d.ui.models !== 'provider-model' || refreshed.current.has(d.id)) continue
      refreshed.current.add(d.id)
      Promise.resolve(api.refreshModels(d.id)).catch(() => {})
    }
  }, [descriptors])

  const fullBleed = FULL_BLEED.has(tab)
  // a phone's row scrolls sideways: the open section is always in view
  const spine = useRef<HTMLElement>(null)
  useEffect(() => {
    const nav = spine.current
    const el = nav?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!nav || !el || nav.scrollWidth <= nav.clientWidth) return
    const left = el.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft
    nav.scrollLeft = Math.max(0, left - 20)
  }, [tab])

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* the common band — the platform's settings name
          themselves like every root page, with the same rows (title + one
          line). The open section is the spine's to say, not repeated here. */}
      <PageHeader
        testId="settings-header"
        title="Settings"
        facts={<span className="min-w-0 truncate">This Silos — you, the fleet’s accounts and engines, the library, housekeeping</span>}
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* the spine: grouped sections. Phones get the same buttons as one
            scrolling row (eyebrows hidden); from md up, a column with the
            group eyebrows and the Sidebar's terracotta left accent on the
            open section. */}
        <nav
          ref={spine}
          aria-label="Settings sections"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-2 md:w-48 md:flex-col md:gap-0 md:overflow-y-auto md:border-b-0 md:border-r md:px-2 md:py-3 lg:w-56"
        >
          {GROUPS.map((g) => (
            <div key={g.label} className="flex shrink-0 gap-1 md:block md:pb-3">
              <div className="hidden px-3 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-2 md:block">{g.label}</div>
              {g.tabs.map((t) => {
                const current = tab === t.id
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-current={current ? 'true' : undefined}
                    onClick={() => openTab(t.id)}
                    className={`relative shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-left text-[13px] transition-colors duration-150 md:flex md:w-full md:rounded-md md:py-[5px] ${
                      current
                        ? 'bg-panel font-medium text-ink md:bg-transparent md:before:absolute md:before:bottom-1 md:before:left-0 md:before:top-1 md:before:w-0.5 md:before:rounded-full md:before:bg-terracotta'
                        : 'text-ink-2 hover:text-ink md:hover:bg-canvas/60'
                    }`}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <div className={`relative min-h-0 flex-1 ${fullBleed ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}>
          {tab === 'access' ? <AccessTab /> : null}
          {tab === 'appearance' ? <AppearanceTab /> : null}
          {tab === 'notifications' ? <NotificationsTab /> : null}
          {tab === 'accounts' ? (
            <Page>
              <ProvidersTab />
            </Page>
          ) : null}
          {tab === 'engines' ? <EnginesTab /> : null}
          {tab === 'territory' ? (
            <Page>
              <TerritorySection />
            </Page>
          ) : null}
          {tab === 'archived' ? <ArchivedTab /> : null}
          {tab === 'memories' ? <MemoriesTab /> : null}
          {tab === 'skills' ? <SkillsCatalogTab /> : null}
          {tab === 'silos' ? <SilosPage /> : null}
          {tab === 'maintenance' ? <SessionsMaintenance aside={<MutedFolders />} /> : null}
          {tab === 'about' ? <AboutTab /> : null}
        </div>
      </div>
    </div>
  )
}
