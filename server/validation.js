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
