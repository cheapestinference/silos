// settings/primitives.tsx — the ONE layout every Settings section is built
// from (Page → Section → SettingRow), shared by SettingsPage.tsx and the
// sections that live in their own file (settings/Territory.tsx).
import type { ReactNode } from 'react'

// Page: the reading column. Sections stack with a hairline between them.
export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-2xl divide-y divide-line px-6 pb-16 md:px-10">{children}</div>
}

// Section: a display title, an optional one-line description in the
// muted ink, then the body. The title is the only serif on the page.
export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="py-8 first:pt-8">
      <header className="mb-4">
        <h2 className="font-display text-[19px] leading-tight text-ink">{title}</h2>
        {description ? <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-2">{description}</p> : null}
      </header>
      <div className="text-sm text-ink-2">{children}</div>
    </section>
  )
}

// SettingRow: a preference — label + hint on the left, its control on the
// right, hairline between rows. The control is whatever the preference
// needs (a switch, a quiet button, a value) — never a black CTA.
export function SettingRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-t border-line py-3 first:border-t-0 first:pt-0">
      {/* a phone can't hold both: past the label's floor the control drops under it */}
      <div className="min-w-[11rem] flex-1">
        <div className="text-sm text-ink">{label}</div>
        {hint ? <div className="mt-0.5 text-xs leading-relaxed text-ink-2">{hint}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  )
}

// a quiet action: bordered, ink on hover. The page's only button style.
export const QUIET_BTN =
  'rounded-md border border-line bg-panel px-2.5 py-1 text-xs font-medium text-ink transition-colors duration-150 hover:border-ink-2 disabled:opacity-50'
