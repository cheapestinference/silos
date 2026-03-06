import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { validateAgentId, resolveAndValidatePath } from '../validation.js';

const MAX_FILES = 500;
const SKIP_DIRS = new Set([
  'node_modules', 'venv', '.venv', '__pycache__', 'dist', 'build',
  '.cache', '.tox', 'env', '.env', '.mypy_cache', '.pytest_cache',
  'site-packages', '.next', 'target', 'vendor',
]);

function getWorkspaceDir(openclawBase, agentId) {
  return {
    defaultWorkspace: path.join(openclawBase, 'workspace'),
    agentWorkspace: path.join(openclawBase, 'agents', agentId, 'workspace'),
    legacyWorkspace: path.join(openclawBase, `workspace-${agentId}`),
  };
}

async function resolveAgentDir(openclawBase, agentId) {
  const { defaultWorkspace, agentWorkspace, legacyWorkspace } = getWorkspaceDir(openclawBase, agentId);
  for (const dir of [agentWorkspace, legacyWorkspace, defaultWorkspace]) {
    try { await fs.access(dir); return dir; } catch {}
  }
  return null;
}

async function ensureAgentDir(openclawBase, agentId) {
  const existing = await resolveAgentDir(openclawBase, agentId);
  if (existing) return existing;
  const { agentWorkspace } = getWorkspaceDir(openclawBase, agentId);
  await fs.mkdir(agentWorkspace, { recursive: true });
  return agentWorkspace;
}

async function walkDir(dir, relativePath, files) {
  if (files.length >= MAX_FILES) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.name.startsWith('.')) continue;
    const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      const stats = await fs.stat(fullPath);
      files.push({ path: entryRelPath, size: stats.size, mtime: stats.mtimeMs, type: 'file' });
    } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      files.push({ path: entryRelPath, size: 0, mtime: 0, type: 'directory' });
      await walkDir(fullPath, entryRelPath, files);
    }
  }
}

function handlePathTraversal(error, res) {
  if (error.message === 'Path traversal detected') {
    res.status(403).json({ error: 'Forbidden' });
    return true;
  }
  return false;
}

export function createMemoryRouter(openclawBase, authMiddleware) {
  const router = Router();

  router.use('/api/memory', authMiddleware);

  // List files
  router.get('/api/memory/:agentId', async (req, res) => {
    try {
      const { agentId } = req.params;
      if (!validateAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      const agentDir = await resolveAgentDir(openclawBase, agentId);
      if (!agentDir) return res.json({ files: [] });
      const files = [];
      await walkDir(agentDir, '', files);
      files.sort((a, b) => b.mtime - a.mtime);
      res.json({ files });
    } catch (error) {
      console.error('[Memory] Error listing files:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Read file
  router.get('/api/memory/:agentId/file', async (req, res) => {
    try {
      const { agentId } = req.params;
      const filePath = req.query.path;
      if (!validateAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      if (!filePath) return res.status(400).json({ error: 'path query parameter is required' });
      const agentDir = await resolveAgentDir(openclawBase, agentId);
      if (!agentDir) return res.status(404).json({ error: 'Workspace not found' });
      const fullPath = resolveAndValidatePath(agentDir, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      res.json({ content });
    } catch (error) {
      if (handlePathTraversal(error, res)) return;
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      console.error('[Memory] Error reading file:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Write file
  router.post('/api/memory/:agentId/file', async (req, res) => {
    try {
      const { agentId } = req.params;
      const filePath = req.query.path;
      const { content } = req.body;
      if (!validateAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      if (!filePath) return res.status(400).json({ error: 'path query parameter is required' });
      if (content === undefined || content === null) return res.status(400).json({ error: 'Content is required' });
      const agentDir = await ensureAgentDir(openclawBase, agentId);
      const fullPath = resolveAndValidatePath(agentDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      res.json({ ok: true });
    } catch (error) {
      if (handlePathTraversal(error, res)) return;
      console.error('[Memory] Error writing file:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete file
  router.delete('/api/memory/:agentId/file', async (req, res) => {
    try {
      const { agentId } = req.params;
      const filePath = req.query.path;
      if (!validateAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      if (!filePath) return res.status(400).json({ error: 'path query parameter is required' });
      const agentDir = await resolveAgentDir(openclawBase, agentId);
      if (!agentDir) return res.status(404).json({ error: 'Workspace not found' });
      const fullPath = resolveAndValidatePath(agentDir, filePath);
      await fs.unlink(fullPath);
      res.json({ ok: true });
    } catch (error) {
      if (handlePathTraversal(error, res)) return;
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      console.error('[Memory] Error deleting file:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create directory
  router.post('/api/memory/:agentId/mkdir', async (req, res) => {
    try {
      const { agentId } = req.params;
      const dirPath = req.query.path || req.body?.path;
      if (!validateAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      if (!dirPath) return res.status(400).json({ error: 'path is required' });
      const agentDir = await ensureAgentDir(openclawBase, agentId);
      const fullPath = resolveAndValidatePath(agentDir, dirPath);
      await fs.mkdir(fullPath, { recursive: true });
      res.json({ ok: true });
    } catch (error) {
      if (handlePathTraversal(error, res)) return;
      console.error('[Memory] Error creating directory:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Rename/move
  router.post('/api/memory/:agentId/rename', async (req, res) => {
    try {
      const { agentId } = req.params;
      const { from, to } = req.body;
      if (!validateAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
      const agentDir = await resolveAgentDir(openclawBase, agentId);
      if (!agentDir) return res.status(404).json({ error: 'Workspace not found' });
      const fromPath = resolveAndValidatePath(agentDir, from);
      const toPath = resolveAndValidatePath(agentDir, to);
      await fs.mkdir(path.dirname(toPath), { recursive: true });
      await fs.rename(fromPath, toPath);
      res.json({ ok: true });
    } catch (error) {
      if (handlePathTraversal(error, res)) return;
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Source not found' });
      console.error('[Memory] Error renaming:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete directory
  router.delete('/api/memory/:agentId/dir', async (req, res) => {
    try {
      const { agentId } = req.params;
      const dirPath = req.query.path;
      if (!validateAgentId(agentId)) return res.status(400).json({ error: 'Invalid agent ID' });
      if (!dirPath) return res.status(400).json({ error: 'path is required' });
      const agentDir = await resolveAgentDir(openclawBase, agentId);
      if (!agentDir) return res.status(404).json({ error: 'Workspace not found' });
      const fullPath = resolveAndValidatePath(agentDir, dirPath);
      await fs.rm(fullPath, { recursive: true });
      res.json({ ok: true });
    } catch (error) {
      if (handlePathTraversal(error, res)) return;
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Directory not found' });
      console.error('[Memory] Error deleting directory:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
