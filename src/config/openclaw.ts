// OpenClaw Dashboard Configuration

export const OPENCLAW_CONFIG = {
  // Gateway configuration
  GATEWAY_URL: 'http://127.0.0.1:18789', // Use 127.0.0.1 instead of localhost
  TOKEN: '0e4b0a1e28612b8d24e3df585d210edc6ac6f317affc3200',
  
  // Client configuration (must match gateway expectations)
  CLIENT_ID: 'openclaw-control-ui',
  CLIENT_VERSION: '1.0.0',
  CLIENT_PLATFORM: 'web',
  CLIENT_MODE: 'ui',

  // Authentication scopes
  SCOPES: ['operator.read', 'operator.admin', 'operator.approvals', 'operator.pairing'],
  ROLE: 'operator',
  
  // WebSocket configuration
  WS_PROTOCOL: 3,
  
  // RPC timeout (ms)
  RPC_TIMEOUT: 30000,
  
  // Reconnection settings
  RECONNECT_ATTEMPTS: 5,
  RECONNECT_DELAY: 1000,
  
  // Dashboard settings
  DEFAULT_SESSION_KEY: 'agent:main:main',
  DEFAULT_AGENT_ID: 'main'
} as const;