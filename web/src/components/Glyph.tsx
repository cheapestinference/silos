// Glyph.tsx — the house asterisk ✻ as an inline SVG (currentColor, ~1em).
// Born in ExternalStatus (the Unicode characters ✢/✻/✽ render as tofu □ in
// headless Chromium for screenshots, and potentially on user systems with
// no glyph in their font) and extracted here so the live StatusLine and
// turn receipts use the SAME drawing — a single asterisk across the whole
// app, never two versions that drift apart.
const GLYPH_RAYS = [4, 6, 8] as const

function asteriskStrokes(rays: number): { x1: number; y1: number; x2: number; y2: number }[] {
  const cx = 7
  const cy = 7
  const r = 6
  return Array.from({ length: rays }, (_, i) => {
    const ang = (Math.PI * 2 * i) / rays - Math.PI / 2
    return { x1: cx, y1: cy, x2: cx + r * Math.cos(ang), y2: cy + r * Math.sin(ang) }
  })
}

function AsteriskSvg({ rays }: { rays: number }) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 14 14" fill="none">
      {asteriskStrokes(rays).map((t, i) => (
        <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      ))}
    </svg>
  )
}

// ExternalStatus: the live glyph rotates ✢ → ✻ → ✽ (4/6/8 rays) on its 1s
// tick; with prefers-reduced-motion it stays fixed on the first. `data-glyph`
// exposes the active index for tests (instead of looking up the character).
export function AsteriskGlyph({ index, className = '' }: { index: number; className?: string }) {
  const rays = GLYPH_RAYS[index % GLYPH_RAYS.length] ?? GLYPH_RAYS[0]
  return (
    <span data-glyph={index} aria-hidden="true" className={`inline-flex shrink-0 ${className}`.trim()}>
      <AsteriskSvg rays={rays} />
    </span>
  )
}

// The plain 6-ray ✻ — the live StatusLine (terracotta, CSS-animated via
// .glyph-live) and turn receipts (ink-2, static: orange is ONLY for what's live).
export function Asterisk({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 ${className}`.trim()}>
      <AsteriskSvg rays={6} />
    </span>
  )
}
