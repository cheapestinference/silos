// The one test helper for bearer writes: every write
// an agent makes names the live turn it comes from — `"turn": "$SILOS_TURN"`.
// A test that plays an agent mints a live turn for it in the server's
// registry (the ChatService's own, or the LiveTurns handed to buildServer)
// and sends its token.
import { LiveTurns, type TurnDeclaration } from '../../src/live-turns.js'

type Holder = LiveTurns | { liveTurns: LiveTurns }

const registryOf = (h: Holder): LiveTurns => (h instanceof LiveTurns ? h : h.liveTurns)

/** A live turn of `agentId` (a chat turn unless told), its token. */
export function liveTurnOf(h: Holder, agentId: string, turn: TurnDeclaration = { class: 'chat' }): string {
  return registryOf(h).mintTurn({ agentId, turnId: `test-${agentId}`, turn })
}

/** `payload` with the `turn` of a live turn of `agentId`. */
export function withTurn<T extends object>(h: Holder, agentId: string, payload: T, turn?: TurnDeclaration): T & { turn: string } {
  return { ...payload, turn: liveTurnOf(h, agentId, turn) }
}

type Injectable = { inject: (opts: any) => any }
type Tokens = { agentIdOf(token: string): string | null }

/** Every bearer write `app.inject` sends from here on carries a live turn
 *  of its agent (in the body; the x-silos-turn header on a DELETE) — for
 *  route tests whose subject is not the turn itself. A payload that already
 *  names `turn` (even as undefined) is left exactly as it is. */
export function bearerWritesCarryTurns(app: Injectable, h: Holder, tokens: Tokens): void {
  const inject = app.inject.bind(app)
  app.inject = (opts: any) => {
    if (typeof opts !== 'object' || opts === null) return inject(opts)
    const method = String(opts.method ?? 'GET').toUpperCase()
    const authz = opts.headers?.authorization
    const m = typeof authz === 'string' ? /^Bearer\s+(\S+)/i.exec(authz) : null
    const agentId = m ? tokens.agentIdOf(m[1]!) : null
    if (!agentId || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return inject(opts)
    if (method === 'DELETE') {
      if (opts.headers['x-silos-turn'] !== undefined) return inject(opts)
      return inject({ ...opts, headers: { ...opts.headers, 'x-silos-turn': liveTurnOf(h, agentId) } })
    }
    const p = opts.payload ?? opts.body
    if (p !== undefined && (typeof p !== 'object' || p === null || Array.isArray(p) || Buffer.isBuffer(p) || 'turn' in p)) return inject(opts)
    const { body: _b, ...rest } = opts
    return inject({ ...rest, payload: { ...(p ?? {}), turn: liveTurnOf(h, agentId) } })
  }
}
