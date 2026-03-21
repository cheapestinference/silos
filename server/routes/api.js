import { Router } from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import http from 'http';
import { verifyFirebaseToken } from '../middleware/auth.js';

import { isAllowedProxyUrl } from '../validation.js';

const execFileAsync = promisify(execFile);

/** Parse JSON that may have trailing commas (OpenClaw config files) */
function parseRelaxedJson(text) {
  // Strip trailing commas before } or ]
  const cleaned = text.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(cleaned);
}

export function createApiRouter(config, authMiddleware, openclawBase) {
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

  // LLM provider usage (proxied to avoid exposing API key to frontend)
  router.get('/api/usage', authMiddleware, async (_req, res) => {
    try {
      let baseUrl = '', apiKey = '';
      try {
        const configPath = path.join(openclawBase, 'openclaw.json');
        const raw = await fs.readFile(configPath, 'utf8');
        const config = parseRelaxedJson(raw);
        const providers = config?.models?.providers;
        if (providers && typeof providers === 'object') {
          const first = Object.values(providers)[0];
          if (first?.baseUrl) {
            baseUrl = String(first.baseUrl).replace(/\/+$/, '');
            apiKey = first.apiKey ? String(first.apiKey) : '';
          }
        }
      } catch { /* config not readable */ }
      if (!baseUrl && process.env.LLM_PROXY_URL) {
        baseUrl = process.env.LLM_PROXY_URL.replace(/\/+$/, '');
        apiKey = process.env.LLM_PROXY_KEY || '';
      }
      if (!baseUrl || !apiKey) return res.json(null);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const usageUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/usage` : `${baseUrl}/v1/usage`;
      const response = await fetch(usageUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) return res.json(null);
      const data = await response.json();
      res.json(data);
    } catch {
      res.json(null);
    }
  });

  // Fetch available models from LLM providers configured in openclaw.json
  // Reads provider config (with real API keys) directly from the filesystem,
  // since the gateway's config.get RPC redacts apiKey fields.
  router.get('/api/provider-models', authMiddleware, async (_req, res) => {
    try {
      const providers = {};
      // Read providers from openclaw.json on disk (unredacted)
      try {
        const configPath = path.join(openclawBase, 'openclaw.json');
        const raw = await fs.readFile(configPath, 'utf8');
        const config = parseRelaxedJson(raw);
        const cfgProviders = config?.models?.providers;
        if (cfgProviders && typeof cfgProviders === 'object') {
          for (const [name, p] of Object.entries(cfgProviders)) {
            if (p && typeof p === 'object' && p.baseUrl) {
              providers[name] = { baseUrl: String(p.baseUrl).replace(/\/+$/, ''), apiKey: p.apiKey ? String(p.apiKey) : '' };
            }
          }
        }
      } catch { /* config not readable */ }
      // Fallback: env var
      if (Object.keys(providers).length === 0 && process.env.LLM_PROXY_URL) {
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

  // ─── Add Subscription (Claude setup-token) ──────────────────────────────
  router.post('/api/add-subscription', authMiddleware, async (req, res) => {
    try {
      const { token } = req.body;
      if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'token is required' });
      }
      const trimmed = token.trim();

      // Validate: must start with sk-ant-oat01- and be >= 80 chars
      if (!trimmed.startsWith('sk-ant-oat01-')) {
        return res.status(400).json({ error: 'Invalid token. Expected a Claude setup-token starting with sk-ant-oat01-' });
      }
      if (trimmed.length < 80) {
        return res.status(400).json({ error: 'Token looks too short. Paste the full setup-token.' });
      }

      const profileId = 'anthropic:manual';
      const provider = 'anthropic';

      // 1. Write token to auth-profiles.json
      const authDir = path.join(openclawBase, 'agents', 'main', 'agent');
      await fs.mkdir(authDir, { recursive: true });
      const authPath = path.join(authDir, 'auth-profiles.json');

      let store = { version: 1, profiles: {} };
      try {
        const raw = await fs.readFile(authPath, 'utf8');
        store = JSON.parse(raw);
        if (!store.profiles) store.profiles = {};
      } catch { /* file doesn't exist yet */ }

      store.profiles[profileId] = {
        type: 'token',
        provider,
        token: trimmed,
      };

      await fs.writeFile(authPath, JSON.stringify(store, null, 2) + '\n');

      // 2. Patch openclaw.json config to register the auth profile
      try {
        const configPath = path.join(openclawBase, 'openclaw.json');
        const raw = await fs.readFile(configPath, 'utf8');
        const config = parseRelaxedJson(raw);

        if (!config.auth) config.auth = {};
        if (!config.auth.profiles) config.auth.profiles = {};
        config.auth.profiles[profileId] = {
          provider,
          mode: 'token',
        };

        // Ensure anthropic provider exists in models.providers
        // Anthropic /models endpoint doesn't support setup-tokens, so we must list models explicitly
        if (!config.models) config.models = {};
        if (!config.models.providers) config.models.providers = {};
        if (!config.models.providers.anthropic) {
          config.models.providers.anthropic = {
            baseUrl: 'https://api.anthropic.com/v1',
            api: 'anthropic-messages',
            models: [
              { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', contextWindow: 200000, input: ['text', 'image'] },
              { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', contextWindow: 200000, input: ['text', 'image'] },
              { id: 'claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5', contextWindow: 200000, input: ['text', 'image'] },
            ],
          };
        }

        await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
      } catch (cfgErr) {
        console.error('[Subscription] Config patch failed:', cfgErr.message);
        // Auth profile was still saved — gateway may need restart
      }

      res.json({ ok: true, profileId, provider });
    } catch (error) {
      console.error('[Subscription] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── ClawHub Marketplace ──────────────────────────────────────────────────

  const CLAWHUB_API = 'https://clawhub.ai/api';

  router.get('/api/clawhub/search', authMiddleware, async (req, res) => {
    try {
      const q = req.query.q || '';
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${CLAWHUB_API}/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return res.status(response.status).json({ error: 'ClawHub search failed' });
      const data = await response.json();
      res.json(data);
    } catch (error) {
      if (error.name === 'AbortError') return res.status(504).json({ error: 'ClawHub search timed out' });
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/clawhub/skill', authMiddleware, async (req, res) => {
    try {
      const slug = req.query.slug;
      if (!slug) return res.status(400).json({ error: 'slug is required' });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${CLAWHUB_API}/skill?slug=${encodeURIComponent(slug)}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return res.status(response.status).json({ error: 'Skill not found' });
      const data = await response.json();
      res.json(data);
    } catch (error) {
      if (error.name === 'AbortError') return res.status(504).json({ error: 'ClawHub request timed out' });
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/clawhub/install', authMiddleware, async (req, res) => {
    try {
      const { slug } = req.body;
      console.log('[ClawHub Install] slug:', JSON.stringify(slug));
      if (!slug || !/^[a-z0-9][a-z0-9._\/-]*$/i.test(slug)) {
        return res.status(400).json({ error: 'Invalid skill slug' });
      }
      const skillsDir = path.join(openclawBase, 'skills');
      await fs.mkdir(skillsDir, { recursive: true });
      let stdout = '', stderr = '';
      try {
        const result = await execFileAsync('clawhub', ['install', slug, '--no-input', '--force'], {
          cwd: openclawBase,
          timeout: 30000,
          env: { ...process.env, HOME: openclawBase },
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (execErr) {
        // clawhub may exit non-zero but still install (e.g. suspicious skill warnings)
        stdout = execErr.stdout || '';
        stderr = execErr.stderr || '';
      }
      // Check if skill was actually installed despite exit code
      // clawhub installs as the skill name (last part of slug, e.g. "owner/skill" -> "skill")
      const skillName = slug.includes('/') ? slug.split('/').pop() : slug;
      const skillPath = path.join(openclawBase, 'skills', skillName);
      try {
        await fs.access(skillPath);
        console.log('[ClawHub Install] OK:', skillPath);

        // Fix ownership: clawhub runs as container user (often root), but OpenClaw
        // gateway runs as 'openclaw' and needs to read skill files.
        try {
          await execFileAsync('chown', ['-R', 'openclaw:openclaw', skillPath], { timeout: 5000 });
        } catch { /* chown may fail in dev/non-root — non-fatal */ }

        // Auto-install npm dependencies declared in skill metadata
        try {
          const skillMd = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8');
          const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const metaMatch = fmMatch[1].match(/^metadata:\s*(.+)$/m);
            if (metaMatch) {
              const meta = JSON.parse(metaMatch[1]);
              const installs = meta?.openclaw?.install || [];
              for (const step of installs) {
                if (step.kind === 'node' && step.package) {
                  console.log(`[ClawHub Install] Installing npm dep: ${step.package}`);
                  try {
                    await execFileAsync('npm', ['install', '-g', step.package], {
                      timeout: 60000,
                      env: { ...process.env, HOME: openclawBase },
                    });
                    console.log(`[ClawHub Install] npm dep installed: ${step.package}`);
                  } catch (npmErr) {
                    console.warn(`[ClawHub Install] npm dep failed: ${step.package}`, npmErr.stderr || npmErr.message);
                  }
                }
              }
            }
          }
        } catch { /* metadata parsing failed — non-fatal */ }

        res.json({ ok: true, output: stdout || stderr });
      } catch {
        console.log('[ClawHub Install] FAIL: not found at', skillPath, 'stdout:', stdout, 'stderr:', stderr);
        res.status(500).json({ error: stderr || stdout || 'Install failed', output: stderr });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Skills Management ───────────────────────────────────────────────────

  router.get('/api/skills/list', authMiddleware, async (_req, res) => {
    try {
      const skillsDir = path.join(openclawBase, 'skills');
      let entries;
      try {
        entries = await fs.readdir(skillsDir, { withFileTypes: true });
      } catch {
        return res.json({ skills: [] });
      }
      const skills = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = path.join(skillsDir, entry.name);
        try {
          const skillMd = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8');
          // Parse YAML frontmatter
          const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
          let name = entry.name, description = '';
          if (fmMatch) {
            const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
            const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
            if (descMatch) description = descMatch[1].trim();
          }
          const stat = await fs.stat(skillPath);
          skills.push({ slug: entry.name, name, description, installedAt: stat.mtimeMs });
        } catch { /* skip dirs without SKILL.md */ }
      }
      res.json({ skills });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/api/skills/:slug', authMiddleware, async (req, res) => {
    try {
      const slug = req.params.slug;
      if (!slug || !/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
        return res.status(400).json({ error: 'Invalid skill slug' });
      }
      const skillPath = path.join(openclawBase, 'skills', slug);
      await fs.rm(skillPath, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
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

  // Maximize browser window — uses python3+Xlib inside the sandbox container
  router.post('/api/browser/maximize', authMiddleware, async (_req, res) => {
    try {
      const { stdout: containers } = await execFileAsync('docker', [
        'ps', '--filter', 'label=openclaw.sandboxBrowser=1', '--format', '{{.Names}}',
      ]);
      const name = containers.trim().split('\n')[0] || 'openclaw-browser';

      // Use python3 to move+resize the Chromium window via X11
      const pyScript = `
import subprocess, re
out = subprocess.check_output(['xwininfo', '-tree', '-root'], env={'DISPLAY': ':1'}).decode()
for line in out.splitlines():
    m = re.search(r'(0x[0-9a-f]+).*Chromium.*?(\\d+)x(\\d+)\\+(\\d+)\\+(\\d+)', line, re.I)
    if m and int(m.group(2)) > 100:
        wid = m.group(1)
        subprocess.run(['xprop', '-id', wid, '-f', '_NET_WM_STATE', '32a', '-set', '_NET_WM_STATE', ''], env={'DISPLAY': ':1'})
        subprocess.run(f'DISPLAY=:1 python3 -c "from ctypes import *; x=cdll.LoadLibrary(\\"libX11.so.6\\"); d=x.XOpenDisplay(None); x.XMoveResizeWindow(d,{int(wid,16)},0,0,1280,800); x.XFlush(d); x.XCloseDisplay(d)"', shell=True)
        break
`;
      await execFileAsync('docker', [
        'exec', name, 'python3', '-c', pyScript,
      ], { timeout: 5000 });
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Browser status — checks if the sandbox browser container is running and noVNC is reachable
  // Uses Docker Engine API via Unix socket (no docker CLI needed inside the container)
  const dockerRequest = (path) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });

  router.get('/api/browser/status', authMiddleware, async (_req, res) => {
    try {
      // Find running containers with the sandbox browser label via Docker Engine API
      const containers = await dockerRequest(
        '/containers/json?filters=' + encodeURIComponent('{"label":["openclaw.sandboxBrowser=1"]}')
      );
      if (!Array.isArray(containers) || containers.length === 0) {
        return res.json({ active: false });
      }
      const container = containers[0];

      // Read VNC password from container env
      let password;
      try {
        const inspect = await dockerRequest(`/containers/${container.Id}/json`);
        const envLine = (inspect.Config?.Env || []).find(l => l.startsWith('OPENCLAW_BROWSER_NOVNC_PASSWORD='));
        if (envLine) password = envLine.slice('OPENCLAW_BROWSER_NOVNC_PASSWORD='.length);
      } catch { /* non-fatal */ }

      // TCP probe: check if noVNC port 6080 is reachable (socat bridge)
      const portReachable = await new Promise((resolve) => {
        const sock = new net.Socket();
        const done = (result) => { sock.destroy(); resolve(result); };
        sock.setTimeout(2000);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
        sock.connect(6080, '127.0.0.1');
      });

      if (!portReachable) {
        return res.json({ active: false });
      }

      const since = container.Created ? new Date(container.Created * 1000).toISOString() : undefined;
      const response = { active: true, since };
      if (password) response.password = password;
      res.json(response);
    } catch (e) {
      res.json({ active: false });
    }
  });

  return router;
}
