// routes/task-seen.ts — «New to you» (task-seen-store.ts): the owner's marks
// on plan tasks, moved VERBATIM out of server.ts (the monoliths split by
// domain, behavior unchanged). An agent reaches neither route
// (agent-authz.ts lists neither), so what the owner has looked at stays the
// owner's.
import type { FastifyInstance } from 'fastify'
import type { TaskSeenStore } from '../task-seen-store.js'

export interface TaskSeenRoutesCtx {
  taskSeen: TaskSeenStore
}

export function taskSeenRoutes(app: FastifyInstance, ctx: TaskSeenRoutesCtx): void {
  const { taskSeen } = ctx
  app.get('/api/task-seen', async () => taskSeen.read())
  app.patch<{ Body: { key?: unknown; state?: unknown } }>('/api/task-seen', async (req, reply) => {
    const key = req.body?.key
    const state = req.body?.state
    if (typeof key !== 'string' || key.length > 1024 || !/.\/tasks\/./.test(key)) return reply.code(400).send({ error: "key must be a task's record key" })
    if (typeof state !== 'string' || state === '' || state.length > 40) return reply.code(400).send({ error: 'state required' })
    return { key, ...taskSeen.mark(key, state) }
  })
}
