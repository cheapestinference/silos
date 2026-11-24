// SignInDoor.tsx — the door a row that waits for your sign-in offers, the
// engine's own way (LoadsSignIn, loads-view.ts signInDoorOf): «Sign in ›» a
// new real console of an agent here with the row's sentence beside it to
// send (`menu`: named by that sentence, «/mcp in a console ›»); «Connect in
// <where> ›» a page outside Silos in a new tab — never a conversation. A
// plugin whose servers wait unfolds to them.
import type { ReactElement } from 'react'
import type { SignInDoorOf } from '../../lib/loads-view'

export function SignInDoor({
  door,
  onConsole,
  onUnfold,
  title,
  className = '',
  testId = 'sign-in',
}: {
  door: SignInDoorOf
  /** opens a console with this sentence beside it; null: no agent starts here (no door) */
  onConsole: ((draft: string) => void) | null
  onUnfold?: () => void
  /** what the door does, on hover */
  title?: string
  className?: string
  testId?: string
}): ReactElement | null {
  const look = `text-ink-2 hover:text-terracotta ${className}`
  if (door.via === 'link') {
    return (
      <a href={door.url} target="_blank" rel="noopener noreferrer" data-testid={testId} data-door="link" className={look}>
        Connect in {door.where} ›
      </a>
    )
  }
  if (door.via === 'unfold') {
    return onUnfold ? (
      <button type="button" onClick={onUnfold} data-testid={testId} data-door="unfold" className={look}>
        Sign in ›
      </button>
    ) : null
  }
  if (!onConsole) return null
  return (
    <button type="button" onClick={() => onConsole(door.draft)} title={title} data-testid={testId} data-door="console" className={look}>
      {door.menu ? (
        <>
          <span className="font-mono">{door.draft}</span> in a console ›
        </>
      ) : (
        'Sign in ›'
      )}
    </button>
  )
}
