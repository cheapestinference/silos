// go-home.ts — where a thing is changed: its owner's page. Rows and notices
// that show something inherited point here instead of switching it in place
// (switches live only on the owner's page).
import { useStore } from '../../store'

export type Home =
  | { kind: 'settings'; tab: 'memories' | 'skills' | 'engines' }
  // `item`: the row the tab opens on, by the KEY its list made (a plugin's,
  // a failed server's — GET …/loads row keys, never a derived name);
  // `filter`: the chip it opens narrowed to (Tools: 'sign-in')
  | { kind: 'project'; folder: string; tab: 'memory' | 'files' | 'skills' | 'tools'; item?: string; filter?: 'sign-in' }
  | { kind: 'agent'; facet: 'memory' }
  | { kind: 'none' }

export function useGoHome(): (h: Home) => void {
  const changePage = useStore((s) => s.changePage)
  const changeProjectTab = useStore((s) => s.changeProjectTab)
  const setProjectItem = useStore((s) => s.setProjectItem)
  const changeTab = useStore((s) => s.changeTab)
  const openDossier = useStore((s) => s.openDossier)
  const selected = useStore((s) => s.selected)
  return (h) => {
    if (h.kind === 'settings') changePage({ kind: 'settings', tab: h.tab })
    else if (h.kind === 'project') {
      changePage({ kind: 'project', folder: h.folder })
      changeProjectTab(h.tab)
      if (h.item || h.filter) setProjectItem(h.item ?? null, h.filter ?? null)
    } else if (h.kind === 'agent') {
      if (selected) openDossier(h.facet)
      else changeTab(h.facet)
    }
  }
}
