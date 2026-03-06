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
    req.url = '/openclaw' + (req.url || '/');
    proxy.web(req, res);
  };

  // WebSocket upgrade handler for /gateway
  const upgradeHandler = (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/gateway')) {
      socket.destroy();
      return;
    }
    req.url = req.url.replace(/^\/gateway/, '') || '/';
    proxy.ws(req, socket, head);
  };

  return { proxy, httpMiddleware, upgradeHandler };
}
