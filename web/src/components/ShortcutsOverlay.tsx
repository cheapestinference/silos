// ShortcutsOverlay.tsx — a small modal with the keyboard-shortcuts cheat sheet.
// Opens with `?` (composer NOT focused — see the global handler in Chat.tsx,
// which ignores `?` when focus is on any text field) and closes with Esc, the X,
// or clicking outside. Escape/focus-trap/scroll-lock/restore come from <Modal>.
import { X } from 'lucide-react'
import { useStore } from '../store'
import { Modal } from './Modal'

const SHORTCUTS: { key: string; label: string }[] = [
  { key: 'Cmd/Ctrl+K', label: 'Search everything' },
  { key: 'Enter', label: 'Send' },
  { key: 'Shift+Enter', label: 'New line' },
  { key: '↑', label: 'Edit queued message' },
  { key: 'Esc', label: 'Interrupt turn / close dialog' },
  { key: 'Tab', label: 'Accept suggestion' },
  { key: 'Cmd/Ctrl+Enter', label: 'Send' },
]

export function ShortcutsOverlay() {
  const modal = useStore((s) => s.modal)
  const setModal = useStore((s) => s.setModal)
  if (modal !== 'shortcuts') return null

  return (
    <Modal onClose={() => setModal(null)} label="Keyboard shortcuts" size="sm" className="!p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg">Keyboard shortcuts</h2>
        <button
          type="button"
          aria-label="close"
          onClick={() => setModal(null)}
          className="rounded-full p-1 text-ink-2 hover:bg-panel hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
        >
          <X size={14} />
        </button>
      </div>
      <dl className="flex flex-col gap-1.5 text-sm">
        {SHORTCUTS.map((a) => (
          <div key={`${a.key}-${a.label}`} className="flex items-center justify-between gap-3">
            <dt className="shrink-0 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-xs text-ink">{a.key}</dt>
            <dd className="text-right text-ink-2">{a.label}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
