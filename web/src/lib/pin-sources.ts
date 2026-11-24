// pin-sources.ts — a registry of pin sources. Each source knows how to
// RESOLVE a ref (specific to it) into a renderable item: a title, an
// optional state, and an open action. The cross-cutting Pinned rail
// iterates the pins and delegates to the matching source; adding a source
// here never touches Pinned.
import { useStore } from '../store'
import { sessionSignal, type SessionSignal } from './live'

export interface PinItem {
  title: string
  // an OPTIONAL state — each source decides if it applies (Claude Code:
  // the same two-state dot as the tree's rows — blinking = working,
  // solid = needs you; a static document wouldn't use it).
  signal?: SessionSignal
  // the item currently selected (for Pinned's selection accent).
  active?: boolean
  onOpen: () => void
}

export interface PinSource {
  id: string
  // the source's mark in Pinned (tells silos apart at a glance). `#` means
  // "a channel": PinnedRow sets it flush against the title, exactly like
  // the conversation rows in the tree.
  glyph: string
  resolve(ref: string): PinItem | null // null = the item no longer exists
}

// Claude Code: ref = a session's "folder/id". A pinned conversation IS a
// channel, so it reads as one (#title) — the ✻ it used to carry has no
// glyph in the webfont and rendered as a tofu box.
const claude: PinSource = {
  id: 'claude',
  glyph: '#',
  resolve(ref) {
    const st = useStore.getState()
    const session = st.agents.flatMap((a) => a.sessions).find((s) => `${s.folder}/${s.id}` === ref)
    if (!session) return null
    const active = st.selected?.folder === session.folder && st.selected?.id === session.id
    return {
      title: session.title,
      signal: sessionSignal(session, st.nowTick, active),
      active,
      onOpen: () => void st.openSession(session.folder, session.id),
    }
  },
}

// A pin whose source is not registered resolves to null, the same as an
// item that no longer exists.
export const pinSources: Record<string, PinSource> = { claude }
