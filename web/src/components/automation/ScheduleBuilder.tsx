// ScheduleBuilder.tsx — "When it runs", as sentences. Each
// choice IS the sentence it saves: the chosen one opens its blanks in place
// ("Every day at [09:00]"), the others read with their current values, so
// the list doubles as a menu of what's possible. Under it, the zone and one
// line of what will be saved, with the next three times when they can be
// known. The model lives in lib/schedule.ts.
import { useId, useMemo } from 'react'
import type { ReactNode } from 'react'
import { triggerSummary } from '../../lib/automations'
import {
  WEEKDAYS,
  browserTimeZone,
  cronOfDraft,
  formatNextRuns,
  knownTimeZones,
  nextRuns,
  triggerOfDraft,
  type ScheduleDraft,
  type ScheduleKind,
} from '../../lib/schedule'

const pad = (n: number): string => String(n).padStart(2, '0')

// the radio's own name — the sentence's blanks live inside its label, so
// without this the name would read their values too
const CHOICE_NAME: Record<ScheduleKind, string> = {
  daily: 'Every day',
  weekdays: 'Weekdays',
  weekly: 'Every week',
  hourly: 'Every few hours',
  once: 'Once',
  custom: 'Custom cron expression',
}

// the blanks inside a sentence: quiet until touched, terracotta on focus
const blank = 'rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[14px] text-ink tabular-nums outline-none focus:border-terracotta'

function onceLabel(d: ScheduleDraft): string {
  const ms = Date.parse(`${d.onceDate}T${d.onceTime}`)
  if (Number.isNaN(ms)) return 'Once, on a date you pick'
  const day = new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return `Once, on ${day} at ${d.onceTime}`
}

function hoursWord(n: number): string {
  return n === 1 ? 'hour' : 'hours'
}

// a sentence choice: a custom dot (the native radio kept for keyboard and
// screen readers), the sentence, and — when chosen — its blanks.
function Choice({
  name,
  kind,
  value,
  onPick,
  children,
}: {
  name: string
  kind: ScheduleKind
  value: ScheduleKind
  onPick: (k: ScheduleKind) => void
  children: ReactNode
}) {
  const active = kind === value
  return (
    <label
      data-testid={`schedule-${kind}`}
      className={`group flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2 ${active ? 'bg-terracotta-soft/60' : 'hover:bg-panel'}`}
    >
      <input type="radio" name={name} value={kind} aria-label={CHOICE_NAME[kind]} checked={active} onChange={() => onPick(kind)} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={`mt-[3px] size-4 shrink-0 rounded-full border bg-canvas transition-[border-width] duration-100 peer-focus-visible:ring-2 peer-focus-visible:ring-terracotta/40 ${
          active ? 'border-[5px] border-terracotta' : 'border-ink-3/60 group-hover:border-ink-2'
        }`}
      />
      <span className={`min-w-0 flex-1 text-[14px] leading-6 ${active ? 'text-ink' : 'text-ink-2'}`}>{children}</span>
    </label>
  )
}

export function ScheduleBuilder({
  draft,
  onChange,
  problem,
  nowMs,
  serverNextAt,
}: {
  draft: ScheduleDraft
  onChange: (d: ScheduleDraft) => void
  // what's wrong, in words (the draft's own check or the server's 400)
  problem: string | null
  nowMs: number
  // the server's own next run — shown when the zone isn't set, the one case
  // the browser can't compute (it doesn't know the server's clock)
  serverNextAt?: string | null
}) {
  const group = useId()
  const zonesId = useId()
  const zones = useMemo(knownTimeZones, [])
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...draft, ...patch })
  const pick = (kind: ScheduleKind) => set({ kind })
  const k = draft.kind
  const isCron = k !== 'once'
  const timeInput = <input type="time" aria-label="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} className={blank} />

  const trigger = triggerOfDraft(draft)
  const expr = cronOfDraft(draft)
  const next = useMemo(
    () => (isCron && expr && draft.tz && !problem ? formatNextRuns(nextRuns(expr, draft.tz, nowMs, 3), draft.tz) : ''),
    [isCron, expr, draft.tz, problem, nowMs],
  )
  const serverNext =
    !next && isCron && !draft.tz && serverNextAt && !Number.isNaN(Date.parse(serverNextAt)) ? formatNextRuns([Date.parse(serverNextAt)], '') : ''
  const browserTz = browserTimeZone()

  return (
    <div>
      <div role="radiogroup" aria-label="When it runs" className="-mx-2.5 flex flex-col gap-0.5">
        <Choice name={group} kind="daily" value={k} onPick={pick}>
          Every day at {k === 'daily' ? timeInput : draft.time}
        </Choice>
        <Choice name={group} kind="weekdays" value={k} onPick={pick}>
          Weekdays at {k === 'weekdays' ? timeInput : draft.time}
          {k === 'weekdays' ? <span className="block text-[12px] text-ink-2">Monday to Friday</span> : null}
        </Choice>
        <Choice name={group} kind="weekly" value={k} onPick={pick}>
          Every week on{' '}
          {k === 'weekly' ? (
            <select aria-label="weekday" value={draft.weekday} onChange={(e) => set({ weekday: Number.parseInt(e.target.value, 10) })} className={blank}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          ) : (
            WEEKDAYS[draft.weekday]
          )}{' '}
          at {k === 'weekly' ? timeInput : draft.time}
        </Choice>
        <Choice name={group} kind="hourly" value={k} onPick={pick}>
          {k === 'hourly' ? (
            <>
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                Every
                <input
                  type="number"
                  aria-label="every how many hours"
                  min={1}
                  max={23}
                  value={Number.isNaN(draft.everyHours) ? '' : draft.everyHours}
                  onChange={(e) => set({ everyHours: Number.parseInt(e.target.value, 10) })}
                  className={`${blank} w-12`}
                />
                {hoursWord(draft.everyHours)} at
                <span className="flex items-center rounded-md border border-line bg-canvas pl-1.5 focus-within:border-terracotta">
                  <span aria-hidden="true" className="text-ink-2">
                    :
                  </span>
                  <input
                    type="number"
                    aria-label="minute"
                    min={0}
                    max={59}
                    value={Number.isNaN(draft.minute) ? '' : pad(draft.minute)}
                    onChange={(e) => set({ minute: Number.parseInt(e.target.value, 10) })}
                    className="w-10 bg-transparent py-0.5 pl-0.5 pr-1 text-[14px] text-ink tabular-nums outline-none"
                  />
                </span>
              </span>
              {draft.window ? (
                <span className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink-2">
                  only from
                  <HourSelect
                    label="first hour"
                    value={draft.window.from}
                    minute={draft.minute}
                    onChange={(from) => set({ window: { ...draft.window!, from } })}
                  />
                  to
                  <HourSelect label="last hour" value={draft.window.to} minute={draft.minute} onChange={(to) => set({ window: { ...draft.window!, to } })} />
                  <button
                    type="button"
                    onClick={() => set({ window: null })}
                    className="rounded text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
                  >
                    or at any hour
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => set({ window: { from: 8, to: 20 } })}
                  className="mt-1 block rounded text-[13px] text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
                >
                  only during some hours
                </button>
              )}
            </>
          ) : (
            <>
              Every {draft.everyHours > 1 ? `${draft.everyHours} hours` : 'hour'} at :{pad(Number.isNaN(draft.minute) ? 0 : draft.minute)}
              {draft.window ? `, ${pad(draft.window.from)}–${pad(draft.window.to)}` : ''}
            </>
          )}
        </Choice>
        <Choice name={group} kind="once" value={k} onPick={pick}>
          {k === 'once' ? (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              Once, on
              <input type="date" aria-label="date" value={draft.onceDate} onChange={(e) => set({ onceDate: e.target.value })} className={blank} />
              at
              <input type="time" aria-label="once time" value={draft.onceTime} onChange={(e) => set({ onceTime: e.target.value })} className={blank} />
            </span>
          ) : (
            onceLabel(draft)
          )}
        </Choice>
        <Choice name={group} kind="custom" value={k} onPick={pick}>
          Custom cron expression
          {k === 'custom' ? (
            <>
              <input
                type="text"
                aria-label="cron expression"
                value={draft.custom}
                spellCheck={false}
                onChange={(e) => set({ custom: e.target.value })}
                placeholder="minute hour day month weekday"
                className={`${blank} mt-1.5 block w-full px-2 py-1 font-mono text-[13px]`}
              />
              <span className="mt-1 block text-[12px] text-ink-2">
                Five fields — minute, hour, day of month, month, weekday. 30 6 * * 1 is Mondays at 06:30.
              </span>
            </>
          ) : null}
        </Choice>
      </div>

      {isCron ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
          <label htmlFor={`${zonesId}-input`}>Time zone</label>
          <input
            id={`${zonesId}-input`}
            type="text"
            list={zonesId}
            value={draft.tz}
            spellCheck={false}
            onChange={(e) => set({ tz: e.target.value.trim() })}
            placeholder="server’s clock"
            className={`${blank} min-w-0 flex-1 basis-40 font-mono text-[12.5px]`}
          />
          <datalist id={zonesId}>
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          {!draft.tz ? (
            <span className="basis-full text-[12px]">
              Not set — it runs on the server’s clock.{' '}
              <button
                type="button"
                onClick={() => set({ tz: browserTz })}
                className="rounded text-ink underline decoration-line underline-offset-2 hover:text-terracotta"
              >
                Use {browserTz}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-line pt-3 text-[12.5px]" data-testid="schedule-preview">
        <dt className="text-ink-2">Saves as</dt>
        <dd className="font-mono text-ink tabular-nums">
          {problem ? '—' : <Pieces parts={[triggerSummary(trigger)]} />}
          {!problem && trigger.kind === 'cron' && trigger.tz ? (
            <span className="text-ink-2">
              {' '}
              · <span className="whitespace-nowrap">{trigger.tz}</span>
            </span>
          ) : null}
        </dd>
        {next || serverNext ? (
          <>
            <dt className="text-ink-2">Next</dt>
            <dd className="font-mono text-ink tabular-nums" data-testid="schedule-next">
              <Pieces parts={(next || serverNext).split(' · ')} />
            </dd>
          </>
        ) : null}
      </dl>
      {problem ? (
        <p role="alert" className="mt-2 text-[13px] text-terracotta" data-testid="schedule-problem">
          {problem}
        </p>
      ) : null}
    </div>
  )
}

// mono pieces joined by " · " that wrap between pieces, never inside one
function Pieces({ parts }: { parts: string[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? ' · ' : null}
          <span className="whitespace-nowrap">{p}</span>
        </span>
      ))}
    </>
  )
}

function HourSelect({ label, value, minute, onChange }: { label: string; value: number; minute: number; onChange: (h: number) => void }) {
  const mm = pad(Number.isNaN(minute) ? 0 : minute)
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(Number.parseInt(e.target.value, 10))} className={blank}>
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>{`${pad(h)}:${mm}`}</option>
      ))}
    </select>
  )
}
