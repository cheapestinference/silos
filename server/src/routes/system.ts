// routes/system.ts — GET /api/system: the machine's vitals (contract vitals
// 2026-11-21) — disk by group over 30 days, memory over 7 days by the hour,
// load, the server's start and what Empty trash would free. Served from the
// sampler's files (machine-sampler.ts); only the live disk (no sample yet),
// memory total and load are read per request, all cheap and async. A read:
// the same auth as every read; an agent reaches it not (agent-authz.ts lists
// it nowhere).
import type { FastifyInstance } from 'fastify'
import { DISK_DAYS, osMem, readSamples, statfsDisk, systemView, type DiskStat, type MemStat } from '../machine-sampler.js'

export interface SystemRoutesCtx {
  /** the sampler's directory (<dataDir>/machine) */
  machineDir: string
  /** the path whose filesystem is measured (the dataDir) */
  diskPath: string
  /** when this server started, ISO */
  since: string
  disk?: DiskStat
  mem?: MemStat
  now?: () => number
}

export function systemRoutes(app: FastifyInstance, ctx: SystemRoutesCtx): void {
  app.get('/api/system', async () => {
    const nowMs = ctx.now?.() ?? Date.now()
    const samples = await readSamples(ctx.machineDir, nowMs - DISK_DAYS * 86_400_000, nowMs)
    const disk = samples.length > 0 ? null : await (ctx.disk ?? statfsDisk)(ctx.diskPath).catch(() => null)
    return systemView(samples, { nowMs, since: ctx.since, disk, mem: (ctx.mem ?? osMem)() })
  })
}
