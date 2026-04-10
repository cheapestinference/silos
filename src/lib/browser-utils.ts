export function buildNoVncUrl(token: string | null, opts: { password?: string; resize?: boolean } = {}) {
  const isDev = window.location.port === '3001' || window.location.port === '3002';
  const baseUrl = isDev
    ? `http://${window.location.hostname}:6080`
    : `${window.location.origin}/browser`;

  const params = new URLSearchParams();
  params.set('autoconnect', 'true');
  params.set('resize', opts.resize ? 'remote' : 'scale');
  if (opts.password) params.set('password', opts.password);

  if (!isDev && token) {
    params.set('token', token);
    params.set('path', `browser/websockify?token=${token}`);
  }

  // Cache-bust to ensure updated browser.html is loaded
  params.set('_cb', '8');

  return `${baseUrl}/browser.html?${params.toString()}`;
}
