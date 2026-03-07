import httpProxy from 'http-proxy';
import crypto from 'crypto';

// --- Session cookie helpers ---
// Signs a value with HMAC-SHA256 using the gateway token as secret
function signCookie(value, secret) {
  const sig = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${sig}`;
}

function verifyCookie(signed, secret) {
  const idx = signed.lastIndexOf('.');
  if (idx < 1) return null;
  const value = signed.substring(0, idx);
  const sig = signed.substring(idx + 1);
  const expected = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  // value = email:expiry
  const [email, expiryStr] = value.split('|');
  if (!email || !expiryStr || Date.now() > parseInt(expiryStr)) return null;
  return email;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=');
  }
  return cookies;
}

export function setAuthCookie(res, email, secret) {
  const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const signed = signCookie(`${email}|${expiry}`, secret);
  res.cookie('silos_auth', signed, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function createGatewayProxy(gatewayHost, gatewayPort, gatewayToken) {
  const proxy = httpProxy.createProxyServer({
    target: `http://${gatewayHost}:${gatewayPort}`,
    ws: true,
    changeOrigin: false,
    xfwd: true,
    selfHandleResponse: false,
  });

  proxy.on('error', (err, _req, res) => {
    console.error('[Gateway Proxy] Error:', err.message);
    if (res && typeof res.writeHead === 'function') {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Gateway proxy error');
    }
  });

  // Inject gateway token into HTML responses so OpenClaw UI auto-connects
  const tokenInjectionProxy = httpProxy.createProxyServer({
    target: `http://${gatewayHost}:${gatewayPort}`,
    selfHandleResponse: true,
    changeOrigin: false,
    xfwd: true,
  });

  tokenInjectionProxy.on('error', (err, _req, res) => {
    console.error('[Gateway Proxy] Error:', err.message);
    if (res && typeof res.writeHead === 'function') {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Gateway proxy error');
    }
  });

  tokenInjectionProxy.on('proxyRes', (proxyRes, req, res) => {
    const contentType = proxyRes.headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');

    if (!isHtml || !req._injectToken) {
      // Pass through non-HTML responses unchanged
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    // Buffer HTML response to inject auth script
    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('end', () => {
      let html = Buffer.concat(chunks).toString('utf8');

      // Inject script that sets the token in OpenClaw UI's localStorage
      const script = `<script>
(function(){
  var KEY = 'openclaw.control.settings.v1';
  var TOKEN = ${JSON.stringify(gatewayToken)};
  try {
    var raw = localStorage.getItem(KEY);
    var store = raw ? JSON.parse(raw) : { state: {}, version: 0 };
    if (!store.state) store.state = {};
    if (store.state.token !== TOKEN) {
      store.state.token = TOKEN;
      localStorage.setItem(KEY, JSON.stringify(store));
    }
  } catch(e) {}
})();
</script>`;
      html = html.replace('</head>', script + '</head>');

      // Update content-length and send
      const headers = { ...proxyRes.headers };
      delete headers['content-length'];
      delete headers['content-encoding'];
      res.writeHead(proxyRes.statusCode, headers);
      res.end(html);
    });
  });

  // HTTP middleware for /openclaw — proxies to gateway's control UI
  const httpMiddleware = (req, res) => {
    // Redirect /openclaw → /openclaw/ so relative asset paths resolve correctly
    if (req.baseUrl === '/openclaw' && (req.url === '/' || req.url === '') && !req.originalUrl.endsWith('/')) {
      return res.redirect(301, '/openclaw/');
    }

    // Auth gate: only protect document navigations (HTML pages), not sub-resources.
    // The Accept header distinguishes browser navigations (text/html) from asset loads.
    const isNavigation = (req.headers.accept || '').includes('text/html');

    if (isNavigation && gatewayToken) {
      const cookies = parseCookies(req.headers.cookie);
      const email = cookies.silos_auth
        ? verifyCookie(cookies.silos_auth, gatewayToken)
        : null;

      if (!email) {
        return res.redirect(302, '/?redirect=openclaw');
      }

      // Inject token into the HTML page so OpenClaw UI auto-connects
      req.url = '/openclaw' + (req.url || '/');
      req._injectToken = true;
      return tokenInjectionProxy.web(req, res);
    }

    req.url = '/openclaw' + (req.url || '/');
    proxy.web(req, res);
  };

  // WebSocket upgrade handler for /gateway and /openclaw
  const upgradeHandler = (req, socket, head) => {
    if (req.url && req.url.startsWith('/gateway')) {
      req.url = req.url.replace(/^\/gateway/, '') || '/';
      proxy.ws(req, socket, head);
    } else if (req.url && req.url.startsWith('/openclaw')) {
      proxy.ws(req, socket, head);
    } else {
      socket.destroy();
    }
  };

  return { proxy, httpMiddleware, upgradeHandler };
}
