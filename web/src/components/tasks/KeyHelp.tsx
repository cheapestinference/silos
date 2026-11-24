// KeyHelp — the keyboard's cheat sheet: `?` on Tasks, the Needs you sheet and a
// task's page, or its small key beside them on a desk. Never on a phone: it has
// no keys to teach.
import { Modal } from '../Modal'

const GROUPS: ReadonlyArray<{ title: string; rows: ReadonlyArray<[ReadonlyArray<string>, string]> }> = [
  {
    title: 'In a list',
    rows: [
      [['j', '↓'], 'Next row'],
      [['k', '↑'], 'Previous row'],
      [['Enter', 'o'], 'Open it'],
      [['d'], 'Done, on a task of yours'],
      [['Esc'], 'Let go of the row, then back'],
    ],
  },
  {
    title: 'On a task',
    rows: [
      [['j', 'k'], 'Next and previous in its list'],
      [['d'], 'Done, on a task of yours'],
      [['n'], 'Write a note'],
      [['Esc'], 'Back to where you came from'],
    ],
  },
  {
    title: 'Anywhere here',
    rows: [
      [['g h'], 'Go to Home'],
      [['g t'], 'Go to Tasks'],
      [['?'], 'This list'],
    ],
  },
]

function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[5px] border border-line bg-panel px-1.5 font-mono text-[11px] text-ink">
      {children}
    </kbd>
  )
}

export function KeyHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} label="Keyboard" size="sm">
      <div data-testid="key-help">
        <h2 className="font-display text-[20px] leading-tight text-ink">Keyboard</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-2">The order holds still while you work. It settles when you stop.</p>
        {GROUPS.map((g) => (
          <section key={g.title} className="mt-4">
            <h3 className="text-[12px] text-ink-3">{g.title}</h3>
            <dl className="mt-1">
              {g.rows.map(([keys, what]) => (
                <div key={what} className="grid grid-cols-[5.75rem_1fr] items-center gap-2 py-[3px]">
                  <dt className="flex items-center gap-1">
                    {keys.map((k) => (
                      <Key key={k}>{k}</Key>
                    ))}
                  </dt>
                  <dd className="text-[13px] text-ink">{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  )
}

// the door to it on a desk: one small key, nothing on a touch screen
export function KeyHint({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Keyboard"
      title="Keyboard ( ? )"
      data-testid="key-hint"
      className="hidden h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] border border-line font-mono text-[11px] text-ink-3 hover:border-ink-3 hover:text-ink md:inline-flex [@media(hover:none)]:!hidden"
    >
      ?
    </button>
  )
}
