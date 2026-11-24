// HealthLine — a Tools row's health, the line under its own: a small dot in
// the health tone, the word (connected · needs your sign-in · didn't start ·
// still connecting · off in Claude Code · not read yet) and how it was read
// («read 2h ago, in a chat of Builder»). `full`: the opened row — the
// engine's message on its own line, never truncated. Under it, the count
// line — how often it did not start («didn't start the last 12 times ·
// since 3 Nov»), and, when start notices were counted, that they are only
// a part («from start notices — they name some failures, not all»).
import type { HealthWords } from '../../lib/loads-view'

const DOT: Record<HealthWords['tone'], string> = {
  ok: 'bg-[var(--health-green)]',
  warn: 'bg-[var(--health-amber)]',
  bad: 'bg-[var(--health-red)]',
  quiet: 'border border-ink-3/70',
}
const WORD: Record<HealthWords['tone'], string> = {
  ok: 'text-ink-2',
  warn: 'text-[var(--health-amber)]',
  bad: 'text-[var(--health-red)]',
  quiet: 'text-ink-3',
}

export function HealthLine({ h, full = false }: { h: HealthWords; full?: boolean }) {
  const line = (
    <span className={`${full ? 'block' : 'flex'} min-w-0 items-baseline gap-1.5 text-[11px] leading-snug`} data-testid="tool-health" data-tone={h.tone}>
      <span aria-hidden="true" className={`inline-block h-[6px] w-[6px] shrink-0 translate-y-[-1px] rounded-full ${DOT[h.tone]}`} />
      <span className={`${full ? '' : 'truncate'} ${full ? 'ml-1.5' : ''}`}>
        <span className={h.summary ? 'text-ink-2' : WORD[h.tone]}>{h.word}</span>
        {!full && h.reason ? <span className="text-ink-3"> — {h.reason}</span> : null}
        {h.how ? <span className="text-ink-3"> · {h.how}</span> : null}
      </span>
      {full && h.reason ? <span className="mt-0.5 block font-mono text-[11px] leading-relaxed text-ink-2">{h.reason}</span> : null}
    </span>
  )
  if (!h.count) return line
  const c = h.count
  // the count sits under the health, indented to its word (past the dot)
  return (
    <>
      {line}
      <span
        className={`${full ? 'mt-0.5 block' : 'block truncate'} pl-[12px] text-[11px] leading-snug`}
        data-testid="tool-count"
        data-from={c.partial ? 'notices' : 'readings'}
        title={full ? undefined : [c.words, c.partial].filter(Boolean).join(' · ')}
      >
        <span className={h.tone === 'bad' ? WORD.bad : 'text-ink-2'}>{c.words}</span>
        {c.partial ? <span className="text-ink-3"> · {c.partial}</span> : null}
      </span>
    </>
  )
}
