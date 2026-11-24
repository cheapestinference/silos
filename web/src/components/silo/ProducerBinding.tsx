// ProducerBinding — who a silo is bound to, and the owner's door to change it
// after the approval (operator producers, PATCH /api/silos/:id/operator).
// Shown for a protocol silo and for every records silo with a role to bind:
// nobody bound yet says «No producer yet · Bind ›» (a role is a word of the
// manifest, never an agent); a bound one shows only the door «Change who
// writes it» — its header already names the writers (each thing once), and
// naming them is not being able to change them. For a protocol silo
// (Task mode — its records are kept by Silos about the agents bound to it)
// the words say what binding means there: those agents work in task mode,
// everyone else keeps working as today. The server's answer repaints the
// line; nothing is pretended.
import { useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import type { SiloDescriptor } from '../../lib/types'

export function ProducerBinding({ silo }: { silo: Pick<SiloDescriptor, 'id' | 'producer' | 'producers' | 'kernel'> }) {
  const agents = useStore((s) => s.agents)
  const loadSilos = useStore((s) => s.loadSilos)
  const [editing, setEditing] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const role = silo.producer?.role ?? null
  if (!role || role === 'kernel') return null
  const protocol = silo.kernel != null // a kernel kind written about bound agents
  const bound = silo.producers ?? []
  // `any-agent` is a rule, nobody to bind
  if (!protocol && role === 'any-agent') return null
  // a bound records silo already says its writers in its header («written
  // by finance») — here only the door to change them, never the names twice
  const named = !protocol && bound.length > 0
  const inPlay = agents.filter((a) => !a.archived)
  const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? id

  async function save(next: string[]): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api.silos.operator(silo.id, { producers: next })
      await loadSilos()
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const said =
    bound.length === 0
      ? protocol
        ? 'Silos wakes nobody on their tasks yet — every agent waits to be spoken to.'
        : 'No producer yet ·'
      : protocol
        ? `Silos wakes ${bound.map(name).join(', ')} on their tasks. The rest wait to be spoken to.`
        : `Bound to ${role}: ${bound.map(name).join(', ')}.`

  return (
    <div className="mt-2 max-w-[62ch]" data-testid="silo-binding">
      {editing === null ? (
        <p className="text-[12.5px] text-ink-2">
          {named ? null : <>{said} </>}
          <button
            type="button"
            onClick={() => setEditing(bound)}
            className="text-ink underline decoration-line underline-offset-2 hover:text-terracotta hover:decoration-terracotta"
          >
            {bound.length === 0 ? (protocol ? 'Choose agents' : 'Bind ›') : named ? 'Change who writes it' : 'Change'}
          </button>
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save(editing)
          }}
          className="rounded-lg border border-line bg-panel/50 px-3 py-2.5"
        >
          <p className="text-[12.5px] text-ink">
            {protocol ? 'Who Silos wakes on their tasks (they get the task rules at start):' : `Who writes these records (the role ${role}):`}
          </p>
          <fieldset className="mt-2 flex flex-wrap gap-1.5" aria-label={protocol ? 'Agents Silos wakes on their tasks' : 'Producers'}>
            {inPlay.map((a) => {
              const on = editing.includes(a.id)
              return (
                <label
                  key={a.id}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] focus-within:ring-2 focus-within:ring-terracotta/40 ${on ? 'border-terracotta/50 bg-terracotta-soft text-ink' : 'border-line text-ink-2 hover:border-ink-3'}`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() => setEditing(on ? editing.filter((x) => x !== a.id) : [...editing, a.id])}
                  />
                  {a.emoji ? <span aria-hidden="true">{a.emoji}</span> : null}
                  {a.name}
                </label>
              )
            })}
          </fieldset>
          <span className="mt-2.5 flex items-center gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-full border border-terracotta/40 bg-terracotta-soft px-3 py-0.5 text-[12px] font-medium text-terracotta hover:border-terracotta disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(null)
                setError(null)
              }}
              className="text-[12px] text-ink-3 hover:text-ink"
            >
              Cancel
            </button>
          </span>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-[11.5px] text-terracotta">
          {error}
        </p>
      ) : null}
    </div>
  )
}
