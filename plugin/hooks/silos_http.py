#!/usr/bin/env python3
# silos_http.py — the hooks' one way to ask the Silos server: a GET, in
# Python (stdlib only), so no hook needs curl.
#
#   python3 silos_http.py /api/agents        the body on stdout; exit 1 on any failure
#   python3 silos_http.py /healthz 1         the same, giving up after 1 second
#   import silos_http; silos_http.get(path)  the same, as bytes (raises on failure)
#
# · The bearer ($SILOS_AGENT_TOKEN) goes in a header built here, never in a
#   command line: another user's `ps` cannot read it.
# · A loopback server ($SILOS_API, default http://127.0.0.1:3210) is asked
#   directly: http_proxy / HTTPS_PROXY are ignored for it, so a machine
#   behind a proxy still reaches its own Silos and the bearer never goes to
#   the proxy. A Silos on another host keeps the environment's proxy rules.
# · A redirect is a failure, never followed: the bearer stays with the
#   server it was meant for.
# · Anything but a 2xx answer within the timeout raises (the caller says
#   less, or nothing).
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_API = 'http://127.0.0.1:3210'
TIMEOUT = 2


def api_base():
    return (os.environ.get('SILOS_API') or DEFAULT_API).rstrip('/')


def is_loopback(url):
    host = urllib.parse.urlsplit(url).hostname or ''
    return host == 'localhost' or host == '::1' or host.startswith('127.')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get(path, turn=False, timeout=TIMEOUT):
    """GET $SILOS_API<path> with the agent's bearer when there is one (and
    its turn token, with turn=True). Returns the body; raises otherwise."""
    url = api_base() + path
    if urllib.parse.urlsplit(url).scheme not in ('http', 'https'):
        raise ValueError('SILOS_API is not an http(s) address')
    req = urllib.request.Request(url)
    token = os.environ.get('SILOS_AGENT_TOKEN', '')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    if turn and os.environ.get('SILOS_TURN', ''):
        req.add_header('x-silos-turn', os.environ['SILOS_TURN'])
    handlers = [_NoRedirect()]
    if is_loopback(url):
        handlers.append(urllib.request.ProxyHandler({}))
    with urllib.request.build_opener(*handlers).open(req, timeout=timeout) as r:
        return r.read()


if __name__ == '__main__':
    try:
        sys.stdout.buffer.write(get(sys.argv[1], timeout=float(sys.argv[2]) if len(sys.argv) > 2 else TIMEOUT))
    except Exception:
        sys.exit(1)
