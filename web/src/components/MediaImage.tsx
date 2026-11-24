// MediaImage.tsx — multimedia in the transcript. Three pieces:
//
//   MediaScope     — a context provider: knows how to build a ref's real
//                    URL (`/api/sessions/<f>/<id>/media/<ref>` or the
//                    subagent variant) and hosts the scope's SINGLE lightbox.
//   UserImage      — an image the user pasted, inside their bubble.
//   ToolThumbnail  — a compact thumbnail inside a ToolChip's detail.
//
// PERFORMANCE BUDGET (the rule governing this whole file): the turn only
// carries metadata (ref + mediaType + bytes + w/h if known) — the base64
// lives in the JSONL and the browser only materializes it via <img
// loading="lazy"> once the turn is in the transcript's rendered window
// (Transcript.tsx caps at 200 turns: outside the window there's no <img>
// in the DOM, so nothing gets fetched). The slot is reserved BEFORE
// loading: with known w/h the box has its exact final size (aspect ratio
// + capped height); without them, a fixed box — either way, loading
// doesn't move the layout by a SINGLE PIXEL, and streaming's bottom-lock never notices.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { TurnImage } from '../lib/types'
import { getToken } from '../lib/api'

interface MediaCtxValue {
  url: (ref: string) => string
  open: (img: TurnImage) => void
}

const MediaCtx = createContext<MediaCtxValue | null>(null)

// honest KB/MB for the lightbox footer — real data from the JSONL, not decoration.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// the reserved box's dimensions: height capped to `maxHeight`, width from
// the real ratio (capped afterward by the container's max-width via CSS).
// With no w/h (a JPEG with no dims): a fixed 4:3 box — object-cover crops
// gracefully and the layout stays deterministic.
function boxFor(img: TurnImage, maxHeight: number): { height: number; width: number; known: boolean } {
  if (img.w !== undefined && img.h !== undefined && img.w > 0 && img.h > 0) {
    const height = Math.min(img.h, maxHeight)
    return { height, width: Math.round((height * img.w) / img.h), known: true }
  }
  return { height: maxHeight, width: Math.round((maxHeight * 4) / 3), known: false }
}

export function MediaScope({ base, children }: { base: string; children: ReactNode }) {
  const [open, setOpen] = useState<TurnImage | null>(null)

  const url = (ref: string): string => `${base}/media/${encodeURIComponent(ref)}?token=${encodeURIComponent(getToken())}`

  // Esc closes the lightbox — the SAME contract as ShortcutsOverlay/
  // AgentModal: preventDefault so Chat.tsx's global handler (gated on
  // defaultPrevented) doesn't cancel a turn in progress just from closing the image.
  useEffect(() => {
    if (open === null) return
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <MediaCtx.Provider value={{ url, open: setOpen }}>
      {children}
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image viewer"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-ink/60 p-6"
          onMouseDown={() => setOpen(null)}
        >
          <button
            type="button"
            aria-label="close image"
            onClick={() => setOpen(null)}
            className="absolute top-4 right-4 rounded-full bg-canvas/80 p-1.5 text-ink-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
          >
            <X size={16} />
          </button>
          {/* the image at full size — clicking it also closes (there are
              no actions inside it), same as the background */}
          <img src={url(open.ref)} alt="full size image" className="max-h-[85vh] max-w-[92vw] rounded-lg object-contain shadow-lg" />
          {/* an honest footer: whatever's known from real data, nothing made up */}
          <div className="rounded-full bg-canvas/80 px-3 py-1 font-mono text-[10px] tracking-wider text-ink-2">
            {open.mediaType}
            {open.w !== undefined && open.h !== undefined ? ` · ${open.w}×${open.h}` : ''}
            {` · ${formatBytes(open.bytes)}`}
          </div>
        </div>
      ) : null}
    </MediaCtx.Provider>
  )
}

// an image the user pasted, inside their bubble — height capped to 288px,
// click opens the lightbox. Outside a MediaScope (shouldn't happen)
// degrades to a mute label with the metadata: never a crash, never a broken fetch.
export function UserImage({ img }: { img: TurnImage }) {
  const ctx = useContext(MediaCtx)
  if (!ctx) return <MuteLabel img={img} />
  // width + aspect-ratio (never a fixed height): if the container is
  // narrower than the box, max-w-full crops the width and the height
  // follows the ratio — deterministic BEFORE the bitmap loads, which is
  // what protects the bottom-lock. The same criterion in ToolThumbnail.
  const box = boxFor(img, 288)
  return (
    <button
      type="button"
      aria-label={`open image (${formatBytes(img.bytes)})`}
      onClick={() => ctx.open(img)}
      className="block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-line bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
      style={{ width: box.width, aspectRatio: `${box.width} / ${box.height}` }}
    >
      <img
        src={ctx.url(img.ref)}
        alt="pasted image"
        loading="lazy"
        decoding="async"
        className={`h-full w-full ${box.known ? 'object-contain' : 'object-cover'}`}
      />
    </button>
  )
}

// a compact thumbnail inside a tool's detail (a Read of a PNG, a
// subagent's screenshot…) — a fixed 96px height, the same lightbox.
export function ToolThumbnail({ img }: { img: TurnImage }) {
  const ctx = useContext(MediaCtx)
  if (!ctx) return <MuteLabel img={img} />
  const box = boxFor(img, 96)
  return (
    <button
      type="button"
      aria-label={`open tool result image (${formatBytes(img.bytes)})`}
      onClick={() => ctx.open(img)}
      className="block max-w-full cursor-zoom-in overflow-hidden rounded border border-line bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
      style={{ width: box.width, aspectRatio: `${box.width} / ${box.height}` }}
    >
      <img
        src={ctx.url(img.ref)}
        alt="tool result image"
        loading="lazy"
        decoding="async"
        className={`h-full w-full ${box.known ? 'object-contain' : 'object-cover'}`}
      />
    </button>
  )
}

// degradation with no scope: the image EXISTS in the data and it's said
// honestly — name + size — even though this tree can't resolve the URL.
function MuteLabel({ img }: { img: TurnImage }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-line bg-panel px-2 py-0.5 font-mono text-[10px] text-ink-2">
      image · {formatBytes(img.bytes)}
    </span>
  )
}
