// new-entries.ts — the four things that can be started in Silos (how to
// create projects and agents must be obvious). ONE list:
// the sidebar's "+ New" menu and ⌘K both read it, so they never disagree.
import { useStore } from '../store'
import { MASTER_ID } from './constants'

export const NEW_ENTRIES: ReadonlyArray<{ label: string; hint: string; run: () => void }> = [
  { label: 'New project', hint: 'A folder, with its own agent', run: () => useStore.getState().setModal('new-project') },
  { label: 'New agent', hint: 'Who works, where, and how', run: () => useStore.getState().setModal('create') },
  {
    label: 'New conversation',
    hint: 'With Anywhere, in a folder you pick',
    run: () => {
      const s = useStore.getState()
      if (!s.agents.some((a) => a.id === MASTER_ID)) return
      s.selectAgent(MASTER_ID)
      s.startNewConversation()
    },
  },
  { label: 'New automation', hint: 'Something that runs on its own', run: () => useStore.getState().changePage({ kind: 'automation', id: 'new' }) },
]
