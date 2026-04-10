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
import { createTasksRouter } from './server/routes/tasks.js';
import { createLobsterRouter } from './server/routes/lobster.js';
import { createGatewayProxy } from './server/proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));

// --- Config ---
const PORT = process.env.PORT || 3001;
const OPENCLAW_BASE = process.env.OPENCLAW_BASE || '/home/openclaw/.openclaw';
const OPENCLAW_PORT = process.env.OPENCLAW_PORT || '18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const OWNER_EMAIL = process.env.OWNER_EMAIL || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'silos-4352a';
const USER_LOCALE = process.env.USER_LOCALE || '';

// Model presets — configurable per-instance via env vars (set by provisioning)
const PRESET_BASICA = process.env.VITE_PRESET_BASICA || '';
const PRESET_ALTA = process.env.VITE_PRESET_ALTA || '';
const PRESET_EXCELENTE = process.env.VITE_PRESET_EXCELENTE || '';

let openclawVersion = process.env.OPENCLAW_VERSION || null;
if (!openclawVersion) {
  for (const p of ['/usr/lib/node_modules/openclaw/package.json', '/usr/local/lib/node_modules/openclaw/package.json', '/home/openclaw/openclaw/package.json']) {
    try { openclawVersion = JSON.parse(await fs.readFile(p, 'utf8')).version; if (openclawVersion) break; } catch { }
  }
}

const config = {
  appVersion: pkg.version,
  openclawVersion,
  ownerEmail: OWNER_EMAIL,
  adminEmails: ADMIN_EMAILS,
  gatewayToken: GATEWAY_TOKEN,
  openclawPort: OPENCLAW_PORT,
  firebaseProjectId: FIREBASE_PROJECT_ID,
};
const authMiddleware = requireGatewayAuth(GATEWAY_TOKEN);

// --- App ---
const app = express();
app.set('trust proxy', 'loopback');

app.use(express.json({ limit: '1mb' }));

// Locale cookie is set by the landing page on .silosplatform.com (covers all subdomains).
// The dashboard frontend reads it as the initial seed, then localStorage takes over.
// We intentionally do NOT set a server-side cookie here to avoid overriding the user's
// explicit language choice on every response.

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Rate limiting on API routes
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Static files (hashed assets immutable, HTML never cached, browser/lib not hashed so short cache)
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (filePath.includes('/browser/')) {
      res.setHeader('Cache-Control', 'public, no-transform, max-age=3600');
      if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    }
    else if (filePath.match(/\.(js|css)$/)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// Routes
app.use(createApiRouter(config, authMiddleware, OPENCLAW_BASE));
app.use(createMemoryRouter(OPENCLAW_BASE, authMiddleware));
app.use(createAdminRouter(GATEWAY_TOKEN));
app.use(createTasksRouter(OPENCLAW_BASE, authMiddleware));
app.use(createLobsterRouter(OPENCLAW_BASE, authMiddleware));

// Gateway proxy (HTTP for /openclaw control UI)
// Redirect logic for /openclaw → /openclaw/ is inside httpMiddleware (proxy.js)
const { httpMiddleware, upgradeHandler } = createGatewayProxy('127.0.0.1', parseInt(OPENCLAW_PORT));
app.use('/openclaw', httpMiddleware);

// Browser noVNC: static files served from dist/browser/ by express.static above.
// WebSocket upgrades for /browser/websockify are handled by upgradeHandler (server.on('upgrade')).

// Runtime config injected into index.html so the SPA can read env vars set at deploy time.
// Build-time VITE_* values are baked into the JS bundle; this overrides them per-instance.
const runtimeConfig = JSON.stringify({
  VITE_PRESET_BASICA: PRESET_BASICA,
  VITE_PRESET_ALTA: PRESET_ALTA,
  VITE_PRESET_EXCELENTE: PRESET_EXCELENTE,
});
const indexPath = path.join(__dirname, 'dist', 'index.html');
let indexHtml = null;
try {
  const raw = await fs.readFile(indexPath, 'utf8');
  indexHtml = raw.replace(
    '<head>',
    `<head><script>window.__RUNTIME_CONFIG__=${runtimeConfig}</script>`
  );
} catch { /* index.html missing in dev — SPA catch-all will 404 naturally */ }

// SPA catch-all
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    if (!indexHtml) return res.status(404).send('Not found');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(indexHtml);
  } else {
    next();
  }
});

// --- Server ---
const server = createServer(app);
server.on('upgrade', (req, socket, head) => upgradeHandler(req, socket, head, GATEWAY_TOKEN));

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
