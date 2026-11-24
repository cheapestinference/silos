// SiloLook.tsx — the look a silo brings (spec.theme), drawn from what the
// kernel resolved: both sides as miniatures of Silos (the swatch card of
// Settings › Appearance) and, on the review page, every colour by its word.
//
// Moments (docs/product.md): making Silos one's own — the owner installs a
// look from Settings › Silos › Available, approves it on the review page
// (which says it brings a look and shows it), and chooses it here, on the
// silo's page («Use this look»), or in Settings › Appearance beside the
// built-in looks. Choosing is per browser, like light/dark.
import { Check } from 'lucide-react'
import { Miniature, useThemes } from '../settings/Look'
import { useLook } from '../../lib/look'
import { SILOS_BASE, siloTheme, siloThemeId, type Mode, type SiloThemeDecl } from '../../lib/themes'
import { THEME_TOKENS } from '../../../../server/src/silos/theme-rule'
import { PageHeader } from '../PageHeader'
import { siloName } from '../../lib/silo-view'
import { useStore } from '../../store'
import { SiloSeal, silosCrumb } from './SiloPage'
import type { SiloDescriptor } from '../../lib/types'

const MODES: Mode[] = ['light', 'dark']

// light and dark side by side, each a miniature painted with that side
export function LookPair({ siloId, decl, values = false }: { siloId: string; decl: SiloThemeDecl; values?: boolean }) {
  const theme = siloTheme(siloId, decl)
  if (!theme) return null
  return (
    <div className="grid max-w-[34rem] grid-cols-1 gap-4 sm:grid-cols-2">
      {MODES.map((mode) => (
        <figure key={mode} className="m-0">
          <Miniature t={{ ...SILOS_BASE[mode], ...theme[mode] }} />
          <figcaption className="mt-1.5 px-0.5 text-xs text-ink-2">{mode === 'light' ? 'Light' : 'Dark'}</figcaption>
          {values ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 px-0.5 text-[12px]">
              {THEME_TOKENS.map((word) => {
                const v = decl[mode][word]
                if (!v) return null
                return (
                  <div key={word} className="contents">
                    <span aria-hidden className="h-3 w-3 rounded-[3px] border border-line" style={{ background: v }} />
                    <dt className="text-ink-2">{word}</dt>
                    <dd className="m-0 font-mono text-[11.5px] tabular-nums text-ink-3">{v.startsWith('#') ? v : 'derived'}</dd>
                  </div>
                )
              })}
            </dl>
          ) : null}
        </figure>
      ))}
    </div>
  )
}

// «Use this look» — sets it for this browser; «In use» once it is
export function UseLook({ siloId }: { siloId: string }) {
  const themes = useThemes()
  const [pref, choose] = useLook(themes)
  const id = siloThemeId(siloId)
  const inUse = pref.theme === id
  if (!themes.some((t) => t.id === id)) return null
  return inUse ? (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-ink" data-testid="silo-look-in-use">
      <Check size={14} strokeWidth={2.25} aria-hidden /> In use in this browser
    </span>
  ) : (
    <button
      type="button"
      onClick={() => choose({ theme: id })}
      className="rounded-md bg-terracotta px-3 py-1.5 text-[13px] font-medium text-on-terracotta transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
    >
      Use this look
    </button>
  )
}

// the section on a silo's page: what it brings, and the door to wear it
export function SiloLookSection({ d }: { d: SiloDescriptor }) {
  if (!d.theme) return null
  return (
    <section className="mt-7" data-testid="silo-look">
      <h3 className="text-[13px] font-semibold text-ink">Look</h3>
      <p className="mt-0.5 max-w-[62ch] text-[12.5px] text-ink-2">
        {d.theme.name}, with a light and a dark side. Using it recolours every page in this browser only; Settings › Appearance lists it beside the built-in
        looks.
      </p>
      <div className="mt-4">
        <LookPair siloId={d.id} decl={d.theme} />
      </div>
      <div className="mt-4">
        <UseLook siloId={d.id} />
      </div>
    </section>
  )
}

// the page of a silo that brings only a look: no records, no relations
export function SiloLookPage({ d }: { d: SiloDescriptor }) {
  const changePage = useStore((s) => s.changePage)
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <PageHeader
        testId="silo-header"
        crumbs={[silosCrumb(changePage)]}
        seal={<SiloSeal silo={d} />}
        title={siloName(d)}
        facts={
          d.description ? (
            <span className="min-w-0 truncate" title={d.description}>
              {d.description}
            </span>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[56rem] px-4 pb-12 pt-3 sm:px-5">
          <SiloLookSection d={d} />
        </div>
      </div>
    </div>
  )
}
