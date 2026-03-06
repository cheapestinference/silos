import { Router } from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { verifyFirebaseToken } from '../middleware/auth.js';
import { isAllowedProxyUrl } from '../validation.js';

const execFileAsync = promisify(execFile);

export function createApiRouter(config, authMiddleware) {
  const router = Router();
  const { appVersion, openclawVersion, ownerEmail, gatewayToken, openclawPort, firebaseProjectId } = config;

  // Health check — no auth, for watchdog/monitoring
  router.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // Config — no auth (frontend needs this before login)
  router.get('/api/config', (_req, res) => {
    res.json({
      gatewayUrl: process.env.GATEWAY_URL || `http://127.0.0.1:${openclawPort}`,
      authRequired: !!ownerEmail,
      version: appVersion,
      openclawVersion,
    });
  });

  // Verify instance owner via Firebase ID token
  router.post('/api/verify-owner', async (req, res) => {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });

    if (!ownerEmail) {
      return res.json({
        authorized: true,
        gatewayToken: gatewayToken || null,
        gatewayUrl: process.env.GATEWAY_URL || `http://127.0.0.1:${openclawPort}`,
      });
    }

    try {
      const decoded = await verifyFirebaseToken(idToken, firebaseProjectId);
      const email = decoded.email;

      if (!email || email.toLowerCase() !== ownerEmail.toLowerCase()) {
        return res.status(403).json({ authorized: false, reason: 'WRONG_OWNER', error: 'Access denied. You are not the owner of this instance.' });
      }
      if (!decoded.email_verified) {
        return res.status(403).json({ authorized: false, reason: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before accessing the dashboard.' });
      }

      res.json({
        authorized: true,
        gatewayToken: gatewayToken || null,
        gatewayUrl: process.env.GATEWAY_URL || `http://127.0.0.1:${openclawPort}`,
      });
    } catch (err) {
      console.error('[Auth] Token verification failed:', err.message);
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  // System stats
  router.get('/api/stats', authMiddleware, async (_req, res) => {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      let diskUsed = 0, diskTotal = 0;
      try {
        const { stdout } = await execFileAsync('df', ['--output=used,size', '-B1', '/']);
        const lines = stdout.trim().split('\n');
        if (lines.length >= 2) {
          const [used, size] = lines[1].trim().split(/\s+/).map(Number);
          diskUsed = used;
          diskTotal = size;
        }
      } catch { /* df not available */ }
      res.json({
        memory: { used: usedMem, total: totalMem, percent: Math.round(usedMem / totalMem * 100) },
        disk: { used: diskUsed, total: diskTotal, percent: diskTotal > 0 ? Math.round(diskUsed / diskTotal * 100) : 0 },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Fetch available models from LLM providers
  router.get('/api/provider-models', authMiddleware, async (_req, res) => {
    try {
      const providers = {};
      if (process.env.LLM_PROXY_URL) {
        providers.silos = {
          baseUrl: process.env.LLM_PROXY_URL.replace(/\/+$/, '') + '/v1',
          apiKey: process.env.LLM_PROXY_KEY || '',
        };
      }
      const results = {};
      await Promise.all(Object.entries(providers).map(async ([name, provider]) => {
        try {
          const baseUrl = (provider.baseUrl || '').replace(/\/+$/, '');
          if (!baseUrl) return;
          const headers = {};
          if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const response = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
          clearTimeout(timeout);
          if (!response.ok) return;
          const data = await response.json();
          const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
          results[name] = models.map(m => ({ id: m.id, name: m.id, contextWindow: m.context_window || 128000 }));
        } catch { /* skip failed providers */ }
      }));
      res.json(results);
    } catch (error) {
      console.error('[Provider Models] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy for testing LLM provider connections (avoids browser CORS)
  router.post('/api/proxy-test', authMiddleware, async (req, res) => {
    try {
      const { url, headers: reqHeaders } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' });
      if (!isAllowedProxyUrl(url)) return res.status(403).json({ error: 'URL not allowed. Only HTTPS to external hosts is permitted.' });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(url, { headers: reqHeaders || {}, signal: controller.signal });
      clearTimeout(timeout);
      const body = await response.text();
      res.json({ status: response.status, statusText: response.statusText, ok: response.ok, body });
    } catch (error) {
      if (error.name === 'AbortError') {
        res.json({ ok: false, status: 0, body: '', error: 'Connection timed out (15s)' });
      } else {
        res.json({ ok: false, status: 0, body: '', error: error.message });
      }
    }
  });

  // Browse server filesystem (for Knowledge Base extraPaths)
  router.get('/api/browse', authMiddleware, async (req, res) => {
    try {
      const dirPath = req.query.path || '/';
      const resolved = path.resolve(dirPath);
      const BLOCKED = ['/proc', '/sys', '/dev', '/run', '/boot', '/root', '/etc/shadow'];
      if (BLOCKED.some(b => resolved === b || resolved.startsWith(b + '/'))) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        items.push({ name: entry.name, path: path.join(resolved, entry.name), type: entry.isDirectory() ? 'directory' : 'file' });
      }
      items.sort((a, b) => { if (a.type !== b.type) return a.type === 'directory' ? -1 : 1; return a.name.localeCompare(b.name); });
      res.json({ path: resolved, items });
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Directory not found' });
      if (error.code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
