// harnesses/opencode/pin.ts — what a model picked INSIDE the OpenCode TUI
// (/models) stands for as a Silos conversation pin (Harness.requestedModelPin,
// read by pin-follower.ts). Source: the reader's `requestedModel`, the last
// user message's provider/model. Mapping, OpenCode id → Silos pin (the
// inverse of launch.ts providerLaunch):
//   · `silos-<id>/<model>`     → provider <id> (a Silos key), model bare
//   · `<pid>/<model>` where a harness-provider/native row has providerId
//     pid                       → that row, model bare
//   · any other `<pid>/<model>` → the engine's own login (provider cleared),
//     model kept whole — providerLaunch names a `provider/model` id as is
import type { ProvidersStore } from '../../providers-store.js'
import type { ConsolePin } from '../contract.js'
import { splitModelRef } from './tui-client.js'

export function opencodeRefToPin(ref: string, providers: Pick<ProvidersStore, 'list' | 'get'>): ConsolePin | null {
  const parts = splitModelRef(ref)
  if (!parts) return null
  const { providerID, modelID } = parts
  if (providerID.startsWith('silos-')) {
    const id = providerID.slice('silos-'.length)
    const p = providers.get(id)
    if (!p || p.kind !== 'anthropic-compatible') return null // a key Silos no longer has: nothing to pin
    return { provider: id, model: modelID }
  }
  const row = providers.list().find((p) => (p.kind === 'harness-provider' || p.kind === 'harness-native') && p.providerId === providerID)
  if (row) return { provider: row.id, model: modelID }
  return { provider: null, model: ref }
}
