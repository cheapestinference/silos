// PageHeader — ONE anatomy for every page (a common header, so nobody gets
// lost). Before it, six hand-rolled headers
// said «where am I» six ways («Project · x», «with Finance ›», «‹ Tasks · Active»,
// the eyebrow «silo», a phone-only ‹, or nothing).
//
//   acme › Builder                                        ‹ First real sync   ← where it lives · where you came from
//   🧭  First real sync — silo Invoices      [Real console] [Chat] [⋯]   ← seal · title · actions (right, fixed order)
//       Accounting, taxes… · ⑂ fix/economy…                            ← one line of facts
//   Now  Messages  Memory  Files  …                                        ← tabs, when the page has them
//
// The crumbs are the PLACE (each one a door up), never history: the browser's
// back is the one stack. The right of the crumb row is where you came from —
// a list walk («2 of 64 ‹ ›») or the way back to a conversation — and only
// then. On a phone the crumbs fold to their last one, «‹ parent».
import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { BackButton } from './Chat'

export interface Crumb {
  label: string
  onClick?: () => void
  title?: string
  /** a signal riding on the crumb (an agent's unread messages): its own
   *  small door, drawn right after the label — never inside it */
  mark?: ReactNode
  /** the crumb drawn as its own control (the conversation's agent pill)
   *  instead of a plain word — it carries its own doors */
  node?: ReactNode
}

export function PageHeader({
  crumbs = [],
  fold,
  place,
  aside,
  seal,
  title,
  facts,
  notes,
  actions,
  tabs,
  joined = false,
  testId,
  wrapTitle = false,
  measure,
}: {
  crumbs?: readonly Crumb[]
  /** what unfolds from a crumb (the agent's sections): its own storey at
   *  the header's foot, under the title and its facts (owner 24-11: never
   *  wedged between the crumb line and the title) */
  fold?: ReactNode
  // WHERE the page lives beyond its crumbs (a conversation's branch and
  // whether its work landed): it closes the crumb row, on a phone too —
  // place stays on the place line, never among the facts of the work
  place?: ReactNode
  aside?: ReactNode
  seal?: ReactNode
  title: ReactNode
  facts?: ReactNode
  // a fact that needs its own line (why the conversation was opened, what the
  // fence refused) — under the facts, same muted register, never an alert
  notes?: ReactNode
  actions?: ReactNode
  tabs?: ReactNode
  // the page's sections follow as the band's last row (SectionTabs): no
  // rule under the title, the row draws the band's edge
  joined?: boolean
  testId?: string
  // a sentence-long title (a task) wraps to two lines instead of truncating;
  // 'phone' only below md, where one line holds a dozen letters
  wrapTitle?: boolean | 'phone'
  // a centred page (the task) passes its body's measure so header and body share one left edge
  measure?: string
}) {
  const up = crumbs.length > 0 ? crumbs[crumbs.length - 1]! : null
  return (
    <header data-testid={testId} className={joined ? 'shrink-0 bg-panel px-4 pt-3 sm:px-5' : 'shrink-0 border-b border-line bg-panel px-4 pt-3 sm:px-5'}>
      <div className={measure ?? ''}>
        {crumbs.length > 0 || aside ? (
          <div className="flex min-h-[18px] items-center gap-3">
            {up ? (
              // a phone: the parent (an agent's name) never shrinks — the place beside it (a branch) gives way
              <nav aria-label="Where this lives" className="flex min-w-0 items-center text-[12px] text-ink-3 max-md:shrink-0">
                {/* phone: the parent alone, as the way up */}
                <span className="flex min-w-0 items-center gap-1 md:hidden">
                  {up.node ? (
                    <span className="flex min-w-0 items-center gap-0.5">
                      <ChevronLeft size={13} aria-hidden="true" className="shrink-0" />
                      {up.node}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={up.onClick}
                      disabled={!up.onClick}
                      title={up.title}
                      className="-my-1.5 flex min-w-0 items-center gap-0.5 py-1.5 hover:text-terracotta disabled:hover:text-ink-3"
                    >
                      <ChevronLeft size={13} aria-hidden="true" className="shrink-0" />
                      <span className="max-w-[11rem] truncate">{up.label}</span>
                    </button>
                  )}
                  {up.mark ?? null}
                </span>
                <ol className="hidden min-w-0 items-center md:flex">
                  {crumbs.map((c, i) => (
                    <li key={`${i}:${c.label}`} className="flex min-w-0 items-center">
                      {i > 0 ? (
                        <span aria-hidden="true" className="px-1.5 text-ink-3/70">
                          ›
                        </span>
                      ) : null}
                      {c.node ? (
                        c.node
                      ) : c.onClick ? (
                        <button type="button" onClick={c.onClick} title={c.title} className="min-w-0 truncate rounded-sm hover:text-terracotta">
                          {c.label}
                        </button>
                      ) : (
                        <span title={c.title} className="min-w-0 truncate">
                          {c.label}
                        </span>
                      )}
                      {c.mark ? <span className={`${c.node ? 'ml-2' : 'ml-0.5'} flex shrink-0 items-center`}>{c.mark}</span> : null}
                    </li>
                  ))}
                </ol>
              </nav>
            ) : (
              <span />
            )}
            {place ? (
              <div data-testid="page-place" className="flex min-w-0 items-center text-[12px] text-ink-3">
                {place}
              </div>
            ) : null}
            {aside ? <div className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-ink-2">{aside}</div> : null}
          </div>
        ) : null}
        {/* desktop: seal | title over its facts | actions — the facts sit
          under the title. A phone can't spare that column: the seal, the
          title and the actions share the first row, and the facts and
          notes take the band's whole width under it, from the gutter. */}
        <div className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center ${crumbs.length > 0 || aside ? 'mt-1.5' : ''}`}>
          {/* the phone's door to the agents and conversations list (md:hidden)
            — every page has it, in the same place, so no page strands you */}
          <div className={`col-[1] row-[1] flex items-center gap-3 pr-3 ${seal ? '' : 'md:pr-0'} ${facts || notes ? 'md:row-[1/3]' : ''}`}>
            <BackButton />
            {seal ?? null}
          </div>
          <h1
            className={`col-[2] row-[1] min-w-0 font-display text-[22px] leading-tight text-ink ${wrapTitle === true ? 'line-clamp-2' : wrapTitle === 'phone' ? 'max-md:line-clamp-2 md:truncate' : 'truncate'}`}
          >
            {title}
          </h1>
          {facts || notes ? (
            <div className="col-[1/4] row-[2] min-w-0 max-md:mt-1 md:col-[2]">
              {/* the clip: a run of <Fact>s carries its separators in its own
                left margin, and this box hides whichever lands at a line's
                start — so a fact line never opens on a «·» (theme.css) */}
              {facts ? (
                <div className="mt-0.5 min-w-0 overflow-hidden">
                  <div className="page-facts flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-[12.5px] text-ink-2">{facts}</div>
                </div>
              ) : null}
              {notes}
            </div>
          ) : null}
          {actions ? (
            <div className={`col-[3] row-[1] flex shrink-0 items-center gap-1.5 self-start pl-3 pt-0.5 ${facts || notes ? 'md:row-[1/3]' : ''}`}>{actions}</div>
          ) : null}
        </div>
        {fold ?? null}
        {tabs ? <div className="mt-2.5 -mb-px">{tabs}</div> : <div className={joined ? 'h-1' : 'h-3'} />}
      </div>
    </header>
  )
}

/** one fact of the header's facts line. The «·» between facts is the line's
 *  (theme.css .page-fact), never hand-placed: it vanishes at a line's start,
 *  so a fact that wraps on a phone — or the first one — never leads with
 *  one. `truncate`: this fact gives way first (an ellipsis on desktop's one
 *  line, its own line on a phone); the rest keep their whole words. A fact
 *  whose content renders nothing leaves no separator behind. `bare`: a chip
 *  that sits beside the fact before it on the one desktop line (a plain
 *  gap), and takes the «·» only where it may open a line — a phone. */
export function Fact({
  children,
  truncate = false,
  bare = false,
  className = '',
  testId,
}: {
  children?: ReactNode
  truncate?: boolean
  bare?: boolean
  className?: string
  testId?: string
}) {
  return (
    <span
      data-testid={testId}
      data-bare={bare ? '' : undefined}
      className={`page-fact flex items-center ${truncate ? 'min-w-0 shrink' : 'shrink-0'} ${className}`}
    >
      {children}
    </span>
  )
}

/** the seal: an emoji or an icon on the house's soft terracotta; `signal`
 *  rings it (the sidebar's dot vocabulary, one level up) */
export function Seal({
  children,
  signal,
  testId,
  onClick,
  label,
}: {
  children: ReactNode
  signal?: 'working' | 'attention' | null
  testId?: string
  /** a door: the seal opens what it stands for */ onClick?: () => void
  label?: string
}) {
  const cls = `flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-terracotta-soft text-[19px] leading-none ${
    signal ? `ring-2 ring-terracotta ring-offset-2 ring-offset-panel ${signal === 'working' ? 'dot-blink' : ''}` : ''
  }`
  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        data-signal={signal ?? undefined}
        onClick={onClick}
        aria-label={label}
        title={label}
        className={`${cls} cursor-pointer transition-shadow hover:ring-1 hover:ring-terracotta/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta`}
      >
        <span aria-hidden="true">{children}</span>
      </button>
    )
  }
  return (
    <div
      data-testid={testId}
      data-signal={signal ?? undefined}
      aria-hidden={signal ? undefined : true}
      aria-label={signal === 'attention' ? 'needs your attention' : signal === 'working' ? 'working' : undefined}
      className={cls}
    >
      {children}
    </div>
  )
}

/** a header action — one primary (filled), the rest quiet; always this order */
export function HeaderButton({
  children,
  onClick,
  primary = false,
  label,
  testId,
  expanded,
  popup,
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  label?: string
  testId?: string
  expanded?: boolean
  popup?: 'menu'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      aria-expanded={expanded}
      aria-haspopup={popup}
      className={
        primary
          ? 'flex items-center gap-1.5 rounded-lg bg-terracotta px-3 py-1.5 text-[13px] font-medium text-on-terracotta hover:opacity-90'
          : `flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] hover:border-terracotta hover:text-terracotta ${expanded ? 'border-terracotta text-terracotta' : 'border-line text-ink-2'}`
      }
    >
      {children}
    </button>
  )
}
