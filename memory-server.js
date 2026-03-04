import express from 'express';
import { createServer } from 'http';
import httpProxy from 'http-proxy';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pkg = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));
const APP_VERSION = pkg.version || '0.0.0';

const app = express();
const PORT = process.env.PORT || 3001;
const OPENCLAW_BASE = process.env.OPENCLAW_BASE || '/home/openclaw/.openclaw';
const OWNER_EMAIL = process.env.OWNER_EMAIL || '';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const OPENCLAW_PORT = process.env.OPENCLAW_PORT || '18789';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'silos-4352a';
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// Cache for Google public signing keys
let cachedCerts = null;
let certsExpiry = 0;

async function getGoogleCerts() {
  const now = Date.now();
  if (cachedCerts && now < certsExpiry) {
    return cachedCerts;
  }
  const response = await fetch(GOOGLE_CERTS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Google certs: ${response.status}`);
  }
  const certs = await response.json();
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1]) * 1000 : 3600000;
  cachedCerts = certs;
  certsExpiry = now + maxAge;
  return certs;
}

// Cryptographically verify a Firebase ID token (RS256 signature, iss, aud, exp)
async function verifyFirebaseToken(idToken) {
  const headerB64 = idToken.split('.')[0];
  const header = JSON.parse(
    Buffer.from(headerB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
  );
  if (!header.kid) {
    throw new Error('Token missing kid header');
  }
  const certs = await getGoogleCerts();
  const cert = certs[header.kid];
  if (!cert) {
    // Force refresh certs in case they rotated
    cachedCerts = null;
    certsExpiry = 0;
    const freshCerts = await getGoogleCerts();
    const freshCert = freshCerts[header.kid];
    if (!freshCert) {
      throw new Error('No matching certificate for kid: ' + header.kid);
    }
    return jwt.verify(idToken, freshCert, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
  }
  return jwt.verify(idToken, cert, {
    algorithms: ['RS256'],
    issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    audience: FIREBASE_PROJECT_ID,
  });
}

// Auth middleware: requires gateway token in Authorization header
function requireGatewayAuth(req, res, next) {
  // No gateway token configured = dev mode, allow all
  if (!GATEWAY_TOKEN) {
    return next();
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  const token = authHeader.substring(7);
  if (token !== GATEWAY_TOKEN) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  next();
}

app.use(express.json());

// Enable CORS for local development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Serve static files from dist/ directory
// JS/CSS have hashed filenames (immutable), HTML must never be cached
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.match(/\.(js|css)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// ─── Security: Input Validation ─────────────────────────────────────────────

const AGENT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

function validateAgentId(agentId) {
  if (!agentId || !AGENT_ID_REGEX.test(agentId)) {
    return false;
  }
  return true;
}

// Resolve workspace directory and validate the final path is contained within it
function resolveAndValidatePath(agentDir, filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid path');
  }

  const resolved = path.resolve(agentDir, filePath);

  // Ensure the resolved path starts with the agent directory (prevent traversal)
  if (!resolved.startsWith(path.resolve(agentDir) + path.sep) && resolved !== path.resolve(agentDir)) {
    throw new Error('Path traversal detected');
  }

  return resolved;
}

// ─── SSRF Protection for proxy-test ──────────────────────────────────────────

function isAllowedProxyUrl(urlString) {
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

// Config endpoint - no longer exposes gateway token (auth goes through verify-owner)
app.get('/api/config', async (req, res) => {
  let openclawVersion = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${OPENCLAW_PORT}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const body = await r.json().catch(() => ({}));
      openclawVersion = body.version || body.gatewayVersion || null;
    }
  } catch { /* gateway not ready */ }

  res.json({
    gatewayUrl: process.env.GATEWAY_URL || `http://127.0.0.1:${OPENCLAW_PORT}`,
    authRequired: !!OWNER_EMAIL,
    version: APP_VERSION,
    openclawVersion,
  });
});

// Verify instance owner via Firebase ID token
app.post('/api/verify-owner', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: 'idToken is required' });
  }

  // If no OWNER_EMAIL configured, allow anyone (dev/legacy mode)
  if (!OWNER_EMAIL) {
    console.log('[Auth] No OWNER_EMAIL configured, granting access');
    return res.json({
      authorized: true,
      gatewayToken: GATEWAY_TOKEN || null,
      gatewayUrl: process.env.GATEWAY_URL || 'http://127.0.0.1:18789',
    });
  }

  try {
    const decoded = await verifyFirebaseToken(idToken);

    const email = decoded.email;
    const emailVerified = decoded.email_verified;

    console.log(`[Auth] Verify-owner: email=${email}, verified=${emailVerified}, owner=${OWNER_EMAIL}`);

    if (!email) {
      return res.status(403).json({ authorized: false, reason: 'WRONG_OWNER', error: 'No email in token' });
    }

    if (email.toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
      console.log(`[Auth] Access denied: ${email} is not ${OWNER_EMAIL}`);
      return res.status(403).json({
        authorized: false,
        reason: 'WRONG_OWNER',
        error: 'Access denied. You are not the owner of this instance.',
      });
    }

    if (!emailVerified) {
      console.log(`[Auth] Email not verified for owner ${email}`);
      return res.status(403).json({
        authorized: false,
        reason: 'EMAIL_NOT_VERIFIED',
        error: 'Please verify your email address before accessing the dashboard.',
      });
    }

    res.json({
      authorized: true,
      gatewayToken: GATEWAY_TOKEN || null,
      gatewayUrl: process.env.GATEWAY_URL || 'http://127.0.0.1:18789',
    });
  } catch (err) {
    console.error('[Auth] Token verification failed:', err.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// Get the workspace directory for an agent
function getWorkspaceDir(agentId) {
  const defaultWorkspace = path.join(OPENCLAW_BASE, 'workspace');
  const agentWorkspace = path.join(OPENCLAW_BASE, 'agents', agentId, 'workspace');
  const legacyWorkspace = path.join(OPENCLAW_BASE, `workspace-${agentId}`);

  return { defaultWorkspace, agentWorkspace, legacyWorkspace };
}

// Resolve which workspace directory exists for an agent
async function resolveAgentDir(agentId) {
  const { defaultWorkspace, agentWorkspace, legacyWorkspace } = getWorkspaceDir(agentId);

  try {
    await fs.access(agentWorkspace);
    return agentWorkspace;
  } catch {
    try {
      await fs.access(legacyWorkspace);
      return legacyWorkspace;
    } catch {
      try {
        await fs.access(defaultWorkspace);
        return defaultWorkspace;
      } catch {
        return null;
      }
    }
  }
}

// All memory and proxy endpoints require gateway token auth
app.use('/api/memory', requireGatewayAuth);
app.use('/api/proxy-test', requireGatewayAuth);

// List memory files for an agent
app.get('/api/memory/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;

    if (!validateAgentId(agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }

    const agentDir = await resolveAgentDir(agentId);
    if (!agentDir) {
      return res.json({ files: [] });
    }

    console.log(`[Memory] Listing files for ${agentId} from: ${agentDir}`);

    const files = [];
    const MAX_FILES = 500;

    const SKIP_DIRS = new Set([
      'node_modules', 'venv', '.venv', '__pycache__', 'dist', 'build',
      '.cache', '.tox', 'env', '.env', '.mypy_cache', '.pytest_cache',
      'site-packages', '.next', 'target', 'vendor',
    ]);

    async function walkDir(dir, relativePath) {
      if (files.length >= MAX_FILES) return;

      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        if (entry.name.startsWith('.')) continue;

        const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const fullPath = path.join(dir, entry.name);

        if (entry.isFile()) {
          const stats = await fs.stat(fullPath);
          files.push({
            path: entryRelPath,
            size: stats.size,
            mtime: stats.mtimeMs,
            type: 'file'
          });
        } else if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;

          files.push({
            path: entryRelPath,
            size: 0,
            mtime: 0,
            type: 'directory'
          });
          await walkDir(fullPath, entryRelPath);
        }
      }
    }

    await walkDir(agentDir, '');
    files.sort((a, b) => b.mtime - a.mtime);

    console.log(`[Memory] Found ${files.length} files`);
    res.json({ files });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Read a memory file
app.get('/api/memory/:agentId/file', async (req, res) => {
  try {
    const { agentId } = req.params;
    const filePath = req.query.path;

    if (!validateAgentId(agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }
    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    const agentDir = await resolveAgentDir(agentId);
    if (!agentDir) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const fullPath = resolveAndValidatePath(agentDir, filePath);
    console.log(`[Memory] Reading: ${fullPath}`);

    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ content });
  } catch (error) {
    if (error.message === 'Path traversal detected') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    console.error('Error reading file:', error);
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Write a memory file
app.post('/api/memory/:agentId/file', async (req, res) => {
  try {
    const { agentId } = req.params;
    const filePath = req.query.path;
    const { content } = req.body;

    if (!validateAgentId(agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }
    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }
    if (content === undefined || content === null) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const agentDir = await resolveAgentDir(agentId);
    if (!agentDir) {
      const { defaultWorkspace } = getWorkspaceDir(agentId);
      await fs.mkdir(defaultWorkspace, { recursive: true });
      const fullPath = resolveAndValidatePath(defaultWorkspace, filePath);
      console.log(`[Memory] Writing: ${fullPath}`);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      return res.json({ ok: true });
    }

    const fullPath = resolveAndValidatePath(agentDir, filePath);
    console.log(`[Memory] Writing: ${fullPath}`);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');

    res.json({ ok: true });
  } catch (error) {
    if (error.message === 'Path traversal detected') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    console.error('Error writing file:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a memory file
app.delete('/api/memory/:agentId/file', async (req, res) => {
  try {
    const { agentId } = req.params;
    const filePath = req.query.path;

    if (!validateAgentId(agentId)) {
      return res.status(400).json({ error: 'Invalid agent ID' });
    }
    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    const agentDir = await resolveAgentDir(agentId);
    if (!agentDir) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const fullPath = resolveAndValidatePath(agentDir, filePath);
    console.log(`[Memory] Deleting: ${fullPath}`);

    await fs.unlink(fullPath);
    res.json({ ok: true });
  } catch (error) {
    if (error.message === 'Path traversal detected') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    console.error('Error deleting file:', error);
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Proxy endpoint for testing LLM provider connections (avoids browser CORS)
app.post('/api/proxy-test', async (req, res) => {
  try {
    const { url, headers: reqHeaders } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    // SSRF protection: only allow HTTPS to public hosts
    if (!isAllowedProxyUrl(url)) {
      return res.status(403).json({ error: 'URL not allowed. Only HTTPS to external hosts is permitted.' });
    }

    console.log(`[Proxy] Testing connection to: ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      headers: reqHeaders || {},
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const body = await response.text();

    res.json({
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      body,
    });
  } catch (error) {
    console.error('[Proxy] Error:', error.message);
    if (error.name === 'AbortError') {
      res.json({ ok: false, status: 0, body: '', error: 'Connection timed out (15s)' });
    } else {
      res.json({ ok: false, status: 0, body: '', error: error.message });
    }
  }
});

// SPA catch-all: serve index.html for any non-API route (never cached)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  } else {
    next();
  }
});

// ─── WebSocket Proxy: /gateway -> ws://localhost:OPENCLAW_PORT/ ──────────────
// Cloudflared sends all traffic to this server. We proxy WebSocket upgrade
// requests on /gateway to the OpenClaw gateway, stripping the /gateway prefix.

const GATEWAY_HOST = '127.0.0.1';
const GATEWAY_PORT = parseInt(process.env.OPENCLAW_PORT || '18789');

const wsProxy = httpProxy.createProxyServer({
  target: `http://${GATEWAY_HOST}:${GATEWAY_PORT}`,
  ws: true,
  changeOrigin: false, // Preserve Origin header for gateway CORS check
  xfwd: true, // Forward X-Forwarded-For/Proto/Port so gateway trusts proxy
});

wsProxy.on('error', (err, _req, res) => {
  console.error('[WS Proxy] Error:', err.message);
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Gateway proxy error');
  }
});

const server = createServer(app);

server.on('upgrade', (req, socket, head) => {
  // Only proxy /gateway path
  if (!req.url || !req.url.startsWith('/gateway')) {
    socket.destroy();
    return;
  }

  // Rewrite path: /gateway -> /  (strip prefix, same as Vite dev proxy)
  req.url = req.url.replace(/^\/gateway/, '') || '/';

  console.log(`[WS Proxy] Upgrading: /gateway -> ${req.url} (-> ${GATEWAY_HOST}:${GATEWAY_PORT})`);

  wsProxy.ws(req, socket, head);
});

server.listen(PORT, () => {
  console.log(`Dashboard server running on http://localhost:${PORT}`);
  console.log(`OpenClaw directory: ${OPENCLAW_BASE}`);
  console.log(`WebSocket proxy: /gateway -> ws://${GATEWAY_HOST}:${GATEWAY_PORT}/`);
});
