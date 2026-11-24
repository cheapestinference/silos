// Silos's mark: the interstice of three tangent silos seen from above — a
// tricorn with concave sides that only exists because three systems touch.
// Chosen over the four-pointed astroid so it doesn't read as Gemini's
// sparkle. Geometry: r6 circles centered on an equilateral triangle with
// side 12 (A 6,9 · B 18,9 · C 12,19.392); the central gap is three arcs
// scaled to the 24×24 canvas. The arcs use r=26 on vertices at side 19 —
// LESS concave than pure tangency (r=side), on purpose: the exact geometry
// left the waist at 2.4 and the glyph turned skeletal at 16px (favicon);
// with r=26 the waist rises to 3.7 and fills 80% of the canvas without
// losing the tricorn reading.
// Full study in docs/design-system/logo/.
export function Logo({ size = 20, className = 'text-terracotta' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path fill="currentColor" d="M12 3.8 A26 26 0 0 1 2.5 20.25 A26 26 0 0 1 21.5 20.25 A26 26 0 0 1 12 3.8 Z" />
    </svg>
  )
}
