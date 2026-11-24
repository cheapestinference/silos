// Turn.tsx — a conversation turn. The user goes in a bubble aligned to the
// right; the assistant at full width with collapsed reasoning, markdown
// and a row of tool chips. `active` is the same drawing applied to the turn
// that's streaming (text still growing + a blinking cursor).
import { ConversationRefLink } from './ConversationRefLink'
import { FileRefLink } from './FileRefLink'
import { FILE_HREF, pathOfToken, remarkFileRefs } from '../lib/file-refs'
import { REF_HREF, findRefs, remarkConversationRefs } from '../lib/conversation-refs'
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import type { ComponentPropsWithoutRef } from 'react'
import type { Turn as TurnType } from '../lib/types'
import { stripAgentContext } from '../lib/agent-context'
import { classifyNotice } from '../lib/notices'
import { humanizeProviderIds } from '../lib/runs-on'
import { resetTime } from '../lib/rate-limits'
import { useStore } from '../store'
import { ToolGroup } from './ToolChip'
import { UserImage } from './MediaImage'
import { Asterisk } from './Glyph'
import { formatLongDuration } from './StatusLine'
import { PlanSheet } from './PlanProposal'

const markdownComponents = {
  // a session name or id in the text (remarkConversationRefs) → its title
  a(props: ComponentPropsWithoutRef<'a'>) {
    const { href, children, ...rest } = props
    if (href?.startsWith(REF_HREF)) {
      const rest = href.slice(REF_HREF.length) // `id:<token>` or `name:<token>`
      return <ConversationRefLink token={rest.slice(rest.indexOf(':') + 1)} kind={rest.startsWith('id:') ? 'id' : 'name'} />
    }
    // a path in the text (remarkFileRefs), or a markdown link whose target is
    // a path, not a URL → the file viewer, once the file service says it is one
    if (href?.startsWith(FILE_HREF)) return <FileRefLink token={decodeURIComponent(href.slice(FILE_HREF.length))} />
    if (href && !href.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(href) && pathOfToken(href))
      return (
        <FileRefLink
          token={href}
          fallback={
            <a href={href} {...rest}>
              {children}
            </a>
          }
        >
          {children}
        </FileRefLink>
      )
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    )
  },
  code(props: ComponentPropsWithoutRef<'code'>) {
    const { className, children, ...rest } = props
    // rehype-highlight marks blocks with a className like "language-js hljs";
    // inline code carries no className → that's how we tell one from the other.
    if (!className) {
      // `silos-35` or a session id alone in inline code: the same title link
      const whole = typeof children === 'string' ? findRefs(children) : []
      if (whole.length === 1 && whole[0]!.token === children) return <ConversationRefLink token={whole[0]!.token} kind={whole[0]!.kind} code />
      // a path alone in inline code (`web/src/App.tsx:12`): the file, in one click
      if (typeof children === 'string' && pathOfToken(children.trim())) return <FileRefLink token={children.trim()} code />
      // inline code (NOT in a block) — without break-words a long token
      // with no spaces (a URL, a hash) overflows the bubble horizontally;
      // unlike the `pre` block below, here we don't want its own scroll,
      // we want it to wrap like the rest of the paragraph.
      return (
        <code className="break-words rounded bg-panel px-1 font-mono text-[0.9em]" {...rest}>
          {children}
        </code>
      )
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  },
  pre(props: ComponentPropsWithoutRef<'pre'>) {
    const { className = '', children, ...rest } = props
    return (
      <pre className={`my-2 overflow-x-auto rounded-lg bg-panel p-3 ${className}`} {...rest}>
        {children}
      </pre>
    )
  },
}

// `highlight=false` (a turn IN STREAMING): no rehype-highlight — highlighting
// syntax on every delta is expensive and the code block can arrive halfway
// through; the real highlight arrives when the turn is persisted and `Turn` paints it.
export function Markdown({ text, highlight = true }: { text: string; highlight?: boolean }) {
  // pasting a long OAuth URL used to overflow the chat horizontally:
  // break-words is inherited (overflow-wrap is an inheritable property) by
  // paragraphs, lists, table cells and inline code — a string with no
  // spaces breaks instead of widening the bubble. The `pre` blocks in
  // markdownComponents are NOT affected: `white-space: pre` (the browser's
  // default on <pre>) disables wrap no matter what overflow-wrap says, so
  // they keep overflowing horizontally with their own overflow-x-auto —
  // intentional behavior, don't touch them.
  return (
    <div className="turn-md break-words text-[15px] leading-relaxed">
      {/* remark-breaks: in a chat a single line break IS a line break (like
          Slack/Discord), not a collapsed space like in CommonMark — without
          this, a message's multiline text gets crushed into one paragraph. */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkFileRefs, remarkConversationRefs]}
        rehypePlugins={highlight ? [rehypeHighlight] : []}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

// a compaction marker-turn (server: entry isCompactSummary, text always
// '') — a DIVIDER, not a message: no bubble/avatar chrome, no markdown
// pipeline, no turn chips/actions. Resolved here (before the user/assistant
// branches) because that's exactly where the bubble chrome that needs
// skipping lives.
function CompactionDivider() {
  return (
    <div className="flex items-center gap-3 py-1 text-ink-2" role="separator">
      <div className="h-px flex-1 bg-line" aria-hidden="true" />
      <span className="shrink-0 font-mono text-[10px] tracking-wider uppercase">Conversation compacted</span>
      <div className="h-px flex-1 bg-line" aria-hidden="true" />
    </div>
  )
}

// the system notices family: a thin full-width row with a mono uppercase
// tag — the same language as the compaction divider above, tinted by
// severity (amber = limits/waiting, red = error, neutral = everything
// else; NEVER terracotta — orange is for action/live). The rate limit
// highlights the reset moment in full ink.
const NOTICE_STYLE = {
  neutral: { band: 'border-line', tag: 'text-ink-2' },
  amber: { band: 'border-amber-500/70 bg-amber-500/[0.07]', tag: 'text-amber-700 dark:text-amber-400' },
  red: { band: 'border-red-500/70 bg-red-500/[0.06]', tag: 'text-red-700 dark:text-red-400' },
} as const

// Auto-resume + nudge: extras for the LIMIT banner. `resume` exists ONLY
// when there's a real resume record for this conversation (the "will
// resume automatically" line is never painted without it). `nudge` = show
// the nod to cheapestinference (the agent isn't on it already).
export interface LimitBannerInfo {
  resume?: { resetsAt: string; folder: string; sessionId: string; fallbackLabel?: string; gaveUp?: { tries: number } }
  nudge: boolean
}

// a reassurance line + Cancel: the resume is REAL (there's a record).
// Three honest states: (1) gaveUp → "couldn't resume automatically…", the
// banner NEVER leaves a broken promise unannounced; (2) a fallback is
// armed → "continuing on <provider>"; (3) waiting for the reset → "resume
// at <time>". The button always discards the record (DELETE) — "Cancel"
// while waiting, "Dismiss" once it's already given up (there's nothing to
// cancel, just close the notice).
function ResumeReassurance({ resume }: { resume: NonNullable<LimitBannerInfo['resume']> }) {
  const time = resetTime(resume.resetsAt)
  const gaveUp = resume.gaveUp
  const message = gaveUp
    ? gaveUp.tries > 0
      ? `Couldn't resume automatically after ${gaveUp.tries} ${gaveUp.tries === 1 ? 'try' : 'tries'} — send again when you're ready`
      : "Couldn't resume automatically — send again when you're ready"
    : resume.fallbackLabel
      ? `Silos will continue this on ${resume.fallbackLabel}`
      : time
        ? `Silos will resume this automatically at ${time}`
        : 'Silos will resume this automatically when the limit resets'
  return (
    <div className="mt-1 flex items-baseline gap-2 text-[12px] text-amber-700 dark:text-amber-400">
      <span>{message}</span>
      <button
        type="button"
        onClick={() => useStore.getState().cancelPendingResume(resume.folder, resume.sessionId)}
        className="shrink-0 text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink"
      >
        {gaveUp ? 'Dismiss' : 'Cancel'}
      </button>
    </div>
  )
}

// the cheapestinference nudge: ONE quiet line, the link is the only
// terracotta accent. Leads to Settings › Accounts & providers (where the widget
// lives). A slightly playful but professional tone.
function NudgeCheapest() {
  return (
    <div className="mt-1 text-[12px] text-ink-2">
      Tired of waiting?{' '}
      <button
        type="button"
        onClick={() => useStore.getState().changePage({ kind: 'settings', tab: 'accounts' })}
        className="font-medium text-terracotta hover:underline"
      >
        Skip limits with cheapestinference →
      </button>
    </div>
  )
}

function SystemNotice({ text, limit }: { text: string; limit?: LimitBannerInfo }) {
  // an engine's own words, minus its internal ids for Silos keys
  const providers = useStore((s) => s.providers)
  const notice = classifyNotice(humanizeProviderIds(text, providers))
  const style = NOTICE_STYLE[notice.severity]
  // the extras only hang off the LIMIT notice (session/model limit) — not
  // an API error, not a neutral notice.
  const isLimit = notice.label === 'limit'
  const resume = isLimit ? limit?.resume : undefined
  const nudge = isLimit ? Boolean(limit?.nudge) : false
  return (
    <div role="note" className={`rounded-sm border-l-2 px-3 py-1.5 ${style.band}`}>
      <div className="flex items-baseline gap-3">
        <span className={`shrink-0 font-mono text-[10px] uppercase tracking-wider ${style.tag}`}>{notice.label}</span>
        <span className="min-w-0 break-words text-[13px] text-ink-2">
          {notice.body}
          {notice.resets ? (
            <>
              {' · '}
              <span className="font-medium text-ink">{notice.resets}</span>
            </>
          ) : null}
        </span>
      </div>
      {resume ? <ResumeReassurance resume={resume} /> : null}
      {nudge ? <NudgeCheapest /> : null}
    </div>
  )
}

// a message from ANOTHER Claude session (the harness's peer-messaging) —
// the transcript's THIRD VOICE. A relative of the notices family above
// (the same anatomy: a left hairline + a mono uppercase tag), but with a
// voice of its own: it's not the system giving notice (severities/amber/
// red don't apply) nor the owner speaking (never a terracotta/right
// bubble — the owner didn't write it). The "↦ from <sender>" tag names the
// sender; the body is normal-size markdown: it's a colleague's work
// message, not a one-line notice. Theme tokens (line/ink-2) → dark covered.
// when the server has resolved the sender to a known agent (`agentId`),
// the sender's name is a button → jumps to THAT agent's (the sender's)
// dossier. Honest: it's NOT the exact origin thread — the message carries
// no session_id (data the harness doesn't provide today), so the exact
// jump to the source conversation is left pending. The tooltip clarifies
// this ("go to <agent>"). With no agentId → plain text (previous
// behavior). The link accent is the only terracotta the band allows
// itself; the rest keeps the third-person voice (ink-2, no bubble).
function InterSessionMessage({ from, agentId, text }: { from: string; agentId?: string; text: string }) {
  return (
    <div data-inter-session role="note" className="rounded-sm border-l-2 border-line bg-panel/50 px-3 py-2">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-2">
        ↦ from{' '}
        {agentId ? (
          <button
            type="button"
            onClick={() => useStore.getState().selectAgent(agentId)}
            title={`go to ${from}`}
            className="rounded-sm text-terracotta underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline focus-visible:outline-1 focus-visible:outline-terracotta"
          >
            {from}
          </button>
        ) : (
          from
        )}
      </div>
      <Markdown text={text} />
    </div>
  )
}

// a historical receipt: CLI sessions write system/turn_duration when
// closing each turn — the parser emits it as a marker-turn and here it
// becomes "✻ Worked for X" inline, readable history looking back with its
// receipts. A generic verb ("Worked"): that turn's live verb isn't known —
// it isn't invented. Below 5s it isn't painted (the same criterion as the
// external monitor: a short exchange doesn't need a receipt). Exported:
// ExternalStatus uses the SAME threshold to decide whether its "Worked
// for" would duplicate a visible inline receipt or is the only one.
export const RECEIPT_MIN_MS = 5000

function HistoricalReceipt({ durationMs }: { durationMs: number }) {
  if (durationMs < RECEIPT_MIN_MS) return null
  // a footer of the turn it closes (right-aligned, mono, quiet) — it used to
  // float between the transcript and the composer as if it were its own turn.
  return (
    <div className="-mt-2 flex items-center justify-end gap-1.5 font-mono text-[11px] text-ink-3">
      <Asterisk />
      <span>Worked for {formatLongDuration(durationMs)}</span>
    </div>
  )
}

function TurnBase({ turn, isNew, limit }: { turn: TurnType; isNew?: boolean; limit?: LimitBannerInfo }) {
  if (turn.compact) return <CompactionDivider />
  if (turn.durationMs !== undefined) return <HistoricalReceipt durationMs={turn.durationMs} />
  if (turn.synthetic) return <SystemNotice text={turn.text} limit={limit} />
  // before the user branch — the turn carries role 'user' in the JSONL
  // but the voice is another session's, never the owner's bubble.
  if (turn.interSession) return <InterSessionMessage from={turn.interSession.from} agentId={turn.interSession.agentId} text={turn.text} />

  if (turn.role === 'user') {
    return (
      <div className={`ml-auto max-w-[85%] rounded-2xl bg-panel px-4 py-2 text-[15px] whitespace-pre-wrap break-words ${isNew ? 'turn-appear' : ''}`}>
        {/* images pasted by the user, inside their bubble — a click opens
            MediaScope's lightbox */}
        {turn.images && turn.images.length > 0 ? (
          <div className={`flex flex-wrap justify-end gap-1.5 ${turn.text.trim() !== '' ? 'mb-1.5' : ''}`}>
            {turn.images.map((im) => (
              <UserImage key={im.ref} img={im} />
            ))}
          </div>
        ) : null}
        {stripAgentContext(turn.text)}
        {/* a message rescued from inside a tool_result (it was sent while
            a turn was in progress) — a subtle mark, without breaking the normal bubble. */}
        {turn.interjection ? <div className="mt-1 text-right text-[10px] text-ink-2">sent mid-turn</div> : null}
      </div>
    )
  }

  // c6: a plan-mode plan is painted as its own sheet, not as a chip
  const plans = turn.toolUses?.filter((u) => u.plan) ?? []
  const chips = plans.length > 0 ? turn.toolUses!.filter((u) => !u.plan) : (turn.toolUses ?? turn.tools)

  return (
    <div className={`w-full ${isNew ? 'turn-appear' : ''}`}>
      {turn.thinking ? (
        <details className="mb-2">
          <summary className="cursor-pointer text-sm text-ink-2 italic">Reasoning…</summary>
          <div className="mt-1 text-sm text-ink-2 whitespace-pre-wrap break-words">{turn.thinking}</div>
        </details>
      ) : null}
      <Markdown text={turn.text} />
      {plans.map((u, i) => (
        <div key={i} className={turn.text.trim() !== '' || i > 0 ? 'mt-3' : ''}>
          <PlanSheet plan={u.plan!} ts={turn.ts} answer={u.result} />
        </div>
      ))}
      {chips.length > 0 ? <ToolGroup chips={chips} /> : null}
    </div>
  )
}

// a cheap comparator for React.memo: persisted turns are immutable in
// practice (the JSONL doesn't rewrite already-closed turns), so comparing
// lengths is enough to know whether a re-render is needed — avoids
// repainting the N previous turns on every delta of the turn that's
// streaming. Exported as a pure function so it can be tested without
// mounting React.
// NOTE: comparing by length (instead of content) assumes that immutability
// — if a persisted turn is ever edited in-place while keeping the same
// length (e.g. a text correction), this comparator would call it equal
// and the re-render would be lost. Revisit if that stops being true.
// the total number of images in a turn (pasted + from tool_results) —
// goes into the comparator below because a tool_result's images arrive
// AFTER the tool_use (same index, same text/tools lengths: without this
// the memo would swallow the update and the thumbnail wouldn't appear
// until an unrelated re-render).
function imageCount(t: TurnType): number {
  let n = t.images?.length ?? 0
  if (t.toolUses) for (const d of t.toolUses) n += d.images?.length ?? 0
  return n
}

function planStates(t: TurnType): string {
  return t.toolUses?.map((u) => u.plan?.state ?? '').join(',') ?? ''
}

export function areTurnsEqual(prev: TurnType, next: TurnType): boolean {
  return (
    prev.index === next.index &&
    prev.text.length === next.text.length &&
    imageCount(prev) === imageCount(next) &&
    // a plan's verdict lands AFTER its tool_use (same lengths) — compare it
    planStates(prev) === planStates(next) &&
    (prev.toolUses ?? prev.tools).length === (next.toolUses ?? next.tools).length &&
    // compact must enter the comparison — without this, a turn that
    // becomes the compaction marker (same index/lengths) would stay
    // painted as if nothing happened, per React's memo.
    Boolean(prev.compact) === Boolean(next.compact) &&
    // the same criterion for interSession — a turn that changes voice
    // (same text length) must re-render. Includes the resolved agentId,
    // so the link appearing/disappearing repaints too.
    Boolean(prev.interSession) === Boolean(next.interSession) &&
    prev.interSession?.agentId === next.interSession?.agentId
  )
}

// `isNew` doesn't enter the comparison: it's stable per turn (once a turn
// is decided to have "just arrived" in this session view, it never
// changes again) — comparing only `turn` stays correct and cheap. `limit`
// DOES enter: the limit banner must repaint when a resume is armed/
// cancelled (Transcript passes a memoized object, so identity only
// changes when the content changes — it doesn't re-render normal turns).
export const Turn = memo(TurnBase, (prevProps, nextProps) => areTurnsEqual(prevProps.turn, nextProps.turn) && prevProps.limit === nextProps.limit)
