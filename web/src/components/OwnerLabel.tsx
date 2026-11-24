// OwnerLabel.tsx — the one way an owner is written on screen: type word +
// name — «Project · acme», «This machine», «Agent · 🛠 Builder». The type
// word always comes first and is never dropped, so a bare name or path
// («silos») can never stand alone. No glyph (owner 24-11): only an agent's
// own emoji, inside its label, as its face. `from`: the origin — the lead
// word «From» in the mono slot, then the same label. Plain inline text with
// real spaces, so its accessible name reads exactly like the words on
// screen; a long name truncates at its end, the full text in `title`.
import { ORIGIN_LEAD, ownerName, ownerOriginText, ownerText, ownerType, type Owner, type OwnerContext } from '../lib/owners'

const SIZE = {
  sm: { root: 'text-[11.5px]', type: 'text-ink-2', name: 'text-ink' },
  md: { root: 'text-[13px]', type: 'text-ink-2', name: 'font-medium text-ink' },
  // a page's own header: the name carries the display face
  lg: { root: 'text-[14px]', type: 'text-ink-3', name: 'font-display text-xl text-ink' },
} as const

export function OwnerLabel({
  owner,
  ctx = {},
  size = 'md',
  className = '',
  from = false,
}: {
  owner: Owner
  ctx?: OwnerContext
  size?: keyof typeof SIZE
  className?: string
  /** retired: no glyph is drawn any more (kept so older callers still compile) */
  glyph?: boolean
  from?: boolean
}) {
  const s = SIZE[size]
  const name = ownerName(owner, ctx)
  const face = owner === 'agent' && ctx.agentEmoji ? `${ctx.agentEmoji} ` : null
  return (
    <span
      className={`inline-block max-w-full truncate align-baseline ${s.root} ${className}`}
      data-owner={owner}
      title={from ? ownerOriginText(owner, ctx) : ownerText(owner, ctx)}
    >
      {from ? (
        <>
          <span className="font-mono text-[10.5px] text-ink-3">{ORIGIN_LEAD}</span>{' '}
        </>
      ) : null}
      <span className={name ? s.type : s.name}>{ownerType(owner, ctx)}</span>
      {name ? (
        <>
          {' '}
          <span className="text-ink-3">·</span>{' '}
          <span className={s.name}>
            {face}
            {name}
          </span>
        </>
      ) : null}
    </span>
  )
}
