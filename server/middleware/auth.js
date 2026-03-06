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
