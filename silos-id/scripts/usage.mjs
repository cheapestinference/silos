#!/usr/bin/env node
// How the broker is used: every registered instance with its boots and
// sign-ins, then every person who signed in. Reads the broker's KV through
// wrangler (your `wrangler login`), never through the broker itself — no
// route serves usage.
//
//   npm run usage              tables
//   npm run usage -- --json    the raw instance records
//
// The namespace is the one titled INSTANCES on your account, or
// SILOS_ID_KV=<namespace id>.
import { execFileSync } from 'node:child_process'

const WRANGLER = ['--yes', 'wrangler@4.159.0']
const wrangler = (...args) => execFileSync('npx', [...WRANGLER, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
const jsonOut = (out) => JSON.parse(out.slice(out.search(/[[{]/)))

function namespaceId() {
  if (process.env.SILOS_ID_KV) return process.env.SILOS_ID_KV
  const ns = jsonOut(wrangler('kv', 'namespace', 'list')).find((n) => n.title === 'INSTANCES')
  if (!ns) throw new Error('no KV namespace titled INSTANCES on this account — set SILOS_ID_KV')
  return ns.id
}

const ns = namespaceId()
const keys = jsonOut(wrangler('kv', 'key', 'list', '--namespace-id', ns, '--prefix', 'id:', '--remote'))
const records = keys.map(({ name }) => ({ id: name.slice(3), ...JSON.parse(wrangler('kv', 'key', 'get', name, '--namespace-id', ns, '--remote')) }))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(records, null, 2))
  process.exit(0)
}

const DAY = 86_400_000
const now = Date.now()
const dayOf = (t) => new Date(t).toISOString().slice(0, 10)
const since = (n) => dayOf(now - (n - 1) * DAY)
const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '—')
const activeDays = (days, n) => Object.entries(days ?? {}).filter(([d, u]) => d >= since(n) && u.logins > 0).length

function table(rows, cols) {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)))
  const line = (cells) => cells.map((v, i) => String(v).padEnd(w[i])).join('  ')
  console.log(line(cols))
  console.log(line(w.map((n) => '─'.repeat(n))))
  for (const r of rows) console.log(line(cols.map((c) => r[c])))
}

records.sort((a, b) => (b.lastLoginAt ?? b.lastBootAt ?? 0) - (a.lastLoginAt ?? a.lastBootAt ?? 0))
console.log(`\nInstances (${records.length}) — times UTC, active = days with a sign-in\n`)
table(
  records.map((r) => {
    const people = new Set(
      Object.entries(r.days ?? {})
        .filter(([d]) => d >= since(30))
        .flatMap(([, u]) => Object.keys(u.users)),
    )
    return {
      origin: r.origin,
      registered: when(r.registeredAt),
      boots: r.boots ?? '—',
      'last boot': when(r.lastBootAt),
      'sign-ins': r.logins ?? 0,
      'last sign-in': when(r.lastLoginAt),
      'active 7d': activeDays(r.days, 7),
      'active 30d': activeDays(r.days, 30),
      'people 30d': people.size,
    }
  }),
  ['origin', 'registered', 'boots', 'last boot', 'sign-ins', 'last sign-in', 'active 7d', 'active 30d', 'people 30d'],
)

const people = new Map()
for (const r of records) {
  for (const [d, u] of Object.entries(r.days ?? {})) {
    for (const [email, n] of Object.entries(u.users)) {
      const p = people.get(email) ?? { email, instances: new Set(), days: new Set(), signIns: 0, last: '' }
      p.instances.add(new URL(r.origin).host)
      p.days.add(d)
      p.signIns += n
      if (d > p.last) p.last = d
      people.set(email, p)
    }
  }
}
console.log(`\nPeople (${people.size}) — last ${90} days\n`)
table(
  [...people.values()]
    .sort((a, b) => b.last.localeCompare(a.last))
    .map((p) => ({
      email: p.email,
      instances: [...p.instances].join(', '),
      'sign-ins': p.signIns,
      'active days': p.days.size,
      'active 7d': [...p.days].filter((d) => d >= since(7)).length,
      'last day': p.last,
    })),
  ['email', 'instances', 'sign-ins', 'active days', 'active 7d', 'last day'],
)
console.log()
