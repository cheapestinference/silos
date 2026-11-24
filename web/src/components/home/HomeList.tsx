// HomeList — Home's ONE list («your to do» and «needs you» are the same
// thing). The moment it serves:
// «What's mine to decide?» — first what holds someone up, then the owner's
// own tasks, one list under one name, each row saying in a quiet word which
// it is (who is stopped on it / yours, with its project or its date).
//
//   card    the first rows that hold someone up AND carry a question (at
//           most two, lib/home.ts homeList): who is stopped, the question in
//           the serif voice, its answers as buttons (the one-tap answer) —
//           else the one action the row has
//   row     the rest: its mark, its words, its quiet word, its one action
//           («Done» on a task of yours) — the row itself is its door
//   foot    what the list leaves out, by kind, each a door to the list that
//           holds it (the Needs you sheet, the owner's own tasks)
//   empty   the product's calm words, large — never an empty box
//
// The rows are composed by HomePage (it holds every gesture's handler);
// this file only draws them.
import type { ReactNode } from 'react'

export interface CardAnswer {
  label: string
  onClick: () => void
  primary?: boolean
  testId?: string
}

export function NeedsYouSection({
  summary,
  children,
  foot,
  empty,
  testId = 'home-needs-you',
}: {
  /** the counts by kind, quiet, at the head's right — a door to the full list when given */
  summary: ReactNode
  children: ReactNode
  foot: ReactNode
  /** null while there are rows; the calm words when there are none */
  empty: string | null
  testId?: string
}) {
  return (
    <section data-testid={testId} className="flex min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-4 border-b border-ink/80 pb-2.5 dark:border-ink/60">
        <h2 className="text-[15px] font-semibold text-ink">Needs you</h2>
        <span className="min-w-0 truncate text-right text-[13px] text-ink-2">{summary}</span>
      </div>
      {empty !== null ? (
        <p data-testid="needs-you-empty" className="pt-7 font-display text-[26px] leading-tight text-ink-2 sm:text-[30px]">
          {empty}
        </p>
      ) : (
        <ul className="flex flex-col">{children}</ul>
      )}
      {foot}
    </section>
  )
}

// a row that holds someone up with a question — the page's one loud thing
export function HoldCard({
  mark,
  who,
  when,
  question,
  answers,
  door,
  error,
  testId,
}: {
  mark: ReactNode
  /** «Finance is stopped on this» */
  who: string
  when: string | null
  question: ReactNode
  answers: readonly CardAnswer[]
  /** where the question lives (its task, its conversation), quiet under the answers */
  door?: { label: string; onClick: () => void } | null
  error?: ReactNode
  testId?: string
}) {
  return (
    <li
      data-testid={testId ?? 'needs-you-card'}
      className="mt-4 flex flex-col gap-3 rounded-2xl border border-line bg-veil-light px-4 py-4 shadow-[0_1px_0_var(--shadow-soft)] sm:px-5 sm:py-5 dark:bg-panel"
    >
      <div className="flex items-center justify-between gap-3 text-[13px] text-ink-2">
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-terracotta-soft text-[13px] leading-none">
            {mark}
          </span>
          <span className="truncate">{who}</span>
        </span>
        {when ? <span className="shrink-0 tabular-nums text-ink-3">{when}</span> : null}
      </div>
      <p className="text-pretty font-display text-[21px] leading-[1.28] text-ink sm:text-[23px]" data-testid="needs-you-question">
        {question}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {answers.length > 0 ? (
          <span role="group" aria-label="Answers" data-testid="needs-you-choices" className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {answers.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={a.onClick}
                data-testid={a.testId}
                className={`min-h-11 rounded-[10px] px-4 text-left text-[14px] font-medium leading-snug transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta sm:min-h-10 sm:text-center ${
                  a.primary === false ? 'border border-ink/25 bg-transparent text-ink hover:border-ink/60' : 'bg-ink text-canvas hover:bg-ink/85'
                }`}
              >
                {a.label}
              </button>
            ))}
          </span>
        ) : null}
        {door ? (
          <button
            type="button"
            onClick={door.onClick}
            className="min-h-11 rounded-[10px] px-1 text-left text-[13px] text-ink-2 hover:text-terracotta sm:min-h-10 sm:px-2"
          >
            {door.label} ›
          </button>
        ) : null}
      </div>
      {error}
    </li>
  )
}

// every other row: one line, its quiet word, its one action
export function ListRow({
  mark,
  text,
  word,
  holds,
  action,
  onOpen,
  error,
  testId,
}: {
  mark: ReactNode
  text: ReactNode
  /** which it is: who waits on it, or yours with its project or date */
  word: ReactNode
  holds: boolean
  action?: { label: string; onClick: () => void } | null
  onOpen?: (() => void) | null
  error?: ReactNode
  testId?: string
}) {
  const body = (
    <>
      <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center text-[14px] leading-none">
        {mark}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
        <span className="line-clamp-2 min-w-0 flex-1 text-[14.5px] leading-snug text-ink group-hover/r:text-terracotta">{text}</span>
        <span className={`min-w-0 shrink-0 truncate text-[12.5px] sm:max-w-[40%] text-ink-2`}>{word}</span>
      </span>
    </>
  )
  return (
    <li data-testid={testId ?? 'needs-you-row'} data-holds={holds ? 'true' : 'false'} className="border-b border-line/80">
      <div className="flex items-center gap-3 py-3">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="group/r flex min-h-8 min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
          >
            {body}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
        )}
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            data-testid="needs-you-row-act"
            className="min-h-9 shrink-0 rounded-lg border border-line px-3 text-[13px] font-medium text-ink hover:border-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-terracotta"
          >
            {action.label}
          </button>
        ) : null}
      </div>
      {error ? <div className="-mt-1 pb-2.5 pl-9">{error}</div> : null}
    </li>
  )
}
