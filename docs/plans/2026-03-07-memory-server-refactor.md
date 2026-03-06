# Memory Server Production Refactor

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor memory-server.js (836-line monolith) into modular, production-grade architecture for all customer VPS instances.

**Architecture:** Split into `server/` modules by concern (validation, auth, routes, proxy). Single process, same Express app — just clean file separation. Add production hardening: health check, rate limiting, body size limits, graceful shutdown. Clean verbose logs.

**Tech Stack:** Express 5, http-proxy, jsonwebtoken, express-rate-limit (already installed)

---

### Task 1: Create `server/validation.js` — Input validation and SSRF protection

**Files:**
- Create: `server/validation.js`

Extract from `memory-server.js` lines 144-199:
- `AGENT_ID_REGEX`, `validateAgentId()`
- `resolveAndValidatePath()`
- `isAllowedProxyUrl()`

```js
// server/validation.js
import path from 'path';

const AGENT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateAgentId(agentId) {
  return !!(agentId && AGENT_ID_REGEX.test(agentId));
}

export function resolveAndValidatePath(agentDir, filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid path');
  }
  const resolved = path.resolve(agentDir, filePath);
  if (!resolved.startsWith(path.resolve(agentDir) + path.sep) && resolved !== path.resolve(agentDir)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

export function isAllowedProxyUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') return false;
    const parts = hostname.split('.');
    if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
      const first = parseInt(parts[0]);
      const second = parseInt(parts[1]);
      if (first === 10) return false;
      if (first === 172 && second >= 16 && second <= 31) return false;
      if (first === 192 && second === 168) return false;
      if (first === 169 && second === 254) return false;
    }
    if (hostname === 'metadata.google.internal') return false;
    if (hostname === '169.254.169.254') return false;
    return true;
  } catch {
    return false;
  }
}
```

**Commit:** `refactor: extract validation module from memory-server`

---

### Task 2: Create `server/middleware/auth.js` — Authentication middleware

**Files:**
- Create: `server/middleware/auth.js`

Extract from `memory-server.js` lines 44-116:
- Google certs caching + `getGoogleCerts()`
- `verifyFirebaseToken()`
- `requireGatewayAuth()` middleware

```js
// server/middleware/auth.js
import jwt from 'jsonwebtoken';

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let cachedCerts = null;
let certsExpiry = 0;

async function getGoogleCerts() {
  const now = Date.now();
  if (cachedCerts && now < certsExpiry) return cachedCerts;
  const response = await fetch(GOOGLE_CERTS_URL);
  if (!response.ok) throw new Error(`Failed to fetch Google certs: ${response.status}`);
  const certs = await response.json();
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1]) * 1000 : 3600000;
  cachedCerts = certs;
  certsExpiry = now + maxAge;
  return certs;
}

export async function verifyFirebaseToken(idToken, firebaseProjectId) {
  const headerB64 = idToken.split('.')[0];
  const header = JSON.parse(
    Buffer.from(headerB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
  );
  if (!header.kid) throw new Error('Token missing kid header');

  let certs = await getGoogleCerts();
  let cert = certs[header.kid];
  if (!cert) {
    cachedCerts = null;
    certsExpiry = 0;
    certs = await getGoogleCerts();
    cert = certs[header.kid];
    if (!cert) throw new Error('No matching certificate for kid: ' + header.kid);
  }
  return jwt.verify(idToken, cert, {
    algorithms: ['RS256'],
    issuer: `https://securetoken.google.com/${firebaseProjectId}`,
    audience: firebaseProjectId,
  });
}

export function requireGatewayAuth(gatewayToken) {
  return (req, res, next) => {
    if (!gatewayToken) return next();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization required' });
    }
    if (authHeader.substring(7) !== gatewayToken) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    next();
  };
}
```

Note: `requireGatewayAuth` becomes a factory function that takes `gatewayToken` as param — cleaner than relying on global state.

**Commit:** `refactor: extract auth middleware from memory-server`

---

### Task 3: Create `server/routes/api.js` — Public and auth-protected API routes

**Files:**
- Create: `server/routes/api.js`

Extract from `memory-server.js`:
- `GET /api/config` (public)
- `GET /api/stats` (auth)
- `POST /api/verify-owner` (public)
- `GET /api/provider-models` (auth)
- `POST /api/proxy-test` (auth)
- `GET /api/browse` (auth)
- `GET /api/health` (NEW — production health check)

```js
// server/routes/api.js
import { Router } from 'express';
import os from 'os';
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

  // Verify instance owner via Firebase ID token — no auth
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

  // --- Auth-protected routes ---

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

  router.get('/api/browse', authMiddleware, async (req, res) => {
    try {
      const dirPath = req.query.path || '/';
      const resolved = (await import('path')).resolve(dirPath);
      const BLOCKED = ['/proc', '/sys', '/dev', '/run', '/boot', '/root', '/etc/shadow'];
      if (BLOCKED.some(b => resolved === b || resolved.startsWith(b + '/'))) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const fsModule = await import('fs/promises');
      const entries = await fsModule.readdir(resolved, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        items.push({ name: entry.name, path: (await import('path')).join(resolved, entry.name), type: entry.isDirectory() ? 'directory' : 'file' });
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
```

**Commit:** `refactor: extract API routes from memory-server`

---

### Task 4: Create `server/routes/memory.js` — Workspace file CRUD

**Files:**
- Create: `server/routes/memory.js`

Extract all `/api/memory/*` endpoints (7 routes). Uses `validateAgentId`, `resolveAndValidatePath` from validation module. Workspace resolution helpers (`getWorkspaceDir`, `resolveAgentDir`, `ensureAgentDir`) move here since they're only used by memory routes.

All `console.log` debug lines removed. Only `console.error` on actual errors.

**Commit:** `refactor: extract memory routes from memory-server`

---

### Task 5: Create `server/routes/admin.js` — Self-update endpoint

**Files:**
- Create: `server/routes/admin.js`

Extract `/admin/update` endpoint. Receives `gatewayToken` via config.

**Commit:** `refactor: extract admin routes from memory-server`

---

### Task 6: Create `server/proxy.js` — Gateway proxy (HTTP + WebSocket)

**Files:**
- Create: `server/proxy.js`

Extract gateway proxy creation, `/openclaw` HTTP proxy middleware, and WebSocket upgrade handler. Exports:
- `createGatewayProxy(gatewayHost, gatewayPort)` — returns `{ proxy, httpMiddleware, upgradeHandler }`

**Commit:** `refactor: extract gateway proxy from memory-server`

---

### Task 7: Rewrite `memory-server.js` as thin entry point

**Files:**
- Modify: `memory-server.js` (complete rewrite ~80 lines)

Assembles all modules. Adds production hardening:
- `express-rate-limit` on API routes (100 req/15min per IP)
- `express.json({ limit: '1mb' })` body size limit
- Graceful shutdown handler (SIGTERM/SIGINT)
- Startup log with version info

```js
// memory-server.js — thin entry point
import express from 'express';
import { createServer } from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';

import { requireGatewayAuth } from './server/middleware/auth.js';
import { createApiRouter } from './server/routes/api.js';
import { createMemoryRouter } from './server/routes/memory.js';
import { createAdminRouter } from './server/routes/admin.js';
import { createGatewayProxy } from './server/proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));

// --- Config ---
const PORT = process.env.PORT || 3001;
const OPENCLAW_BASE = process.env.OPENCLAW_BASE || '/home/openclaw/.openclaw';
const OPENCLAW_PORT = process.env.OPENCLAW_PORT || '18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const OWNER_EMAIL = process.env.OWNER_EMAIL || '';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'silos-4352a';

let openclawVersion = process.env.OPENCLAW_VERSION || null;
if (!openclawVersion) {
  for (const p of ['/usr/lib/node_modules/openclaw/package.json', '/usr/local/lib/node_modules/openclaw/package.json', '/home/openclaw/openclaw/package.json']) {
    try { openclawVersion = JSON.parse(await fs.readFile(p, 'utf8')).version; if (openclawVersion) break; } catch {}
  }
}

const config = { appVersion: pkg.version, openclawVersion, ownerEmail: OWNER_EMAIL, gatewayToken: GATEWAY_TOKEN, openclawPort: OPENCLAW_PORT, firebaseProjectId: FIREBASE_PROJECT_ID };
const authMiddleware = requireGatewayAuth(GATEWAY_TOKEN);

// --- App ---
const app = express();

app.use(express.json({ limit: '1mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Rate limiting on API routes
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Static files
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (filePath.match(/\.(js|css)$/)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// Routes
app.use(createApiRouter(config, authMiddleware));
app.use(createMemoryRouter(OPENCLAW_BASE, authMiddleware));
app.use(createAdminRouter(GATEWAY_TOKEN));

// Gateway proxy (HTTP for /openclaw, WebSocket handled on server upgrade)
const { httpMiddleware, upgradeHandler } = createGatewayProxy('127.0.0.1', parseInt(OPENCLAW_PORT));
app.use('/openclaw', httpMiddleware);

// SPA catch-all
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  } else {
    next();
  }
});

// --- Server ---
const server = createServer(app);
server.on('upgrade', upgradeHandler);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Silos Dashboard v${pkg.version} listening on 127.0.0.1:${PORT}`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

**Commit:** `refactor: rewrite memory-server as modular entry point with prod hardening`

---

### Task 8: Update Dockerfile

**Files:**
- Modify: `Dockerfile`

Changes:
1. Copy `server/` directory into runtime image
2. Add `express-rate-limit` to the inline package.json dependencies

```dockerfile
# Build stage — compile React frontend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage — Node.js with memory-server + compiled frontend
FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/package.json ./package-full.json
RUN node -e "const p=require('./package-full.json'); const s={type:'module',version:p.version,dependencies:{express:'^5.2.1','express-rate-limit':'^8.3.0','http-proxy':'^1.18.1',jsonwebtoken:'^9.0.3'}}; require('fs').writeFileSync('package.json',JSON.stringify(s))" \
    && rm package-full.json && npm install --production

COPY --from=builder /app/dist ./dist
COPY memory-server.js .
COPY server/ ./server/

EXPOSE 3001
ENV PORT=3001 \
    NODE_ENV=production \
    OPENCLAW_PORT=18789 \
    FIREBASE_PROJECT_ID=silos-4352a

CMD ["node", "memory-server.js"]
```

**Commit:** `build: update Dockerfile for modular server structure`

---

### Task 9: Verify — local build and smoke test

**Steps:**
1. Run `node memory-server.js` locally — verify it starts without errors
2. Run `docker build -t silos-test .` — verify Docker build succeeds
3. Verify `curl http://127.0.0.1:3001/api/health` returns `{"ok":true,...}`
4. Verify the frontend loads at `http://127.0.0.1:3001/`

**Commit:** (no commit — verification only)

---

### Task 10: Final commit and tag

```bash
git add -A
git commit -m "refactor: modularize memory-server for production

Split 836-line monolith into:
- server/validation.js — input validation, SSRF protection
- server/middleware/auth.js — Firebase + gateway token auth
- server/routes/api.js — config, stats, health, provider-models, proxy-test, browse
- server/routes/memory.js — workspace file CRUD (7 endpoints)
- server/routes/admin.js — self-update endpoint
- server/proxy.js — gateway HTTP + WebSocket proxy

Production hardening:
- Rate limiting (300 req/15min per IP)
- Request body size limit (1MB)
- Health check endpoint (/api/health)
- Graceful shutdown (SIGTERM/SIGINT)
- Dashboard bound to 127.0.0.1 only"
```

Tag and push.
