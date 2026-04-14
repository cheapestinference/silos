import type { GatewayClient } from '../lib/gateway-client';
import type {
  AgentsListResult,
  SessionsListResult,
  CronJob,
  CronStatus,
  CronRunLogEntry,
  Task,
  ChatMessage,
  ChannelsStatusSnapshot,
  PresenceEntry,
  EventFrame,
  TaskStatus,
  HelloOk,
  AgentConfiguration,
  KnowledgeFileType,
  ModelsListResult,
  ConfigSnapshot,
  SessionError,
  LatencyEntry,
  LatencyOutcome,
} from '../types/openclaw';

// --- Zustand slice helper types ---
// Each slice function receives these to mutate and read the full store.
export type StoreSet = (
  partial:
    | Partial<DashboardStore>
    | ((state: DashboardStore) => Partial<DashboardStore>),
) => void;
export type StoreGet = () => DashboardStore;

export interface DashboardStore {
  // Persist rehydration flag
  _hydrated: boolean;
  // Connection state
  connected: boolean;
  connecting: boolean;
  initialLoading: boolean;
  error: string | null;
  reconnectAttempt: number;

  // Settings
  gatewayUrl: string;
  token: string | null;
  darkMode: boolean;
  theme: string;

  // Data
  agents: AgentsListResult | null;
  sessions: SessionsListResult | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  tasks: Task[];
  channels: ChannelsStatusSnapshot | null;
  presence: PresenceEntry[];
  models: ModelsListResult | null;
  availableModels: Record<string, Array<{ id: string; name: string; contextWindow?: number }>> | null;
  gatewayConfig: ConfigSnapshot | null;

  // UI State
  selectedSessionKey: string | null;
  selectedAgentId: string | null;
  chatMessages: ChatMessage[];
  chatLoading: boolean;
  chatSending: Map<string, boolean>;
  activeRunId: Map<string, string>;
  runHadTools: Map<string, boolean>;
  messageQueue: Map<string, Array<{ id: string; text: string }>>;
  streamingContent: string;
  streamingRunId: string | null;
  streamingComplete: boolean;
  subagentParents: Map<string, string>;
  pendingSpawnParent: string | null;
  unreadCounts: Map<string, number>;
  sessionCumulativeTokens: Map<string, { total: number; lastInput: number; lastOutput: number }>;
  rateLimitedUntil: number;

  // Loading states
  agentsLoading: boolean;
  sessionsLoading: boolean;
  cronLoading: boolean;
  channelsLoading: boolean;
  modelsLoading: boolean;
  availableModelsLoading: boolean;
  gatewayConfigLoading: boolean;

  // Agent configuration state
  selectedAgentConfig: AgentConfiguration | null;
  configLoading: boolean;
  configSaving: boolean;
  configError: string | null;

  // Gateway client
  client: GatewayClient | null;

  // Actions
  setGatewayUrl: (url: string) => void;
  setToken: (token: string | null) => void;
  setDarkMode: (dark: boolean) => void;
  setTheme: (themeId: string) => void;
  connect: () => void;
  disconnect: () => void;

  // Data actions
  loadAgents: () => Promise<void>;
  loadSessions: () => Promise<void>;
  loadCronJobs: () => Promise<void>;
  loadChannels: () => Promise<void>;
  loadModels: () => Promise<void>;
  loadAvailableModels: () => Promise<void>;
  loadGatewayConfig: () => Promise<void>;
  loadAll: () => Promise<void>;

  // Agent actions
  deleteAgent: (agentId: string) => Promise<boolean>;
  resetAgent: (agentId: string) => Promise<boolean>;

  // Config actions
  patchGatewayConfig: (patch: Record<string, unknown>) => Promise<boolean>;

  // Model provider actions
  addModelProvider: (providerId: string, config: { baseUrl: string; apiKey?: string; api?: string; models?: Array<{ id: string; name: string; contextWindow: number; reasoning?: boolean }> }) => Promise<boolean>;
  deleteModelProvider: (providerId: string) => Promise<boolean>;

  // Session actions
  selectSession: (key: string | null) => void;
  deleteSession: (key: string) => Promise<void>;
  patchSession: (key: string, updates: Record<string, unknown>) => Promise<void>;
  addSessionOptimistic: (key: string, label?: string) => void;
  loadChatHistory: (key: string) => Promise<void>;

  // Chat actions
  sendMessage: (message: string) => Promise<void>;
  abortChat: () => Promise<void>;

  // Cron actions
  toggleCronJob: (id: string, enabled: boolean) => Promise<void>;
  runCronJob: (id: string) => Promise<void>;
  deleteCronJob: (id: string) => Promise<void>;
  addCronJob: (job: Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'>) => Promise<string | null>;
  updateCronJob: (id: string, updates: Partial<CronJob>) => Promise<boolean>;
  getCronRuns: (jobId: string) => Promise<CronRunLogEntry[]>;

  // Task actions
  updateTaskStatus: (id: string, status: TaskStatus) => void;
  abortTask: (runId: string) => Promise<void>;
  loadTaskHistory: () => Promise<void>;
  clearQueue: () => void;
  removeLastQueued: () => void;
  taskHistoryLoading: boolean;

  // Agent configuration actions
  loadAgentConfig: (agentId: string) => Promise<void>;
  saveAgentConfig: (agentId: string, config: Partial<AgentConfiguration>) => Promise<boolean>;

  // Memory file actions
  memoryFiles: Array<{ path: string; size: number; mtime: number; type?: 'file' | 'directory' }>;
  memoryContent: string;
  memoryLoading: boolean;
  listMemoryFiles: (agentId: string) => Promise<void>;
  readMemoryFile: (agentId: string, filePath: string) => Promise<void>;
  writeMemoryFile: (agentId: string, filePath: string, content: string) => Promise<boolean>;
  clearAgentConfig: () => void;
  uploadKnowledgeFile: (agentId: string, file: { name: string; content: string; type?: KnowledgeFileType }) => Promise<string | null>;
  deleteKnowledgeFile: (agentId: string, fileId: string) => Promise<boolean>;
  updateKnowledgeFile: (agentId: string, fileId: string, updates: Record<string, unknown>) => Promise<boolean>;

  // Workspace file actions
  workspaceFiles: Array<{ path: string; size: number; mtime: number; type: 'file' | 'directory' }>;
  workspaceContent: string;
  workspaceLoading: boolean;
  listWorkspaceFiles: (agentId: string) => Promise<void>;
  readWorkspaceFile: (agentId: string, filePath: string) => Promise<void>;
  writeWorkspaceFile: (agentId: string, filePath: string, content: string) => Promise<boolean>;
  deleteWorkspaceFile: (agentId: string, filePath: string) => Promise<boolean>;
  mkdirWorkspace: (agentId: string, dirPath: string) => Promise<boolean>;
  renameWorkspaceFile: (agentId: string, from: string, to: string) => Promise<boolean>;
  deleteWorkspaceDir: (agentId: string, dirPath: string) => Promise<boolean>;
  browseFilesystem: (dirPath: string) => Promise<{ path: string; items: Array<{ name: string; path: string; type: 'file' | 'directory' }> } | null>;

  // Unread message actions
  markSessionRead: (sessionKey: string) => void;
  incrementUnread: (sessionKey: string) => void;
  clearAllUnread: () => void;

  // Internal queue dispatch
  _dispatchNextQueued: (sessionKey: string) => Promise<void>;

  // Browser panel state
  browserPanelOpen: boolean;
  browserDetached: 'none' | 'overlay' | 'popout';
  browserAgentAction: string | null;

  // Browser panel actions
  setBrowserPanelOpen: (open: boolean) => void;
  setBrowserDetached: (mode: 'none' | 'overlay' | 'popout') => void;
  setBrowserAgentAction: (action: string | null) => void;

  // Event handlers
  handleEvent: (event: EventFrame) => void;
  handleHello: (hello: HelloOk) => void;
  autoConnect: () => void;

  // Telemetry: errors + latency per session
  sessionErrors: Map<string, SessionError[]>;
  latencyEntries: Map<string, LatencyEntry[]>;
  runTimings: Map<string, { sessionKey: string; startedAt: number; firstDeltaAt?: number; lastDeltaAt?: number; outputChars: number; toolCallCount: number; seenToolCallIds: Set<string>; toolTimeMs: number; model?: string }>;
  errorTabBadges: Map<string, number>;
  toolCallCounts: Map<string, number>;
  lastAgentActivity: Map<string, number>;
  lastKnownRunId: Map<string, string>;

  pushSessionError: (
    sessionKey: string,
    partial: Omit<SessionError, 'id' | 'sessionKey' | 'timestamp'>,
  ) => void;
  clearErrorBadge: (sessionKey: string) => void;
  clearSessionErrors: (sessionKey: string) => void;
  clearSessionLatency: (sessionKey: string) => void;
  incrementToolCallCount: (sessionKey: string) => void;
  recordAgentActivity: (sessionKey: string, runId?: string) => void;
  markRunStart: (runId: string, sessionKey: string, model?: string) => void;
  markRunFirstDelta: (runId: string) => void;
  accumulateRunChars: (runId: string, chars: number) => void;
  recordRunDelta: (runId: string) => void;
  recordRunToolCall: (runId: string, toolCallId?: string) => void;
  finalizeRunLatency: (runId: string, outcome: LatencyOutcome, model?: string) => void;
  discardRunTiming: (runId: string) => void;
}
