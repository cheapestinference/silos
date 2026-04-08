import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';

export function createLobsterRouter(openclawBase, authMiddleware) {
  const router = Router();
  const agentsDir = path.join(openclawBase, 'agents');

  async function findLobsterFiles() {
    const results = [];
    try {
      const agentDirs = await fs.readdir(agentsDir);
      for (const agentId of agentDirs) {
        const agentPath = path.join(agentsDir, agentId);
        const stat = await fs.stat(agentPath).catch(() => null);
        if (!stat?.isDirectory()) continue;

        const dirsToScan = [agentPath];
        const workspacePath = path.join(agentPath, 'workspace');
        const wsStat = await fs.stat(workspacePath).catch(() => null);
        if (wsStat?.isDirectory()) dirsToScan.push(workspacePath);

        for (const dir of dirsToScan) {
          try {
            const files = await fs.readdir(dir);
            for (const file of files) {
              if (!file.endsWith('.lobster')) continue;
              const filePath = path.join(dir, file);
              try {
                const content = await fs.readFile(filePath, 'utf8');
                const parsed = yaml.load(content) || {};
                const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
                results.push({
                  agentId,
                  filename: file,
                  name: parsed.name || file.replace('.lobster', ''),
                  stepCount: steps.length,
                  hasApproval: steps.some(s => s.approval === 'required' || s.approval === 'optional'),
                  hasLlmTask: steps.some(s => (s.command || '').includes('llm-task')),
                });
              } catch { /* skip unparseable files */ }
            }
          } catch { /* skip unreadable dirs */ }
        }
      }
    } catch { /* agents dir may not exist */ }
    return results;
  }

  router.get('/api/lobster/files', authMiddleware, async (_req, res) => {
    try {
      const files = await findLobsterFiles();
      res.json({ files });
    } catch (err) {
      console.error('[Lobster] Error scanning files:', err.message);
      res.status(500).json({ error: 'Failed to scan lobster files' });
    }
  });

  router.get('/api/lobster/files/:agentId/:filename', authMiddleware, async (req, res) => {
    const { agentId, filename } = req.params;
    if (agentId.includes('..') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!filename.endsWith('.lobster')) {
      return res.status(400).json({ error: 'Not a .lobster file' });
    }

    const possiblePaths = [
      path.join(agentsDir, agentId, filename),
      path.join(agentsDir, agentId, 'workspace', filename),
    ];

    for (const filePath of possiblePaths) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = yaml.load(content) || {};
        const steps = (Array.isArray(parsed.steps) ? parsed.steps : []).map((s, i) => ({
          id: s.id || `step-${i}`,
          command: s.command || '',
          stdin: s.stdin || undefined,
          condition: s.condition || undefined,
          approval: s.approval || undefined,
          env: s.env || undefined,
        }));
        return res.json({
          agentId,
          filename,
          name: parsed.name || filename.replace('.lobster', ''),
          args: parsed.args || undefined,
          steps,
          raw: content,
        });
      } catch { /* try next path */ }
    }

    res.status(404).json({ error: 'File not found' });
  });

  return router;
}
