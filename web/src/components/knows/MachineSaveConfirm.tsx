// MachineSaveConfirm.tsx — the second click before a save writes one of your
// machine's instruction files (spec memory-places §5, owner 24-11): the
// server refuses such a write without `confirmed: true` (409 «confirm: …»,
// memory-service.ts), so the editor shows the reach sentence in place of its
// buttons and resends only on «Save for every project on this machine».
import { ApiError } from '../../lib/api'

/** The server's refusal of a machine write that was not confirmed. */
export function needsMachineConfirm(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && e.message.startsWith('confirm')
}

export function MachineSaveConfirm({ saving, onConfirm, onKeepEditing }: { saving: boolean; onConfirm: () => void; onKeepEditing: () => void }) {
  return (
    <div role="group" aria-label="Confirm saving a machine file" className="mt-3 rounded-lg border border-line bg-panel px-3 py-2.5">
      <p className="text-sm text-ink">This file reaches every project on this machine — every conversation of every agent reads it from its next start.</p>
      <div className="mt-2 flex items-center justify-end gap-3">
        <button type="button" onClick={onKeepEditing} className="text-sm text-ink-2 hover:text-ink">
          Keep editing
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={saving}
          className="rounded-lg bg-terracotta px-3 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save for every project on this machine'}
        </button>
      </div>
    </div>
  )
}
