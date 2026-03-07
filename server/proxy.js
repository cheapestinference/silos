import httpProxy from 'http-proxy';

export function createGatewayProxy(gatewayHost, gatewayPort) {
  const proxy = httpProxy.createProxyServer({
    target: `http://${gatewayHost}:${gatewayPort}`,
    ws: true,
    changeOrigin: false,
    xfwd: true,
  });

  proxy.on('error', (err, _req, res) => {
    console.error('[Gateway Proxy] Error:', err.message);
    if (res && typeof res.writeHead === 'function') {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Gateway proxy error');
    }
  });

  // HTTP middleware for /openclaw — proxies to gateway's control UI
  const httpMiddleware = (req, res) => {
    // Redirect /openclaw → /openclaw/ so relative asset paths (./assets/...) resolve correctly
    if (req.baseUrl === '/openclaw' && (req.url === '/' || req.url === '') && !req.originalUrl.endsWith('/')) {
      return res.redirect(301, '/openclaw/');
    }
    req.url = '/openclaw' + (req.url || '/');
    proxy.web(req, res);
  };

  // WebSocket upgrade handler for /gateway and /openclaw (control UI connects via /openclaw)
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
