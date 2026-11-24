// SystemTabs — the System house's tab row (lib/system-house.ts), drawn in
// the header of each of its pages: the System silo's lists, Files, Vault.
import { useStore } from '../store'
import { HeaderTabs } from './HeaderTabs'
import { systemTabOf, systemTabs } from '../lib/system-house'

export function SystemTabs() {
  const silos = useStore((s) => s.silos)
  const page = useStore((s) => s.page)
  const changePage = useStore((s) => s.changePage)
  const tabs = systemTabs(silos)
  const current = systemTabOf(page, silos) ?? ''
  return (
    <HeaderTabs
      label="System"
      value={current}
      items={tabs.map((t) => ({ id: t.id, label: t.label, testId: `system-tab-${t.id.replace(':', '-')}` }))}
      onChange={(id) => {
        const t = tabs.find((x) => x.id === id)
        if (t && id !== current) changePage(t.page)
      }}
    />
  )
}
