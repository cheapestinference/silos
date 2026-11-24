// settings/Look.tsx — Settings › Appearance › Look and Accent: the owner
// makes Silos theirs. Each look is shown as a miniature of Silos itself
// (sidebar, a title, two lines, a solid button and the live dot) painted
// with that theme's own tokens for the mode in force; the accents are a row
// of dots. Both are radio groups (arrows move and choose, one tab stop).
// Choosing writes only this browser's storage (lib/look.ts). The looks the
// active silos bring (spec.theme, checked by the kernel) follow the
// built-ins under their own heading, in the same radio group.
import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import {
  BUILTIN_THEMES,
  isSiloThemeId,
  listAccents,
  listThemes,
  lookTokens,
  OWN_ACCENT_ID,
  siloThemes,
  type Accent,
  type Mode,
  type Theme,
} from '../../lib/themes'
import { useLook } from '../../lib/look'
import { useStore } from '../../store'

const ACCENTS = listAccents()

// the looks on offer: the built-ins, then the active silos' (one list, so
// arrows walk from one group into the other)
export function useThemes(): Theme[] {
  const silos = useStore((s) => s.silos)
  return useMemo(() => listThemes(siloThemes(silos)), [silos])
}

// roving focus for a radio group: arrows (and Home/End) move AND choose
function useRadioKeys(count: number, index: number, choose: (i: number) => void) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  function onKeyDown(e: KeyboardEvent) {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    let next = step ? (index + step + count) % count : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : -1
    if (next < 0) return
    e.preventDefault()
    next = Math.max(0, Math.min(count - 1, next))
    choose(next)
    refs.current[next]?.focus()
  }
  return { refs, onKeyDown }
}

export function Miniature({ t }: { t: Record<string, string> }) {
  const line = (w: string, color: string | undefined, h = 3) => <span className="block rounded-full" style={{ width: w, height: h, background: color }} />
  return (
    <span
      aria-hidden
      className="flex aspect-[16/10] w-full overflow-hidden rounded-[7px] border"
      style={{ background: t['--canvas'], borderColor: t['--line'] }}
    >
      <span className="flex w-[31%] flex-col gap-[5px] px-[7%] py-[10%]" style={{ background: t['--panel'] }}>
        {line('55%', t['--ink-3'])}
        <span className="-mx-[18%] flex items-center rounded-[3px] px-[18%] py-[3px]" style={{ background: t['--terracotta-soft'] }}>
          {line('80%', t['--terracotta'])}
        </span>
        {line('70%', t['--ink-3'])}
        {line('45%', t['--ink-3'])}
      </span>
      <span className="flex flex-1 flex-col gap-[6px] px-[9%] py-[10%]">
        {line('62%', t['--ink'], 5)}
        {line('88%', t['--ink-2'])}
        {line('70%', t['--ink-2'])}
        <span className="mt-auto flex items-center gap-[6px]">
          <span className="flex h-[11px] w-[38%] items-center justify-center rounded-[3px]" style={{ background: t['--terracotta'] }}>
            {line('50%', t['--on-terracotta'], 2)}
          </span>
          <span className="h-[5px] w-[5px] rounded-full" style={{ background: t['--terracotta'] }} />
        </span>
      </span>
    </span>
  )
}

function LookChoice({
  themes,
  theme,
  mode,
  selected,
  tabIndex,
  onChoose,
  buttonRef,
  onKeyDown,
}: {
  themes: Theme[]
  theme: Theme
  mode: Mode
  selected: boolean
  tabIndex: number
  onChoose: () => void
  buttonRef: (el: HTMLButtonElement | null) => void
  onKeyDown: (e: KeyboardEvent) => void
}) {
  const t = lookTokens(themes, ACCENTS, { theme: theme.id, accent: OWN_ACCENT_ID }, mode)
  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabIndex}
      onClick={onChoose}
      onKeyDown={onKeyDown}
      className={`group rounded-[10px] border p-1.5 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta ${selected ? 'border-ink-2 bg-panel' : 'border-transparent hover:border-line'}`}
    >
      <Miniature t={t} />
      <span className="mt-1.5 flex items-center justify-between gap-1 px-0.5 pb-0.5">
        <span className={`text-[13px] ${selected ? 'font-medium text-ink' : 'text-ink-2 group-hover:text-ink'}`}>{theme.name}</span>
        {selected ? <Check size={13} strokeWidth={2.25} className="text-ink" aria-hidden /> : null}
      </span>
    </button>
  )
}

function Block({ label, hint, children }: { label: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t border-line py-3">
      <div className="text-sm text-ink" id={`look-${label}`}>
        {label}
      </div>
      <div className="mt-0.5 text-xs leading-relaxed text-ink-2">{hint}</div>
      <div className="mt-3">{children}</div>
    </div>
  )
}

export function LookRows({ dark }: { dark: boolean }) {
  const THEMES = useThemes()
  const [pref, choose] = useLook(THEMES, ACCENTS)
  const mode: Mode = dark ? 'dark' : 'light'
  const themeIndex = Math.max(
    0,
    THEMES.findIndex((t) => t.id === pref.theme),
  )
  const accentIndex = Math.max(
    0,
    ACCENTS.findIndex((a) => a.id === pref.accent),
  )
  const looks = useRadioKeys(THEMES.length, themeIndex, (i) => choose({ theme: THEMES[i]?.id }))
  const dots = useRadioKeys(ACCENTS.length, accentIndex, (i) => choose({ accent: ACCENTS[i]?.id }))
  const theme = THEMES[themeIndex] ?? THEMES[0]!
  const accent = ACCENTS[accentIndex] ?? ACCENTS[0]!
  const own = lookTokens(THEMES, ACCENTS, { theme: theme.id, accent: OWN_ACCENT_ID }, mode)['--terracotta']
  const dotColour = (a: Accent) => (a.id === OWN_ACCENT_ID ? own : a[mode]['--terracotta'])
  const choice = (t: Theme, i: number) => (
    <LookChoice
      key={t.id}
      themes={THEMES}
      theme={t}
      mode={mode}
      selected={i === themeIndex}
      tabIndex={i === themeIndex ? 0 : -1}
      onChoose={() => choose({ theme: t.id })}
      buttonRef={(el) => {
        looks.refs.current[i] = el
      }}
      onKeyDown={looks.onKeyDown}
    />
  )
  const builtins = THEMES.length > BUILTIN_THEMES.length ? THEMES.slice(0, BUILTIN_THEMES.length) : THEMES
  const fromSilos = THEMES.slice(builtins.length).filter((t) => isSiloThemeId(t.id))
  return (
    <>
      <Block label="Look" hint="The colours of every page in this browser. Each one has a light and a dark side.">
        <div role="radiogroup" aria-labelledby="look-Look">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">{builtins.map((t, i) => choice(t, i))}</div>
          {fromSilos.length > 0 ? (
            <div role="group" aria-labelledby="look-from-silos" className="mt-3">
              <div id="look-from-silos" className="mb-1.5 px-0.5 text-xs text-ink-3">
                From your silos
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">{fromSilos.map((t, j) => choice(t, builtins.length + j))}</div>
            </div>
          ) : null}
        </div>
      </Block>
      <Block
        label="Accent"
        hint={
          accent.id === OWN_ACCENT_ID
            ? `${theme.name}’s own. Links, live work and buttons take it.`
            : `${accent.name}, over ${theme.name}. Links, live work and buttons take it.`
        }
      >
        <div role="radiogroup" aria-labelledby="look-Accent" className="flex flex-wrap items-center gap-2.5">
          {ACCENTS.map((a, i) => {
            const selected = i === accentIndex
            return (
              <button
                key={a.id}
                ref={(el) => {
                  dots.refs.current[i] = el
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={a.name}
                title={a.name}
                tabIndex={selected ? 0 : -1}
                onClick={() => choose({ accent: a.id })}
                onKeyDown={dots.onKeyDown}
                className={`relative grid h-7 w-7 place-items-center rounded-full border-2 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-2 ${selected ? 'border-ink' : 'border-transparent hover:border-line'}`}
              >
                <span className="grid h-5 w-5 place-items-center rounded-full" style={{ background: dotColour(a) }}>
                  {/* the theme's own wears a hole: «whatever this look brings» */}
                  {a.id === OWN_ACCENT_ID ? <span className="h-2 w-2 rounded-full bg-canvas" /> : null}
                </span>
              </button>
            )
          })}
        </div>
      </Block>
    </>
  )
}
