import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

export function createTasksRouter(openclawBase, authMiddleware) {
  const router = Router();
  const cliBin = path.join(openclawBase, 'openclaw', 'node_modules', '.bin', 'openclaw');
  const configPath = path.join(openclawBase, 'openclaw.json');

  const cliEnv = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: openclawBase,
  };

  // Simple TTL cache to avoid spawning CLI on every request
  const cache = new Map();
  const CACHE_TTL = 3000;

  async function cachedExec(cacheKey, args) {
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && now - cached.ts < CACHE_TTL) return cached.data;

    const { stdout } = await execFileAsync(cliBin, args, {
      env: cliEnv,
      timeout: 10000,
      maxBuffer: 5 * 1024 * 1024,
    });

    // CLI may print warnings to stdout before JSON — find the JSON part
    const jsonStart = stdout.indexOf('{');
    const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
    const data = JSON.parse(jsonStr);
    cache.set(cacheKey, { data, ts: now });
    return data;
  }

  // GET /api/tasks — list task runs
  router.get('/api/tasks', authMiddleware, async (req, res) => {
    try {
      const args = ['tasks', 'list', '--json'];
      if (req.query.status) args.push('--status', req.query.status);
      if (req.query.runtime) args.push('--runtime', req.query.runtime);
      const cacheKey = `tasks:${req.query.status || ''}:${req.query.runtime || ''}`;
      const data = await cachedExec(cacheKey, args);
      res.json(data);
    } catch (err) {
      if (err.killed) return res.status(504).json({ error: 'CLI timeout' });
      console.error('[Tasks] CLI error:', err.message);
      res.status(500).json({ error: 'Failed to list tasks' });
    }
  });

  // GET /api/tasks/:lookup — show single task
  router.get('/api/tasks/:lookup', authMiddleware, async (req, res) => {
    try {
      const data = await cachedExec(`task:${req.params.lookup}`, ['tasks', 'show', req.params.lookup, '--json']);
      res.json(data);
    } catch (err) {
      if (err.killed) return res.status(504).json({ error: 'CLI timeout' });
      console.error('[Tasks] CLI error:', err.message);
      res.status(500).json({ error: 'Failed to show task' });
    }
  });

  // GET /api/flows — list task flows
  router.get('/api/flows', authMiddleware, async (req, res) => {
    try {
      const data = await cachedExec('flows', ['tasks', 'flow', 'list', '--json']);
      res.json(data);
    } catch (err) {
      if (err.killed) return res.status(504).json({ error: 'CLI timeout' });
      console.error('[Flows] CLI error:', err.message);
      res.status(500).json({ error: 'Failed to list flows' });
    }
  });

  // GET /api/flows/:lookup — show single flow
  router.get('/api/flows/:lookup', authMiddleware, async (req, res) => {
    try {
      const data = await cachedExec(`flow:${req.params.lookup}`, ['tasks', 'flow', 'show', req.params.lookup, '--json']);
      res.json(data);
    } catch (err) {
      if (err.killed) return res.status(504).json({ error: 'CLI timeout' });
      console.error('[Flows] CLI error:', err.message);
      res.status(500).json({ error: 'Failed to show flow' });
    }
  });

  return router;
}
