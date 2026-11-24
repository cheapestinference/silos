// claude-code/network.ts — the hosts Claude Code itself calls, as its own
// network documentation publishes them for corporate proxies (verified
// against the page below). An agent on
// egress `allowlist` always has the non-optional ones pinned; the optional
// ones are offered, never pinned. Claude Code honours HTTPS_PROXY/HTTP_PROXY
// (basic auth in the URL) and NO_PROXY; its own WebSocket traffic to
// loopback never goes through a proxy.
import type { EngineHosts } from '../contract.js'

export const CLAUDE_ENGINE_HOSTS: EngineHosts = {
  source: 'https://code.claude.com/docs/en/network-config',
  hosts: [
    { host: 'api.anthropic.com', reason: 'the Claude API' },
    { host: 'claude.ai', reason: 'Claude account sign-in' },
    { host: 'claude.com', reason: 'Claude account sign-in' },
    { host: 'platform.claude.com', reason: 'Claude Console (API key) sign-in' },
    { host: 'sso.claude.com', reason: 'single sign-on' },
    { host: 'mcp-proxy.anthropic.com', reason: 'connectors (remote MCP) proxy' },
    { host: 'downloads.claude.ai', reason: 'native installer and updates' },
    { host: 'storage.googleapis.com', reason: 'installer and update downloads' },
    { host: 'registry.npmjs.org', reason: 'npm installs and updates' },
    { host: 'bridge.claudeusercontent.com', reason: 'Claude in Chrome bridge' },
    { host: '*.frame.claudeusercontent.com', reason: 'rendered content frames' },
    { host: 'github.com', reason: 'plugin marketplaces and GitHub integrations' },
    { host: 'raw.githubusercontent.com', reason: 'plugin marketplaces' },
    { host: 'code.claude.com', reason: 'its own documentation' },
    { host: '*-review.googlesource.com', optional: true, reason: 'Gerrit code review hosts' },
    { host: 'http-intake.logs.us5.datadoghq.com', optional: true, reason: 'operational telemetry' },
    { host: 'browser-intake-us5-datadoghq.com', optional: true, reason: 'operational telemetry' },
    { host: 'formulae.brew.sh', optional: true, reason: 'Homebrew installs and updates' },
  ],
}
