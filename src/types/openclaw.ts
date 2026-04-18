// OpenClaw Gateway Types
// Based on the OpenClaw protocol schema

// ============== Authentication ==============

export interface AuthCredentials {
  gatewayUrl: string;
  token?: string;
  password?: string;
}

export interface ConfigSnapshot {
  exists: boolean;
  valid: boolean;
  hash: string;
  config: Record<string, unknown>;
  raw: string;
}

export interface ConfigPatchResult {
  ok: boolean;
  path: string;
  config: Record<string, unknown>;
  restart?: {
    scheduled: boolean;
    delayMs: number;
  };
}

// ============== WebSocket Protocol ==============

export interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

export interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface EventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: {
    presence: number;
    health: number;
  };
}

export interface HelloOk {
  type: 'hello-ok';
  protocol: number;
  features?: {
    methods?: string[];
    events?: string[];
  };
  snapshot?: unknown;
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
    issuedAtMs?: number;
  };
  policy?: {
    tickIntervalMs?: number;
  };
}

// ============== Agents ==============

export interface AgentIdentity {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
}

export interface AgentSummary {
  id: string;
  name?: string;
  identity?: AgentIdentity;
  config?: AgentConfiguration;
}

// ============== Agent Configuration ==============

export type KnowledgeFileType = 'text' | 'markdown' | 'json';

export interface KnowledgeFile {
  id: string;
  name: string;
  content: string;
  type: KnowledgeFileType;
  createdAt: number;
  updatedAt?: number;
}

// Agent-to-Agent Communication Config
export interface AgentToAgentConfig {
  enabled: boolean;
  allowedAgents: string[];  // List of agent IDs allowed to communicate with, or ["*"] for all
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'adaptive';

export interface AgentSettings {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  thinkingDefault?: ThinkingLevel;
  enabledSkills?: string[];
  agentToAgent?: AgentToAgentConfig;
}

export interface AgentConfiguration {
  agentId: string;
  systemPrompt: string;
  contextMemory: string;
  knowledgeFiles: KnowledgeFile[];
  settings: AgentSettings;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConfigUpdateResult {
  ok: boolean;
  updatedAt: number;
}

export interface KnowledgeFileUploadResult {
  ok: boolean;
  id: string;
  createdAt: number;
}

export interface AgentsListResult {
  defaultId: string;
  mainKey: string;
  scope: 'per-sender' | 'global';
  agents: AgentSummary[];
}

// ============== Sessions ==============

export type SessionKind = 'direct' | 'group' | 'global' | 'unknown';

export interface GatewaySessionRow {
  key: string;
  kind: SessionKind;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  surface?: string;
  subject?: string;
  room?: string;
  space?: string;
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
  spawnedBy?: string;
}

export interface SessionsDefaults {
  model: string | null;
  contextTokens: number | null;
}

export interface SessionsListResult {
  ts: number;
  path: string;
  count: number;
  defaults: SessionsDefaults;
  sessions: GatewaySessionRow[];
}

export interface SessionsPatchResult {
  ok: true;
  path: string;
  key: string;
  entry: {
    sessionId: string;
    updatedAt?: number;
    thinkingLevel?: string;
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
  };
}

// ============== Cron Jobs ==============

export type CronScheduleAt = { kind: 'at'; atMs: number };
export type CronScheduleEvery = { kind: 'every'; everyMs: number; anchorMs?: number };
export type CronScheduleCron = { kind: 'cron'; expr: string; tz?: string };
export type CronSchedule = CronScheduleAt | CronScheduleEvery | CronScheduleCron;

export type CronSessionTarget = 'main' | 'isolated';
export type CronWakeMode = 'next-heartbeat' | 'now';

export type CronPayloadSystemEvent = { kind: 'systemEvent'; text: string };
export type CronPayloadAgentTurn = {
  kind: 'agentTurn';
  message: string;
  thinking?: string;
  timeoutSeconds?: number;
  deliver?: boolean;
  provider?: 'last' | 'whatsapp' | 'telegram' | 'discord' | 'slack' | 'signal' | 'imessage' | 'msteams';
  to?: string;
  bestEffortDeliver?: boolean;
};
export type CronPayload = CronPayloadSystemEvent | CronPayloadAgentTurn;

export interface CronIsolation {
  postToMainPrefix?: string;
}

export interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
}

export interface CronJob {
  id: string;
  agentId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  isolation?: CronIsolation;
  state?: CronJobState;
}

export interface CronStatus {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs?: number | null;
}

export interface CronRunLogEntry {
  ts: number;
  jobId: string;
  status: 'ok' | 'error' | 'skipped';
  durationMs?: number;
  error?: string;
  summary?: string;
}

// ============== Chat ==============

export type MessageStatus = 'queued' | 'sending' | 'delivered' | 'error';

export type AssistantPhase = 'commentary' | 'final_answer';

/**
 * Structured data extracted from a user message whose `provenance.kind`
 * is `inter_session` (OpenClaw injects these when a subagent/child task
 * announces a result). Rendered as an event card instead of a user bubble.
 */
export interface InterSessionEventMeta {
  kind: 'inter_session';
  sourceTool?: string;            // e.g. "subagent_announce"
  sourceSessionKey?: string;      // "agent:bright-helper:subagent:..."
  sourceChannel?: string;
  task?: string;
  status?: string;
  result?: string;                // parsed UNTRUSTED_CHILD_RESULT body
  announceType?: string;
  replyInstruction?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolCall?: unknown;
  result?: unknown;
  runId?: string;
  stream?: string;
  /** Status for user messages - tracks if message is queued, being processed, or delivered */
  status?: MessageStatus;
  /** Non-user-authored metadata (e.g. inter-session subagent announcements). */
  meta?: InterSessionEventMeta;
}

export interface ChatSendResult {
  runId: string;
  status: 'started' | 'in_flight' | 'ok';
}

export interface ChatHistoryResult {
  messages: ChatMessage[];
  hasMore?: boolean;
}

// ============== Tasks/Runs ==============

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'lost';

export interface Task {
  id: string;
  runId: string;
  sessionKey: string;
  agentId?: string;
  status: TaskStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolName?: string;
}

// ============== Telemetry: Errors + Latency ==============

export type SessionErrorKind =
  | 'provider'
  | 'rate_limit'
  | 'tool'
  | 'chat'
  | 'network'
  | 'aborted'
  | 'unknown';

export interface SessionError {
  id: string;
  sessionKey: string;
  timestamp: number;
  kind: SessionErrorKind;
  source: string;
  message: string;
  runId?: string;
  toolName?: string;
  raw?: unknown;
}

export type LatencyOutcome = 'ok' | 'error' | 'aborted';

export interface LatencyEntry {
  id: string;
  sessionKey: string;
  runId: string;
  startedAt: number;
  completedAt: number;
  latencyMs: number;
  ttfbMs?: number;
  outputChars?: number;
  outputTokens?: number;
  /** Raw tok/s over the full generation window (completedAt - firstDeltaAt). */
  tokensPerSecond?: number;
  /** tok/s excluding non-streaming gaps (likely tool/wait time). */
  effectiveTokensPerSecond?: number;
  /** Number of tool calls dispatched during the run. */
  toolCallCount?: number;
  /** Time spent waiting (gaps between text deltas > threshold — likely tools). */
  toolTimeMs?: number;
  outcome: LatencyOutcome;
  model?: string;
}

// ============== Channels ==============

export interface ChannelAccountSnapshot {
  accountId: string;
  name?: string | null;
  enabled?: boolean | null;
  configured?: boolean | null;
  linked?: boolean | null;
  running?: boolean | null;
  connected?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  mode?: string | null;
}

export interface ChannelsStatusSnapshot {
  ts: number;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channels: Record<string, unknown>;
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
  channelDefaultAccountId: Record<string, string>;
}

// ============== Presence ==============

export interface PresenceEntry {
  instanceId?: string | null;
  host?: string | null;
  ip?: string | null;
  version?: string | null;
  platform?: string | null;
  deviceFamily?: string | null;
  modelIdentifier?: string | null;
  mode?: string | null;
  lastInputSeconds?: number | null;
  reason?: string | null;
  text?: string | null;
  ts?: number | null;
}

// ============== Status & Health ==============

export interface StatusSummary {
  presence?: PresenceEntry[];
  health?: Record<string, unknown>;
  uptimeMs?: number;
}

export interface HealthSnapshot {
  [key: string]: unknown;
}

// ============== Models ==============

export type ModelApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'github-copilot'
  | 'bedrock-converse-stream';

export type ModelProviderAuthMode = 'api-key' | 'aws-sdk' | 'oauth' | 'token';

export interface ModelDefinitionConfig {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
}

export interface ModelProviderConfig {
  baseUrl: string;
  apiKey?: string;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelDefinitionConfig[];
}

export interface ModelsConfig {
  mode?: 'merge' | 'replace';
  providers?: Record<string, ModelProviderConfig>;
}

// Note: models.list returns an array of model entries, not providers
export interface ModelsListResult {
  models: ModelCatalogEntry[];
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
}

// This is what config.models contains
export interface ConfigModels {
  mode?: 'merge' | 'replace';
  providers?: Record<string, ModelProviderConfig>;
}

// ============== Dashboard State ==============

export interface DashboardState {
  connected: boolean;
  connecting: boolean;
  error: string | null;

  // Auth
  gatewayUrl: string;
  token: string | null;

  // Data
  agents: AgentsListResult | null;
  sessions: SessionsListResult | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  tasks: Task[];
  channels: ChannelsStatusSnapshot | null;
  presence: PresenceEntry[];

  // UI State
  selectedSessionKey: string | null;
  selectedAgentId: string | null;
  chatMessages: ChatMessage[];
  chatLoading: boolean;
  chatSending: boolean;
  activeRunId: string | null;
}
