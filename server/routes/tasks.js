import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execFileAsync = promisify(execFile);

export function createTasksRouter(openclawBase, authMiddleware) {
  const router = Router();
  const cliBin = process.env.OPENCLAW_CLI || 'openclaw';
  const configPath = path.join(openclawBase, 'openclaw.json');
  const cacheDir = path.join(openclawBase, 'tasks-cache');

  const cliEnv = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: openclawBase,
  };

  // Try reading from sidecar cache file first (instant), fall back to CLI spawn
  async function readCacheFile(filename) {
    try {
      const raw = await fs.readFile(path.join(cacheDir, filename), 'utf8');
      return JSON.parse(raw);
    } catch { return null; }
  }

  // In-memory cache for CLI fallback
  const memCache = new Map();
  const MEM_CACHE_TTL = 5000;

  async function execCli(cacheKey, args) {
    const now = Date.now();
    const cached = memCache.get(cacheKey);
    if (cached && now - cached.ts < MEM_CACHE_TTL) return cached.data;

    const { stdout, stderr } = await execFileAsync(cliBin, args, {
      env: cliEnv,
      timeout: 60000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const raw = stdout || stderr || '';
    const jsonStart = raw.indexOf('{');
    const jsonStr = jsonStart >= 0 ? raw.slice(jsonStart) : raw;
    const data = JSON.parse(jsonStr);
    memCache.set(cacheKey, { data, ts: now });
    return data;
  }

  // GET /api/tasks — list task runs
  router.get('/api/tasks', authMiddleware, async (req, res) => {
    try {
      // Fast path: sidecar cache (no filters)
      if (!req.query.status && !req.query.runtime) {
        const cached = await readCacheFile('tasks.json');
        if (cached) return res.json(cached);
      }
      // Slow path: CLI spawn
      const args = ['tasks', 'list', '--json'];
      if (req.query.status) args.push('--status', req.query.status);
      if (req.query.runtime) args.push('--runtime', req.query.runtime);
      const data = await execCli(`tasks:${req.query.status || ''}:${req.query.runtime || ''}`, args);
      res.json(data);
    } catch (err) {
      if (err.killed) return res.status(504).json({ error: 'CLI timeout' });
      console.error('[Tasks] CLI error:', err.message);
      res.status(500).json({ error: 'Failed to list tasks' });
    }
  });

  // GET /api/tasks/:lookup — show single task (always CLI, no cache file)
  router.get('/api/tasks/:lookup', authMiddleware, async (req, res) => {
    try {
      const data = await execCli(`task:${req.params.lookup}`, ['tasks', 'show', req.params.lookup, '--json']);
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
      const cached = await readCacheFile('flows.json');
      if (cached) return res.json(cached);
      const data = await execCli('flows', ['tasks', 'flow', 'list', '--json']);
      res.json(data);
    } catch (err) {
      if (err.killed) return res.status(504).json({ error: 'CLI timeout' });
      console.error('[Flows] CLI error:', err.message);
      res.status(500).json({ error: 'Failed to list flows' });
    }
  });

  // GET /api/flows/:lookup — show single flow (always CLI)
  router.get('/api/flows/:lookup', authMiddleware, async (req, res) => {
    try {
      const data = await execCli(`flow:${req.params.lookup}`, ['tasks', 'flow', 'show', req.params.lookup, '--json']);
      res.json(data);
    } catch (err) {
      if (err.killed) return res.status(504).json({ error: 'CLI timeout' });
      console.error('[Flows] CLI error:', err.message);
      res.status(500).json({ error: 'Failed to show flow' });
    }
  });

  return router;
}
