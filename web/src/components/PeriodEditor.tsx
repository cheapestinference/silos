// PeriodEditor — how often, said as a sentence:
// «Every [n] [minutes · hours · days · weeks]» and, by its unit, «on» the
// day, «at» the hour, or «only between» two hours — plus «Never» on a
// heartbeat. ONE component for an agent's heartbeat (its page › Heartbeat ›
// change) and an automation's schedule (the editor, period first).
//
// Under the sentence, the day as it will be: a 24-hour ruler with a tick at
// every slot and the band shaded — a period of 5 minutes reads dense, one of
// 3 hours from 08:22 reads as four marks inside the day. Then the
// consequence, never a prohibition: the caller says it («It only
// takes a turn when something arrived.» · «≈ n runs a day.»). The slots are
// period.ts's (the server's own module), never a reckoning of the screen.
import { useId } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { draftSlots, type PeriodDraft, type PeriodUnit } from '../lib/period'

const UNITS: PeriodUnit[] = ['minutes', 'hours', 'days', 'weeks']
const SINGULAR: Record<PeriodUnit, string> = { minutes: 'minute', hours: 'hour', days: 'day', weeks: 'week' }
// Monday first, as the week counts; value = 0–6, 0 = Sunday
const WEEK: Array<{ day: number; letter: string; name: string }> = [
  { day: 1, letter: 'M', name: 'Monday' },
  { day: 2, letter: 'T', name: 'Tuesday' },
  { day: 3, letter: 'W', name: 'Wednesday' },
  { day: 4, letter: 'T', name: 'Thursday' },
  { day: 5, letter: 'F', name: 'Friday' },
  { day: 6, letter: 'S', name: 'Saturday' },
  { day: 0, letter: 'S', name: 'Sunday' },
]

// a blank of the sentence: quiet until touched, terracotta on focus (the
// automation editor's own blanks — ScheduleBuilder)
const blank = 'rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[14px] text-ink tabular-nums outline-none focus:border-terracotta'
// a time blank's clock: the browser draws it in the page's colour scheme —
// in dark, the dark scheme's (a light glyph), never a black speck on #262624
const clock = 'dark:[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100'

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

export function PeriodEditor({
  draft,
  onChange,
  allowNever = false,
  staggerMinute,
  consequence,
  problem,
  testId = 'period',
}: {
  draft: PeriodDraft
  onChange: (d: PeriodDraft) => void
  // a heartbeat may be set to never (its control stays On its own)
  allowNever?: boolean
  // a heartbeat's agent's staggered minute: the ruler draws the slots the
  // server will stamp — absent, the band's shape
  staggerMinute?: number
  // what the period means, said by the caller — null: nothing to say
  consequence: ReactNode
  // what is wrong, in the server's words
  problem: string | null
  testId?: string
}) {
  const unitGroup = useId()
  const set = (patch: Partial<PeriodDraft>): void => onChange({ ...draft, ...patch })
  const n = Number(draft.every.trim())
  const short = draft.unit === 'minutes' || draft.unit === 'hours'
  const unitWord = (u: PeriodUnit): string => (n === 1 ? SINGULAR[u] : u)

  const pill = (active: boolean, extra = ''): string =>
    `rounded-full px-2.5 py-0.5 text-[12.5px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/30 ${
      active ? 'bg-terracotta-soft font-medium text-terracotta' : 'text-ink-2 hover:text-ink'
    } ${extra}`

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-2">
      {/* «Every [n] [unit]» — on a phone the units take their own full row
          (four equal cells, nothing cut) and «or never» follows them */}
      <div role="radiogroup" aria-label="how often" className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-[14px] text-ink">
        <span className={draft.never ? 'text-ink-3' : ''}>Every</span>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          aria-label="every how many"
          data-testid={`${testId}-every`}
          value={draft.every}
          disabled={draft.never}
          onChange={(e) => set({ every: e.target.value })}
          className={`${blank} w-14 text-center disabled:opacity-40`}
        />
        <span className="grid w-full grid-cols-4 items-center gap-0.5 rounded-full border border-line p-0.5 min-[480px]:inline-flex min-[480px]:w-auto">
          {UNITS.map((u) => (
            <button
              key={u}
              type="button"
              role="radio"
              name={unitGroup}
              aria-checked={!draft.never && draft.unit === u}
              data-testid={`${testId}-unit-${u}`}
              onClick={() => set({ unit: u, never: false })}
              className={pill(!draft.never && draft.unit === u, 'text-center')}
            >
              {unitWord(u)}
            </button>
          ))}
        </span>
        {allowNever ? (
          <span className="inline-flex items-center gap-1.5 text-[13.5px] text-ink-2">
            or
            <button
              type="button"
              role="radio"
              aria-checked={draft.never}
              data-testid={`${testId}-never`}
              onClick={() => set({ never: true })}
              className={`${pill(draft.never)} border ${draft.never ? 'border-terracotta/40' : 'border-line'}`}
            >
              never
            </button>
          </span>
        ) : null}
      </div>

      {draft.never ? null : (
        <>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-[13.5px] text-ink-2">
            {draft.unit === 'weeks' ? (
              <>
                on
                <span role="radiogroup" aria-label="day of the week" className="inline-flex items-center gap-0.5">
                  {WEEK.map((w) => (
                    <button
                      key={w.day}
                      type="button"
                      role="radio"
                      aria-checked={draft.day === w.day}
                      aria-label={w.name}
                      title={w.name}
                      data-testid={`${testId}-day-${w.day}`}
                      onClick={() => set({ day: w.day })}
                      className={`grid size-6 place-items-center rounded-full text-[11.5px] tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/30 ${
                        draft.day === w.day ? 'bg-terracotta font-medium text-canvas' : 'text-ink-2 hover:bg-terracotta-soft hover:text-terracotta'
                      }`}
                    >
                      {w.letter}
                    </button>
                  ))}
                </span>
              </>
            ) : null}
            {!short ? (
              <>
                at
                <input
                  type="time"
                  aria-label="at"
                  data-testid={`${testId}-at`}
                  value={draft.at}
                  onChange={(e) => set({ at: e.target.value })}
                  className={`${blank} ${clock}`}
                />
              </>
            ) : draft.band ? (
              <>
                only between
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <input
                    type="time"
                    aria-label="from"
                    data-testid={`${testId}-from`}
                    value={draft.band.from}
                    onChange={(e) => set({ band: { ...draft.band!, from: e.target.value } })}
                    className={`${blank} ${clock}`}
                  />
                  and
                  <input
                    type="time"
                    aria-label="to"
                    data-testid={`${testId}-to`}
                    value={draft.band.to}
                    onChange={(e) => set({ band: { ...draft.band!, to: e.target.value } })}
                    className={`${blank} ${clock}`}
                  />
                  {/* the band's removal belongs to the band — a mark beside
                      it, never a third option of the sentence */}
                  <button
                    type="button"
                    data-testid={`${testId}-band-clear`}
                    onClick={() => set({ band: null })}
                    aria-label="Remove the hours — at any hour"
                    title="Remove the hours — at any hour"
                    className="grid size-5 place-items-center rounded-full text-ink-3 transition-colors duration-150 hover:bg-terracotta-soft hover:text-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/30"
                  >
                    <X size={12} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                </span>
              </>
            ) : (
              <button
                type="button"
                data-testid={`${testId}-band`}
                onClick={() => set({ band: { from: '08:00', to: '20:00' } })}
                className="rounded underline decoration-line underline-offset-2 hover:text-terracotta"
              >
                only between some hours
              </button>
            )}
          </div>

          <DayRuler draft={draft} staggerMinute={staggerMinute} testId={`${testId}-ruler`} />
        </>
      )}

      {problem ? (
        <p role="alert" data-testid={`${testId}-problem`} className="text-[12.5px] text-terracotta">
          {problem}
        </p>
      ) : consequence ? (
        <p data-testid={`${testId}-consequence`} className="text-[12.5px] text-ink-2">
          {consequence}
        </p>
      ) : null}
    </div>
  )
}

// The day as the period will beat it: 00 to 24, the band shaded, a tick at
// every slot. Dense periods read as texture, sparse ones as marks.
function DayRuler({ draft, staggerMinute, testId }: { draft: PeriodDraft; staggerMinute?: number; testId: string }) {
  const slots = draftSlots(draft, staggerMinute)
  const band = (draft.unit === 'minutes' || draft.unit === 'hours') && draft.band ? draft.band : null
  const W = 1440
  const x = (m: number): number => (m / W) * 100
  const segments: Array<[number, number]> = band
    ? toMin(band.from) <= toMin(band.to)
      ? [[toMin(band.from), toMin(band.to)]]
      : [
          [toMin(band.from), W],
          [0, toMin(band.to)],
        ]
    : []
  const dense = slots.length > 48
  return (
    <div data-testid={testId} data-slots={slots.length} aria-hidden="true" className="select-none pt-0.5">
      <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="block h-3 w-full overflow-visible">
        <line x1="0" x2="100" y1="9.5" y2="9.5" vectorEffect="non-scaling-stroke" className="stroke-line" strokeWidth={1} />
        {segments.map(([a, b], i) => (
          <rect key={i} x={x(a)} width={Math.max(0.3, x(b) - x(a))} y="0" height="10" className="fill-terracotta-soft dark:fill-terracotta/25" />
        ))}
        {[0, 360, 720, 1080, 1440].map((m) => (
          <line key={m} x1={x(m)} x2={x(m)} y1="7" y2="10" vectorEffect="non-scaling-stroke" className="stroke-ink-3/50" strokeWidth={1} />
        ))}
        {slots.map((m) => (
          <line
            key={m}
            x1={x(m)}
            x2={x(m)}
            y1={dense ? 4 : 1.5}
            y2="9.5"
            vectorEffect="non-scaling-stroke"
            className={dense ? 'stroke-terracotta/50' : 'stroke-terracotta'}
            strokeWidth={dense ? 1 : 1.75}
            strokeLinecap="round"
          />
        ))}
      </svg>
      <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-ink-3">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </div>
  )
}
