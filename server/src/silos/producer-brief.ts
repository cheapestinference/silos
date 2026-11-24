// silos/producer-brief.ts — the producing half of a silo, delivered (Silo
// Standard «two halves»: the producer instructions reach ONLY the declared
// producers, on both engines; step 1 Task 12).
//
// It rides the agent's system-prompt append (ChatService.appendFor) — the one
// per-agent text the server composes for every engine: the SDK chat turn, the
// Claude console (--append-system-prompt) and OpenCode (role.md + headless).
// So an agent bound to an ACTIVE silo wakes knowing what it produces, where,
// and the kernel's routes for it; with no active silo bound to it the append
// is byte-identical to before.
//
// Only explicit bindings (operator.json) receive it. A silo whose role is
// `any-agent` with nobody bound is produced through the skill its `via` names
// (plans: team-plan) — that skill IS its instruction channel; a bound
// producer whose session lacks the skill gets the brief (producerBriefFor).
import type { SiloRegistry } from './registry.js'
import type { SiloOperatorStore } from './operator.js'
import { kernelKind } from './kernel-kinds.js'
import { BRIEFING_FRAGMENTS } from '../briefing-fragments.js'
import type { VaultCredential } from '../vault-store.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export const API_BASE = '${SILOS_API:-http://127.0.0.1:3210}'

export interface ProducerBriefDeps {
  registry: Pick<SiloRegistry, 'list'>
  operator: Pick<SiloOperatorStore, 'producersOf' | 'audienceOff'>
  // the Vault entry NAMES (never values) this agent can count on, by class —
  // delivered in its env or signed by Silos (VaultStore.credentialsFor: the
  // winner per name over every folder of the agent)
  credentialNames?: (agentId: string) => VaultCredential[]
  // an agent in play (listed, not archived): an archived agent is briefed as
  // no silo's producer (surfaces.ts routes nothing to it)
  inPlay?: (agentId: string) => boolean
}

// The credentials sentence: the names the Vault really gives this agent that
// mention the service — nothing invented; never ~/secrets, never asked for.
// Two classes, each said its own way: a DELIVERED entry is read from the env;
// a SIGNED one is never in it — the agent calls the service through Silos,
// which adds the credential (routes/egress.ts).
export function credentialsLine(service: string, creds: readonly VaultCredential[]): string {
  const token = service.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const mine =
    token === ''
      ? []
      : creds.filter((c) =>
          c.name
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .includes(token),
        )
  if (mine.length === 0)
    return `Credentials: whatever ${service} needs comes from your environment (the Vault) — none is set for you yet; say so and stop rather than look in ~/secrets or ask for it.`
  const delivered = mine.filter((c) => !c.signed).map((c) => c.name)
  const signed = mine.filter((c) => c.signed).map((c) => c.name)
  const parts: string[] = []
  if (delivered.length > 0) parts.push(`read ${delivered.join(', ')} from your environment — the Vault puts ${delivered.length === 1 ? 'it' : 'them'} there`)
  for (const n of signed)
    parts.push(
      `sign with ${n} via ${API_BASE}/api/egress/${n}/<path on the service> — any method, your body as is, -H "Authorization: Bearer $SILOS_AGENT_TOKEN" -H "x-silos-turn: $SILOS_TURN"; Silos adds the credential (it is never in your environment)`,
    )
  return `Credentials: ${parts.join('; ')}. Never read ~/secrets or any file for them, never ask anyone for them, never write them anywhere.`
}

// The routes a producer uses, with its bearer.
export function kernelRoutes(siloId: string, opts: { sync: boolean; ownerFields: string[] }): string[] {
  const base = `${API_BASE}/api/silos/${siloId}/agents/$SILOS_AGENT_ID`
  const auth = '-H "Authorization: Bearer $SILOS_AGENT_TOKEN"'
  const lines = [
    `Read the merged view BEFORE writing (your records with the owner's changes over them): curl -s ${auth} ${base}/merged`,
    `Write one record: curl -s -X PUT ${auth} -H 'content-type: application/json' ${base}/records/<id> -d '{"record": {…}, "turn": "'"$SILOS_TURN"'"}' — the kernel validates it against the manifest and answers why when it does not read.`,
  ]
  if (opts.sync && opts.ownerFields.length > 0) {
    lines.push(
      `The owner's fields (${opts.ownerFields.join(', ')}) are the owner's: a value the owner set stands over your sync — never write over it. To change one, propose: curl -s -X POST ${auth} -H 'content-type: application/json' ${base}/proposals -d '{"recordId": "<id>", "field": "<field>", "value": …, "note": "…", "turn": "'"$SILOS_TURN"'"}'`,
    )
  }
  return lines
}

// The needs-you entries routed to THIS producer (audience: producer-agent,
// granted by the operator and not vetoed): the agent must know the queue is
// its own — the owner's inbox never lists those rows.
function routedEntriesLines(spec: Json, audienceOff: readonly number[]): string[] {
  const surfaces = isObj(spec.surfaces) ? spec.surfaces : {}
  const entries = (Array.isArray(surfaces['needs-you']) ? surfaces['needs-you'] : []).filter(isObj)
  const routed = entries.filter((n, i) => n.audience === 'producer-agent' && n.urgency !== 'blocking' && !audienceOff.includes(i))
  if (routed.length === 0) return []
  return [
    `These needs-you conditions are YOURS to work (audience: producer-agent) — the owner's inbox does not list them:`,
    ...routed.map(
      (n) =>
        `- rows matching \`${String(n.when)}\` until \`${String(n.clears)}\` — read them in the merged view and work them down; when one needs the owner's decision, say so where the owner reads it — \`waitingOn\` on its task, or \`needs_owner\` on the message that brought it.`,
    ),
  ]
}

export function producerBrief(manifest: Json, agentId: string, credentialNames: readonly VaultCredential[] = [], audienceOff: readonly number[] = []): string {
  const meta = isObj(manifest.metadata) ? manifest.metadata : {}
  const spec = isObj(manifest.spec) ? manifest.spec : {}
  const producer = isObj(spec.producer) ? spec.producer : {}
  const id = String(meta.id)
  const sync = isObj(producer.sync) ? producer.sync : null
  const kinds = isObj(spec.kinds) ? Object.values(spec.kinds).filter(isObj) : []
  const ownerFields = kinds.flatMap((k) => (Array.isArray(k.ownerWritable) ? k.ownerWritable.filter(isStr) : []))
  const out = [`## Silo you produce: ${String(meta.name)} (${id})`]
  if (isObj(producer.instructions) && isStr(producer.instructions.summary)) out.push(producer.instructions.summary)
  const protocol = isObj(producer.instructions) && Array.isArray(producer.instructions.protocol) ? producer.instructions.protocol.filter(isStr) : []
  if (protocol.length > 0) out.push('Protocol:', ...protocol.map((r) => `- ${r}`))
  if (sync) {
    out.push(
      `It is a sync from ${String(sync.service)}. The contract:`,
      ...(Array.isArray(sync.contract) ? sync.contract.filter(isStr) : []).map((r) => `- ${r}`),
    )
    if (isObj(sync.stateMap))
      out.push(
        `State map (export → state): ${Object.entries(sync.stateMap)
          .map(([k, v]) => `${k} → ${String(v)}`)
          .join(' · ')}`,
      )
  }
  const sources = (Array.isArray(spec.sources) ? spec.sources : []).filter(isObj)
  // a silo over a kernel kind the kernel writes ABOUT its bound agents
  // (task-wake): they write nothing in it — no record places, no routes
  if (!bindsThroughKernel(manifest)) {
    for (const s of sources) {
      if (s.root === 'agent-state') out.push(`Your records live at $SILOS_AGENT_STATE/${String(s.glob)} — one record per file.`)
      else out.push(`Your records live in each project you work in, at ${String(s.glob)} — one record per file.`)
    }
    out.push(...kernelRoutes(id, { sync: !!sync, ownerFields }))
  }
  out.push(...routedEntriesLines(spec, audienceOff))
  if (sync) out.push(credentialsLine(String(sync.service), credentialNames))
  out.push(`(${agentId} is bound to this silo's producer role by the owner.)`)
  return out.join('\n')
}

// A producer that produces THROUGH a skill (`producer.via`, plans' team-plan,
// support's support-inbox) carries its instructions in that skill — when the
// session LOADS it. The kernel then hands it no second, competing brief
// (support's kernelectomy: the helpdesk agent writes its case files the
// way its skill says). A session without the skill gets the brief instead
// (Claude Code producers bound to Support had no
// instructions at all — the skill was in no folder), the same rule the
// briefing follows for its own skills (briefing.ts: `.with` / `.without`,
// spec R7 — never an order to use a skill the session does not have).
export function producesThroughSkill(manifest: Json): boolean {
  const spec = isObj(manifest.spec) ? manifest.spec : {}
  return isObj(spec.producer) && isStr(spec.producer.via) && spec.producer.via.trim() !== ''
}

/** The skill `producer.via` names (`skill support-inbox` or a bare name) —
 *  null when there is none or it names another mechanism. */
export function viaSkill(manifest: Json): string | null {
  if (!producesThroughSkill(manifest)) return null
  const via = String(((manifest.spec as Json).producer as Json).via).trim()
  const m = /^(?:skill\s+)?([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(via)
  return m ? m[1]! : null
}

/** Whether a session whose skills are `has` already gets this silo's
 *  producer instructions some other way: through its `via` skill, or — for a
 *  skill the briefing itself stands in for (team-plan: plans) — through the
 *  briefing's `.without` fragment, which every session gets. A `via` that
 *  names no skill is a mechanism of its own: it stays the channel. */
export function instructedElsewhere(manifest: Json, has: readonly string[]): boolean {
  if (!producesThroughSkill(manifest)) return false
  const skill = viaSkill(manifest)
  if (skill === null) return true
  return has.includes(skill) || (BRIEFING_FRAGMENTS as readonly string[]).includes(skill)
}

// A silo whose only source is a kernel kind the kernel writes about the
// agents bound to it (kernel-kinds.ts `binds: 'producers'` — Task mode's
// wakes): its producers are bound to a PROTOCOL, not to records.
export function bindsThroughKernel(manifest: Json): boolean {
  const spec = isObj(manifest.spec) ? manifest.spec : {}
  const sources = (Array.isArray(spec.sources) ? spec.sources : []).filter(isObj)
  return sources.length === 1 && sources[0]!.root === 'kernel' && kernelKind(String(sources[0]!.kind))?.binds === 'producers'
}

// Every ACTIVE silo this agent is bound to produce, as one block — null when
// none (the append stays as it was). `has`: the skills the launch loads (the
// same set its briefing is composed for).
export function producerBriefFor(agentId: string, has: readonly string[], deps: ProducerBriefDeps): string | null {
  if (deps.inPlay && !deps.inPlay(agentId)) return null
  const blocks: string[] = []
  for (const e of deps.registry.list()) {
    if (e.status.state !== 'active' || !e.manifest) continue
    if (instructedElsewhere(e.manifest, has)) continue
    if (!(deps.operator.producersOf(e.id) ?? []).includes(agentId)) continue
    blocks.push(producerBrief(e.manifest, agentId, deps.credentialNames?.(agentId) ?? [], deps.operator.audienceOff(e.id)))
  }
  return blocks.length > 0 ? `# Silos\n\n${blocks.join('\n\n')}` : null
}
