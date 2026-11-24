// MapPage.tsx — the Map: what agents, projects and conversations actually
// used, beside who reports to whom.
//
// One page, two views (Uses | Org): standalone they are the tabs of the
// common PageHeader band; embedded (a project's Map tab), a segmented
// toggle. Uses mounts UsesView — the matrix counted from the
// transcripts; Org draws the installed reporting silo's tree, and is there
// only while such a silo is active.
// The five-lane flow and then the Wiring graph — both drawing
// what the configuration declared could happen — retired; the Map draws
// what did happen.
// Standalone, the toggle drives `page.view` via changePage (deep-linkable:
// /map vs /map/org); embedded in a project tab it's a local gesture
// (useState) — the project's own URL only tracks the 'map' tab.
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { PageHeader, Fact } from './PageHeader'
import { HeaderTabs } from './HeaderTabs'
import { UsesView } from './UsesView'
import { orgSource } from '../lib/org'
import { mapViewsFor, type MapMode } from '../lib/map-views'
import { OrgByProject } from './silo/OrgByProject'
import type { SiloRelationEdge } from '../lib/types'

// Map › Org: the org chart the installed relation draws (read-only); the
// silo's page is where it is changed. Uninstalled meanwhile: said, not blank.
function OrgView() {
  const silos = useStore((s) => s.silos)
  const source = useMemo(() => orgSource(silos), [silos])
  const siloTick = useStore((s) => s.siloTick)
  const [edges, setEdges] = useState<SiloRelationEdge[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!source) return
    let cancelled = false
    api.silos
      .relation(source.silo, source.relation)
      .then((r) => {
        if (!cancelled) {
          setEdges(r.edges)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [source?.silo, source?.relation, siloTick]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[48rem] px-5 pb-12 pt-5 sm:px-8">
        {!source ? (
          <p className="text-[13px] text-ink-2">No installed silo draws an org chart now — Settings › Silos lists the ones that can.</p>
        ) : error ? (
          <p role="alert" className="text-[13px] text-terracotta">
            {error}
          </p>
        ) : edges === null ? (
          <p className="text-[13px] text-ink-3">Reading…</p>
        ) : (
          <OrgByProject silo={source.silo} relation={source.relation} edges={edges} />
        )}
      </div>
    </div>
  )
}

export function MapPage({ embedded = false, projectFolder }: { embedded?: boolean; projectFolder?: string } = {}) {
  const page = useStore((s) => s.page)
  const changePage = useStore((s) => s.changePage)
  // standalone reads/writes the view through the store (deep-linkable);
  // embedded (a project's Map tab) keeps it as a local gesture
  const [localMode, setLocalMode] = useState<MapMode>('uses')
  const mode: MapMode = embedded ? localMode : page?.kind === 'map' ? (page.view ?? 'uses') : 'uses'
  const handleModeChange = (m: MapMode): void => {
    if (embedded) setLocalMode(m)
    else changePage(m === 'uses' ? { kind: 'map' } : { kind: 'map', view: m })
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header embedded={embedded} mode={mode} onModeChange={handleModeChange} />
      {mode === 'org' ? <OrgView /> : <UsesView embedded={embedded} {...(projectFolder !== undefined ? { folder: projectFolder } : {})} />}
    </div>
  )
}

// the segmented control of the EMBEDDED Map (a project's tab, whose plate
// already is the page's band). The views come from the MAP_VIEWS registry
// (product.md: a view that exists is reachable by name); Org is
// present ONLY while a reporting silo is active — a toggle never leads nowhere.
function ModeToggle({ mode, onChange }: { mode: MapMode; onChange: (m: MapMode) => void }) {
  const silos = useStore((s) => s.silos)
  return (
    <div role="tablist" aria-label="Map view" className="flex shrink-0 items-center gap-1">
      {mapViewsFor(silos).map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          aria-selected={mode === v.id}
          title={v.about}
          onClick={() => onChange(v.id)}
          className={`rounded-full px-3 py-1 font-mono text-xs transition-colors duration-150 ${
            mode === v.id ? 'bg-terracotta-soft text-terracotta' : 'text-ink-2 hover:text-ink'
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}

// the same registry as the toggle, drawn as the band's tabs (standalone)
function MapTabs({ mode, onChange }: { mode: MapMode; onChange: (m: MapMode) => void }) {
  const silos = useStore((s) => s.silos)
  return <HeaderTabs label="Map view" value={mode} onChange={onChange} items={mapViewsFor(silos).map((v) => ({ id: v.id, label: v.label, about: v.about }))} />
}

// what the view draws, in one line. Embedded (a project page already
// carries its plate + tab bar) the header is that line and the toggle;
// standalone it is the common band, the views its tabs under the title so
// switching moves nothing.
const LEGEND: Record<MapMode, string> = {
  uses: 'what was actually used, read from the conversations',
  org: 'who reports to whom, and what each one has open',
}
function Header({ embedded = false, mode, onModeChange }: { embedded?: boolean; mode: MapMode; onModeChange: (m: MapMode) => void }) {
  if (embedded) {
    return (
      <div className="flex shrink-0 flex-wrap items-baseline justify-between gap-2 px-4 pb-1 pt-2">
        <p className="font-mono text-[11px] text-ink-2">{LEGEND[mode]}</p>
        <ModeToggle mode={mode} onChange={onModeChange} />
      </div>
    )
  }
  return (
    <PageHeader
      testId="map-header"
      title="Map"
      facts={
        <Fact truncate>
          <span className="min-w-0 truncate">{LEGEND[mode]}</span>
        </Fact>
      }
      tabs={<MapTabs mode={mode} onChange={onModeChange} />}
    />
  )
}
