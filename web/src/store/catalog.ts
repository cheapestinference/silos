// store/catalog.ts — what the machine offers, loaded at boot: the model
// catalog, harnesses, providers and installed silos.
import type { StateCreator } from 'zustand'
import { api } from '../lib/api'
import { setHarnessDescriptors } from '../lib/harnesses'
import { reconcileSiloLooks } from '../lib/look'
import type { State } from './state'

export type CatalogSlice = Pick<State, 'catalog' | 'providers' | 'silos' | 'loadCatalog' | 'loadHarnesses' | 'loadProviders' | 'loadSilos'>

export const createCatalogSlice: StateCreator<State, [], [], CatalogSlice> = (set) => {
  return {
    silos: [],
    providers: [],
    catalog: [],

    // an honest catalog — boot-only, failure = an honest empty (the chips
    // fall back to "models seen in use" + Custom), never blocks startup.
    async loadCatalog() {
      try {
        const { models } = await api.models()
        set({ catalog: models })
      } catch (e) {
        console.warn('failed to load the model catalog:', e)
      }
    },

    async loadHarnesses() {
      try {
        // Promise.resolve: an automocked api answers undefined, not a promise
        const v = await Promise.resolve(api.harnesses())
        // lib/harnesses.ts holds the list (surfaces read it through
        // descriptorOf/useHarness, which subscribe to the module); the store
        // only triggers the load
        setHarnessDescriptors(v?.harnesses)
      } catch (e) {
        console.warn('failed to load the harnesses:', e)
      }
    },

    async loadProviders() {
      try {
        const providers = await api.providers.list()
        set({ providers: providers ?? [] })
      } catch (e) {
        console.warn('failed to load providers:', e)
      }
    },

    async loadSilos() {
      try {
        const { silos } = await api.silos.list()
        set({ silos })
        // a look chosen from a silo was painted from its cache at boot:
        // settle it against what the active silos bring now (lib/look.ts)
        reconcileSiloLooks(silos)
      } catch {
        // best-effort: an unread registry keeps the surface as it was (the
        // next silo event reads it again)
      }
    },
  }
}
