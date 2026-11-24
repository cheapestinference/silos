// opencode/network.ts — the hosts OpenCode itself calls, as its own docs
// publish them (verified against the pages
// below): its own services, the models.dev catalogue it reads its provider
// list from, and the Anthropic API. OpenCode honours HTTPS_PROXY/HTTP_PROXY
// (basic auth in the URL) and recommends NO_PROXY=localhost,127.0.0.1,::1.
// A provider the agent runs on beyond these is the owner's to add.
import type { EngineHosts } from '../contract.js'

export const OPENCODE_ENGINE_HOSTS: EngineHosts = {
  source: 'https://opencode.ai/docs/network · https://opencode.ai/docs/providers',
  hosts: [
    { host: 'opencode.ai', reason: 'its own services' },
    { host: '*.opencode.ai', reason: 'its own services' },
    { host: 'models.dev', reason: 'the model catalogue' },
    { host: 'api.anthropic.com', reason: 'the Anthropic provider' },
  ],
}
