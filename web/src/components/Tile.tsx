// Tile — the one widget every summary page is built from (no page may
// stack lists one under another). A summary page is
// a board of tiles; a list is where a click on a tile takes you (a Sheet over
// the page, or the page that owns the list). A tile says, in this order:
//   · its name (sentence case, quiet) and, at the right, where it opens;
//   · a lead — ONE sentence in the display serif, composed from real counts
//     (the product speaks in sentences: the pulse, the digest);
//   · at most PREVIEW_MAX preview lines, the most alive first;
//   · nothing else. Everything actionable lives in the list it opens.
// The whole tile is one target. `live` spends the page's accent on it (what
// waits on you); `quiet` dims what has nothing to say.
import type { ReactNode } from 'react'

export const PREVIEW_MAX = 3

export interface TileLine {
  key: string
  // a leading mark: an agent emoji, a dot, a count
  mark?: ReactNode
  text: ReactNode
  // the line's right side, mono: a time, a count, a state
  meta?: ReactNode
  // what the line leaves unsaid, on hover
  title?: string
}

export function Tile({
  name,
  lead,
  lines = [],
  more,
  door,
  onOpen,
  live = false,
  accent = false,
  quiet = false,
  span = 1,
  children,
  testId,
}: {
  name: string
  lead?: ReactNode
  lines?: readonly TileLine[]
  // what the preview leaves out, said at its foot («8 more»)
  more?: string | null
  // the door's word, top right («All», «Open»)
  door?: string
  onOpen?: () => void
  live?: boolean
  // the name alone in the accent: something inside waits on you, but the
  // page's one live tile is elsewhere (a project with asks, on Home)
  accent?: boolean
  quiet?: boolean
  span?: 1 | 2 | 3
  // free body under the lead, for a tile whose preview is not lines (seals)
  children?: ReactNode
  testId?: string
}) {
  const spanCls = span === 3 ? 'md:col-span-2 xl:col-span-3' : span === 2 ? 'md:col-span-2' : ''
  const body = (
    <>
      <span className="flex items-baseline gap-2">
        {live ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] self-center rounded-full bg-terracotta" /> : null}
        <span className={`text-[12px] font-medium ${live || accent ? 'text-terracotta' : 'text-ink-2'}`}>{name}</span>
        {door && onOpen ? (
          <span className="ml-auto shrink-0 text-[11.5px] text-ink-3 transition-colors duration-150 group-hover/tile:text-terracotta">{door} ›</span>
        ) : null}
      </span>
      {/* the live tile speaks louder than its neighbours: its sentence is the
          board's first stop after the pulse (state decides hierarchy) */}
      {lead ? (
        <span className={`mt-2 block max-w-[40ch] text-pretty font-display leading-snug text-ink ${live ? 'text-[21px] sm:text-[23px]' : 'text-[18px]'}`}>
          {lead}
        </span>
      ) : null}
      {children ? <span className="mt-3 block">{children}</span> : null}
      {lines.length > 0 ? (
        <span className={`flex flex-col ${live ? 'mt-4' : 'mt-3'}`}>
          {lines.slice(0, PREVIEW_MAX).map((l) => (
            <span
              key={l.key}
              title={l.title}
              className={`flex min-w-0 items-center gap-2.5 border-t py-2 first:border-t-0 first:pt-0 ${live ? 'border-terracotta/15' : 'border-line/70'}`}
            >
              {l.mark !== undefined ? (
                <span aria-hidden="true" className="flex w-5 shrink-0 justify-center text-[13px] leading-none">
                  {l.mark}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{l.text}</span>
              {l.meta ? <span className="shrink-0 font-mono text-[11px] text-ink-3">{l.meta}</span> : null}
            </span>
          ))}
        </span>
      ) : null}
      {more ? <span className="mt-auto block pt-2.5 text-[12px] text-ink-3">{more}</span> : null}
    </>
  )
  const cls = `group/tile flex min-w-0 flex-col rounded-[14px] border text-left ${spanCls} ${
    live ? 'border-terracotta/35 bg-terracotta-soft/40 p-5 sm:p-6' : 'border-line bg-veil-light/55 p-4 sm:p-5 dark:bg-panel/60'
  } ${quiet ? 'opacity-75 hover:opacity-100' : ''}`
  if (!onOpen)
    return (
      <div className={cls} data-testid={testId}>
        {body}
      </div>
    )
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={testId}
      className={`${cls} transition-colors duration-150 hover:border-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta`}
    >
      {body}
    </button>
  )
}

// the board the tiles sit on: one column on a phone, two at a desk, three
// on a wide screen — a tile's `span` claims more.
export function TileGrid({ children, cols = 3, className = '' }: { children: ReactNode; cols?: 2 | 3; className?: string }) {
  return <div className={`grid grid-cols-1 gap-3 md:grid-cols-2 ${cols === 3 ? 'xl:grid-cols-3' : ''} ${className}`}>{children}</div>
}
