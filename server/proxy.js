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

  // noVNC proxy — forwards to the sandbox browser's noVNC server on port 6080
  const novncProxy = httpProxy.createProxyServer({
    target: 'http://127.0.0.1:6080',
    ws: true,
    changeOrigin: true,
  });

  novncProxy.on('error', (err, _req, res) => {
    console.error('[noVNC Proxy] Error:', err.message);
    if (res && typeof res.writeHead === 'function') {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Browser not available');
    }
  });

  // HTTP middleware for /openclaw — proxies to gateway's control UI
  const httpMiddleware = (req, res) => {
    // Redirect /openclaw → /openclaw/ so relative asset paths resolve correctly
    if (req.baseUrl === '/openclaw' && (req.url === '/' || req.url === '') && !req.originalUrl.endsWith('/')) {
      return res.redirect(301, '/openclaw/');
    }
    req.url = '/openclaw' + (req.url || '/');
    proxy.web(req, res);
  };

  // HTTP middleware for /browser — proxies noVNC static files
  const browserMiddleware = (req, res) => {
    // Strip /browser prefix so noVNC sees clean paths
    req.url = req.url || '/';
    novncProxy.web(req, res);
  };

  // WebSocket upgrade handler for /gateway, /openclaw, and /browser
  const upgradeHandler = (req, socket, head, gatewayToken) => {
    if (req.url && req.url.startsWith('/gateway')) {
      req.url = req.url.replace(/^\/gateway/, '') || '/';
      proxy.ws(req, socket, head);
    } else if (req.url && req.url.startsWith('/openclaw')) {
      proxy.ws(req, socket, head);
    } else if (req.url && req.url.startsWith('/browser')) {
      // Auth check for browser WebSocket
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (gatewayToken && token !== gatewayToken) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      req.url = req.url.replace(/^\/browser/, '') || '/';
      novncProxy.ws(req, socket, head);
    } else {
      socket.destroy();
    }
  };

  return { proxy, httpMiddleware, browserMiddleware, upgradeHandler };
}
