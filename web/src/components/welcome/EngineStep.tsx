// EngineStep.tsx — the first run's engine, only when this machine can run
// more than one (lib/first-run.ts tourSteps): every engine Silos registered,
// with its version on this machine, the default recommended; one this
// machine can't run is shown with its verdict and can't be picked.
import type { EngineRow } from '../../lib/first-run'
import { ENGINE_ABOUT, ENGINE_ASK, ENGINE_CONNECTS, ENGINE_ONCE } from '../../lib/new-agent'
import { ChoiceGroup, ChoiceRow } from './ChoiceRow'

export function EngineStep({ rows, engine, onPick }: { rows: readonly EngineRow[]; engine: string; onPick: (id: string) => void }) {
  return (
    <section data-testid="tour-engine">
      <h2 className="font-display text-[22px] leading-tight tracking-tight text-ink">{ENGINE_ASK}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{ENGINE_ABOUT}</p>
      <ChoiceGroup label="Engine">
        {rows.map((r) => (
          <ChoiceRow
            key={r.id}
            name="tour-engine"
            value={r.id}
            checked={engine === r.id}
            disabled={!r.usable}
            recommended={r.recommended}
            title={
              <>
                {r.label}
                {r.version ? <span className="text-xs text-ink-3">{r.version}</span> : null}
              </>
            }
            note={r.why ?? undefined}
            onPick={() => onPick(r.id)}
          />
        ))}
      </ChoiceGroup>
      <p className="mt-2 text-xs text-ink-3">{ENGINE_ONCE}</p>
      <p className="mt-1 text-xs text-ink-3">{ENGINE_CONNECTS}</p>
    </section>
  )
}
