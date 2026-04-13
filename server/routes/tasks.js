import { Router } from 'express';

const SIDECAR_BASE = process.env.TASKS_SIDECAR_URL || 'http://127.0.0.1:9222';

export function createTasksRouter(_openclawBase, authMiddleware) {
  const router = Router();

  async function proxySidecar(path, init) {
    const res = await fetch(`${SIDECAR_BASE}${path}`, init);
    if (!res.ok) throw new Error(`Sidecar ${res.status}`);
    return res.json();
  }

  router.get('/api/tasks', authMiddleware, async (req, res) => {
    try {
      const params = new URLSearchParams();
      if (req.query.status) params.set('status', req.query.status);
      if (req.query.runtime) params.set('runtime', req.query.runtime);
      const qs = params.toString();
      const data = await proxySidecar(`/tasks${qs ? '?' + qs : ''}`);
      res.json(data);
    } catch (err) {
      console.error('[Tasks] sidecar error:', err.message);
      res.status(502).json({ error: 'Tasks service unavailable' });
    }
  });

  router.get('/api/tasks/:lookup', authMiddleware, async (req, res) => {
    try {
      const data = await proxySidecar(`/tasks/${encodeURIComponent(req.params.lookup)}`);
      res.json(data);
    } catch (err) {
      console.error('[Tasks] sidecar error:', err.message);
      res.status(502).json({ error: 'Tasks service unavailable' });
    }
  });

  router.post('/api/tasks/:lookup/cancel', authMiddleware, async (req, res) => {
    try {
      const data = await proxySidecar(
        `/tasks/${encodeURIComponent(req.params.lookup)}/cancel`,
        { method: 'POST' }
      );
      res.json(data);
    } catch (err) {
      console.error('[Tasks] cancel error:', err.message);
      res.status(502).json({ error: 'Task cancel unavailable' });
    }
  });

  router.get('/api/flows', authMiddleware, async (req, res) => {
    try {
      const data = await proxySidecar('/flows');
      res.json(data);
    } catch (err) {
      console.error('[Flows] sidecar error:', err.message);
      res.status(502).json({ error: 'Flows service unavailable' });
    }
  });

  router.get('/api/flows/:lookup', authMiddleware, async (req, res) => {
    try {
      const data = await proxySidecar(`/flows/${encodeURIComponent(req.params.lookup)}`);
      res.json(data);
    } catch (err) {
      console.error('[Flows] sidecar error:', err.message);
      res.status(502).json({ error: 'Flows service unavailable' });
    }
  });

  router.post('/api/flows/:lookup/cancel', authMiddleware, async (req, res) => {
    try {
      const data = await proxySidecar(
        `/flows/${encodeURIComponent(req.params.lookup)}/cancel`,
        { method: 'POST' }
      );
      res.json(data);
    } catch (err) {
      console.error('[Flows] cancel error:', err.message);
      res.status(502).json({ error: 'Flow cancel unavailable' });
    }
  });

  return router;
}
