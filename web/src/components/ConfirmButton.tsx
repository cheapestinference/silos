import { useEffect, useRef, useState, type ReactNode } from 'react'

// One arm→confirm button for destructive actions. First click ARMS (shows the
// confirm label); a second click within `timeoutMs` runs onConfirm; otherwise
// it disarms itself. Consolidates the several ad-hoc two-click patterns and,
// crucially, gives the actions that had NO confirmation (remove provider,
// delete context file) the same guard as trashing a conversation — a single
// stray click can no longer destroy something.
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Sure?',
  className = '',
  armedClassName = '',
  ariaLabel,
  title,
  disabled,
  timeoutMs = 3000,
}: {
  onConfirm: () => void
  children: ReactNode
  confirmLabel?: ReactNode
  className?: string
  armedClassName?: string
  ariaLabel?: string
  title?: string
  disabled?: boolean
  timeoutMs?: number
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={armed ? undefined : ariaLabel}
      title={title}
      onClick={() => {
        if (armed) {
          if (timer.current) clearTimeout(timer.current)
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
          timer.current = setTimeout(() => setArmed(false), timeoutMs)
        }
      }}
      className={armed && armedClassName ? armedClassName : className}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}
