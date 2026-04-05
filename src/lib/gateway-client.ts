import { generateId } from './utils';
import type {
  RequestFrame,
  ResponseFrame,
  EventFrame,
  HelloOk,
} from '../types/openclaw';

export type GatewayClientOptions = {
  url: string;
  token?: string;
  password?: string;
  onHello?: (hello: HelloOk) => void;
  onEvent?: (event: EventFrame) => void;
  onClose?: (info: { code: number; reason: string }) => void;
  onError?: (error: Error) => void;
  onReconnecting?: (attempt: number) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT = 30000;
const INITIAL_BACKOFF = 800;
const MAX_BACKOFF = 15000;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private closed = false;
  private lastSeq: number | null = null;
  private backoffMs = INITIAL_BACKOFF;
  private reconnectAttempt = 0;
  private connectSent = false;
  private helloReceived = false;

  constructor(private opts: GatewayClientOptions) { }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.helloReceived;
  }

  get connecting(): boolean {
    return this.ws?.readyState === WebSocket.CONNECTING || (this.ws?.readyState === WebSocket.OPEN && !this.helloReceived);
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error('Gateway client stopped'));
  }

  private connect(): void {
    if (this.closed) return;
    this.lastSeq = null;

    try {
      this.ws = new WebSocket(this.opts.url);
      this.connectSent = false;
      this.helloReceived = false;

      this.ws.onopen = () => {
        // Don't send connect immediately - wait for connect.challenge event
        // The gateway sends a challenge nonce first, then we respond with connect
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(String(event.data ?? ''));
      };

      this.ws.onclose = (event) => {
        const reason = String(event.reason ?? '');
        this.ws = null;
        this.helloReceived = false;
        this.flushPending(new Error(`Gateway closed (${event.code}): ${reason}`));
        this.opts.onClose?.({ code: event.code, reason });
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // Error will be followed by close event
        this.opts.onError?.(new Error('WebSocket error'));
      };
    } catch (error) {
      this.opts.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;

    this.reconnectAttempt++;
    this.opts.onReconnecting?.(this.reconnectAttempt);

    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, MAX_BACKOFF);

    setTimeout(() => this.connect(), delay);
  }

  private flushPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async sendConnect(): Promise<void> {
    if (this.connectSent) return;
    this.connectSent = true;

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'openclaw-control-ui',
        version: '1.0.0',
        platform: 'web',
        mode: 'ui',
      },


      role: 'operator',
      scopes: ['operator.read', 'operator.admin', 'operator.approvals', 'operator.pairing'],
      caps: ['tool-events'],
      auth: {
        token: this.opts.token,
        password: this.opts.password,
      },
      userAgent: 'Silos-Dashboard/1.0',
      locale: 'en',
    };

    try {
      const hello = await this.request<HelloOk>('connect', params);
      this.helloReceived = true;
      this.backoffMs = INITIAL_BACKOFF;
      this.reconnectAttempt = 0;
      this.opts.onHello?.(hello);
    } catch (error) {
      this.ws?.close(4008, 'connect failed');
    }
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };

    // Handle events
    if (frame.type === 'event') {
      const event = parsed as EventFrame;

      // Handle connect.challenge: gateway sends this before we can send connect
      if (event.event === 'connect.challenge') {
        this.sendConnect();
        return;
      }

      // Track sequence for gap detection
      const seq = typeof event.seq === 'number' ? event.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }

      this.opts.onEvent?.(event);
      return;
    }

    // Handle responses
    if (frame.type === 'res') {
      const response = parsed as ResponseFrame;
      const pending = this.pending.get(response.id);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pending.delete(response.id);

      if (response.ok) {
        pending.resolve(response.payload);
      } else {
        pending.reject(new Error(response.error?.message ?? 'Request failed'));
      }
      return;
    }
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway not connected');
    }

    const id = generateId();
    const frame: RequestFrame = { type: 'req', id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, REQUEST_TIMEOUT);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timeout,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  // ==================== API Methods ====================

  // Agents
  async listAgents() {
    return this.request<import('../types/openclaw').AgentsListResult>('agents.list');
  }

  async getAgentConfig(_agentId: string) {
    // agents.getConfig doesn't exist in OpenClaw 2026.2+
    // Agent configuration is available through config.get (full gateway config)
    // Return null to let the store use defaults
    return null;
  }

  async createAgent(params: { name: string; model?: string; emoji?: string; avatar?: string }) {
    return this.request<{ ok: boolean; agentId: string; name: string; workspace: string }>('agents.create', params);
  }

  async updateAgent(agentId: string, params: { name?: string; model?: string; workspace?: string }) {
    return this.request<{ ok: boolean; agentId: string }>('agents.update', { agentId, ...params });
  }

  async updateAgentConfig(agentId: string, config: Partial<import('../types/openclaw').AgentConfiguration>) {
    return this.request<import('../types/openclaw').AgentConfigUpdateResult>('agents.update', { agentId, ...config });
  }

  async uploadKnowledgeFile(agentId: string, file: Omit<import('../types/openclaw').KnowledgeFile, 'id' | 'createdAt'>) {
    return this.request<import('../types/openclaw').KnowledgeFileUploadResult>('agents.uploadKnowledgeFile', { agentId, ...file });
  }

  async deleteKnowledgeFile(agentId: string, fileId: string) {
    return this.request<{ ok: boolean }>('agents.deleteKnowledgeFile', { agentId, fileId });
  }

  async updateKnowledgeFile(agentId: string, fileId: string, updates: Partial<import('../types/openclaw').KnowledgeFile>) {
    return this.request<{ ok: boolean; updatedAt: number }>('agents.updateKnowledgeFile', { agentId, fileId, ...updates });
  }

  // Sessions
  async listSessions(opts?: {
    active?: string;
    limit?: number;
    includeGlobal?: boolean;
    spawnedBy?: string;
    agentId?: string;
    label?: string;
    search?: string;
    includeLastMessage?: boolean;
    includeDerivedTitles?: boolean;
  }) {
    return this.request<import('../types/openclaw').SessionsListResult>('sessions.list', opts);
  }

  async deleteSession(sessionKey: string) {
    return this.request<{ ok: boolean }>('sessions.delete', { key: sessionKey });
  }

  async patchSession(sessionKey: string, updates: Record<string, unknown>) {
    return this.request<import('../types/openclaw').SessionsPatchResult>('sessions.patch', { key: sessionKey, ...updates });
  }

  // Chat
  async getChatHistory(sessionKey: string, opts?: { limit?: number; before?: number }) {
    return this.request<{ messages: unknown[]; hasMore?: boolean }>('chat.history', { sessionKey, ...opts });
  }

  async sendChat(sessionKey: string, message: string, opts?: { thinking?: string; idempotencyKey?: string }) {
    return this.request<import('../types/openclaw').ChatSendResult>('chat.send', {
      sessionKey,
      message,
      idempotencyKey: opts?.idempotencyKey || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      thinking: opts?.thinking,
    });
  }

  async abortChat(sessionKey: string, runId?: string) {
    return this.request<{ ok: boolean }>('chat.abort', { sessionKey, runId });
  }

  // Cron
  async listCronJobs() {
    return this.request<{ jobs: import('../types/openclaw').CronJob[] }>('cron.list', { includeDisabled: true });
  }

  async getCronStatus() {
    return this.request<import('../types/openclaw').CronStatus>('cron.status');
  }

  async addCronJob(job: Partial<import('../types/openclaw').CronJob>) {
    return this.request<{ ok: boolean; id: string }>('cron.add', job);
  }

  async updateCronJob(id: string, updates: Partial<import('../types/openclaw').CronJob>) {
    return this.request<{ ok: boolean }>('cron.update', { jobId: id, patch: updates });
  }

  async removeCronJob(id: string) {
    return this.request<{ ok: boolean }>('cron.remove', { id });
  }

  async runCronJob(id: string) {
    return this.request<{ ok: boolean }>('cron.run', { id });
  }

  async getCronRuns(jobId: string, opts?: { limit?: number }) {
    // Backend returns { entries }, not { runs }
    const result = await this.request<{ entries: import('../types/openclaw').CronRunLogEntry[] }>('cron.runs', { jobId, ...opts });
    return { runs: result.entries || [] };
  }

  // Status
  async getStatus() {
    return this.request<import('../types/openclaw').StatusSummary>('status');
  }

  async getHealth() {
    return this.request<import('../types/openclaw').HealthSnapshot>('health');
  }

  // Channels
  async getChannelsStatus() {
    return this.request<import('../types/openclaw').ChannelsStatusSnapshot>('channels.status');
  }

  async logoutChannel(channel: string, accountId?: string) {
    return this.request<{ channel: string; accountId: string; cleared: boolean }>('channels.logout', { channel, ...(accountId && { accountId }) });
  }

  async webLoginStart(accountId?: string, force?: boolean) {
    return this.request<{ qrDataUrl?: string; message: string }>('web.login.start', {
      ...(accountId && { accountId }),
      ...(force && { force }),
      timeoutMs: 30000,
    });
  }

  async webLoginWait(accountId?: string) {
    return this.request<{ connected: boolean; message: string }>('web.login.wait', {
      ...(accountId && { accountId }),
      timeoutMs: 120000,
    });
  }

  // Agent workspace files (agents.files.*)
  async listAgentFiles(agentId: string) {
    return this.request<{ agentId: string; workspace: string; files: Array<{ name: string; path: string; missing?: boolean; size?: number; updatedAtMs?: number }> }>('agents.files.list', { agentId });
  }

  async getAgentFile(agentId: string, name: string) {
    return this.request<{ agentId: string; file: { name: string; path: string; missing?: boolean; size?: number; updatedAtMs?: number; content?: string } }>('agents.files.get', { agentId, name });
  }

  async setAgentFile(agentId: string, name: string, content: string) {
    return this.request<{ ok: boolean; agentId: string; file: { name: string; path: string; size?: number; updatedAtMs?: number } }>('agents.files.set', { agentId, name, content });
  }

  // Config
  async getConfig() {
    return this.request<import('../types/openclaw').ConfigSnapshot>('config.get');
  }

  async patchConfig(baseHash: string, patch: unknown) {
    return this.request<import('../types/openclaw').ConfigPatchResult>('config.patch', { baseHash, raw: JSON.stringify(patch) });
  }

  async setConfig(baseHash: string, fullConfig: unknown) {
    return this.request<import('../types/openclaw').ConfigPatchResult>('config.set', { baseHash, raw: JSON.stringify(fullConfig) });
  }

  // Models
  async listModels() {
    return this.request<import('../types/openclaw').ModelsListResult>('models.list');
  }
}

// Singleton instance
let clientInstance: GatewayClient | null = null;

export function getGatewayClient(): GatewayClient | null {
  return clientInstance;
}

export function createGatewayClient(opts: GatewayClientOptions): GatewayClient {
  if (clientInstance) {
    clientInstance.stop();
  }
  clientInstance = new GatewayClient(opts);
  return clientInstance;
}
