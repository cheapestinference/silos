// Pulse.tsx — an animated dot indicating live sessions (open WS) on an agent.
export function Pulse() {
  return <span data-testid="pulse" className="inline-block h-2 w-2 rounded-full bg-terracotta pulse" aria-label="live session" />
}
