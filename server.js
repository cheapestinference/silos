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

const config = {
  appVersion: pkg.version,
  openclawVersion,
  ownerEmail: OWNER_EMAIL,
  gatewayToken: GATEWAY_TOKEN,
  openclawPort: OPENCLAW_PORT,
  firebaseProjectId: FIREBASE_PROJECT_ID,
};
const authMiddleware = requireGatewayAuth(GATEWAY_TOKEN);

// --- App ---
const app = express();
app.set('trust proxy', 'loopback');

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
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Static files (hashed assets immutable, HTML never cached)
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (filePath.match(/\.(js|css)$/)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// Routes
app.use(createApiRouter(config, authMiddleware, OPENCLAW_BASE));
app.use(createMemoryRouter(OPENCLAW_BASE, authMiddleware));
app.use(createAdminRouter(GATEWAY_TOKEN));

// Gateway proxy (HTTP for /openclaw control UI)
// Redirect logic for /openclaw → /openclaw/ is inside httpMiddleware (proxy.js)
const { httpMiddleware, upgradeHandler } = createGatewayProxy('127.0.0.1', parseInt(OPENCLAW_PORT), GATEWAY_TOKEN);
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
