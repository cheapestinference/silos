// SubNav.tsx — the second level of a page (the pieces INSIDE a section of
// the agent page, the kinds inside Knows): a segmented control, so what is
// inside a section never looks like a section.
import type { ReactNode } from 'react'

// the second level — a segmented control, never a second row of underlined
// tabs: what is inside a section must not look like a section
export function SubNav<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: [T, ReactNode][]; label?: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full flex-wrap gap-0.5 self-start rounded-lg border border-line bg-panel p-0.5">
      {items.map(([v, text]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-current={value === v || undefined}
          className={`flex items-baseline gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-[12.5px] transition-colors ${value === v ? 'bg-canvas text-ink shadow-sm' : 'text-ink-2 hover:text-ink'}`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}
