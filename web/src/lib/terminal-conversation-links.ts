// terminal-conversation-links.ts — in the real console, a session name
// (`silos-35`) or a session id the TUI prints becomes a link: underlined
// on hover, the conversation's title in a small card, a click opens it
// (lib/conversation-refs.ts resolves). The console's text is the program's
// own output and is never rewritten — the title rides on the hover.
import type { IDisposable, ILink, Terminal } from '@xterm/xterm'
import { cachedRef, ensureRefs, findRefs, type Found } from './conversation-refs'
import { useStore } from '../store'

// the line as text plus, for each character, the cell it sits in (a wide
// glyph — an emoji — takes two cells but is one character)
export function lineText(term: Terminal, y: number): { text: string; cellOf: number[] } | null {
  const line = term.buffer.active.getLine(y)
  if (!line) return null
  let text = ''
  const cellOf: number[] = []
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) cellOf.push(x)
    text += chars
  }
  return { text, cellOf }
}

let card: HTMLDivElement | null = null
function showCard(e: MouseEvent, title: string, sub: string): void {
  card ??= Object.assign(document.createElement('div'), {
    className: 'pointer-events-none fixed z-50 max-w-sm rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink shadow-lg',
  })
  card.replaceChildren(
    Object.assign(document.createElement('div'), { className: 'font-display text-[15px] leading-snug', textContent: title }),
    Object.assign(document.createElement('div'), { className: 'mt-0.5 text-xs text-ink-2', textContent: sub }),
  )
  card.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 340)}px`
  card.style.top = `${e.clientY + 16}px`
  if (!card.isConnected) document.body.appendChild(card)
}
function hideCard(): void {
  card?.remove()
}

export function registerConversationLinks(term: Terminal): IDisposable {
  const provider = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const y = bufferLineNumber - 1
      const read = lineText(term, y)
      const found: Found[] = read ? findRefs(read.text) : []
      if (!read || found.length === 0) {
        callback(undefined)
        return
      }
      void ensureRefs(found).then(() => {
        const links: ILink[] = []
        for (const f of found) {
          const ref = cachedRef(f.token)
          if (!ref) continue
          const start = read.cellOf[f.index]
          const end = read.cellOf[f.index + f.token.length - 1]
          if (start === undefined || end === undefined) continue
          const agent = useStore.getState().agents.find((a) => a.id === ref.agentId)
          const who = agent ? `${agent.emoji ? `${agent.emoji} ` : ''}${agent.name}` : ref.agentId
          links.push({
            range: { start: { x: start + 1, y: bufferLineNumber }, end: { x: end + 1, y: bufferLineNumber } },
            text: f.token,
            decorations: { underline: true, pointerCursor: true },
            activate: () => {
              hideCard()
              void useStore.getState().openSession(ref.folder, ref.sessionId)
            },
            hover: (e) => showCard(e, ref.title, `${who} · ${ref.live ? 'open now' : 'conversation'} — click to open`),
            leave: hideCard,
          })
        }
        callback(links.length > 0 ? links : undefined)
      })
    },
  })
  return {
    dispose: () => {
      hideCard()
      provider.dispose()
    },
  }
}
