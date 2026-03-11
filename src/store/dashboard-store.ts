import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { GatewayClient, createGatewayClient } from '../lib/gateway-client';
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
  KnowledgeFile,
  KnowledgeFileType,
  ModelsListResult,
  ConfigSnapshot,
} from '../types/openclaw';
import { generateId } from '../lib/utils';

// --- Streaming buffer: accumulates deltas outside React state, flushes via RAF ---
let _streamingBuffer = '';
let _streamingRafId: number | null = null;
let _firstDeltaPending: { runId?: string } | null = null;
let _transitionTimerId: ReturnType<typeof setTimeout> | null = null;

/** Discard (not flush) the streaming buffer — used on session switch, abort, and error */
function clearStreamingBuffer() {
  if (_streamingRafId !== null) {
    cancelAnimationFrame(_streamingRafId);
    _streamingRafId = null;
  }
  _streamingBuffer = '';
  _firstDeltaPending = null;
}

function flushStreamingBuffer() {
  if (_streamingRafId !== null) {
    cancelAnimationFrame(_streamingRafId);
    _streamingRafId = null;
  }
  if (_streamingBuffer) {
    const buffered = _streamingBuffer;
    const pendingFirst = _firstDeltaPending;
    _streamingBuffer = '';
    _firstDeltaPending = null;
    useDashboardStore.setState((state) => ({
      streamingContent: (state.streamingContent || '') + buffered,
      ...(pendingFirst?.runId ? {
        chatMessages: state.chatMessages.map(m => {
          if (m.role === 'user' && m.status === 'sending' && (m.runId === pendingFirst.runId || !m.runId)) {
            return { ...m, status: 'delivered' as const, runId: pendingFirst.runId };
          }
          return m;
        }),
      } : {}),
    }));
  }
}

interface DashboardStore {
  // Connection state
  connected: boolean;
  connecting: boolean;
  error: string | null;
  reconnectAttempt: number;

  // Settings
  gatewayUrl: string;
  token: string | null;
  darkMode: boolean;

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
  chatSending: Map<string, boolean>; // Per-session sending state
  activeRunId: Map<string, string>; // Per-session active run ID
  streamingContent: string;
  streamingComplete: boolean;
  subagentParents: Map<string, string>; // subagentSessionKey -> parentSessionKey
  pendingSpawnParent: string | null; // Parent session for next spawned subagent
  unreadCounts: Map<string, number>; // sessionKey -> unread message count
  sessionCumulativeTokens: Map<string, { total: number; lastInput: number; lastOutput: number }>;

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
  taskHistoryLoading: boolean;

  // Agent configuration actions
  loadAgentConfig: (agentId: string) => Promise<void>;
  saveAgentConfig: (agentId: string, config: Partial<AgentConfiguration>) => Promise<boolean>;

  // Memory file actions (gateway WS - restricted to workspace .md files)
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

  // Workspace file actions (HTTP API - full file/folder CRUD)
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

  // Event handlers
  handleEvent: (event: EventFrame) => void;
  handleHello: (hello: HelloOk) => void;
  autoConnect: () => void;
}

/**
 * Strip OpenClaw inbound metadata blocks from user message content.
 * The gateway prepends blocks like "Conversation info (untrusted metadata): ```json ... ```"
 * to user messages when storing them. We strip these for display in the dashboard.
 */
function stripInboundMeta(content: unknown): string {
  if (!content) return '';

  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // OpenAI format: array of content parts
    text = content
      .map((item: unknown) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const i = item as Record<string, unknown>;
          if (typeof i.text === 'string') return i.text;
        }
        return '';
      })
      .join('\n');
  } else {
    text = String(content);
  }

  // Remove metadata blocks: "Label (untrusted metadata):\n```json\n...\n```"
  text = text.replace(/(?:Conversation info|Sender|Forwarded message context|Thread starter|Replied message|Chat history since last reply)\s*\(untrusted[^)]*\):\s*```json\n[\s\S]*?```\n*/g, '');

  // Remove inbound context system blocks if present
  text = text.replace(/## Inbound Context \(trusted metadata\)[\s\S]*?```\n*/g, '');

  // Remove date/time prefix like "[Wed 2026-02-25 14:30 GMT+1]" that gateway adds
  text = text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]*\]\s*/i, '');

  return text.trim();
}

export const useDashboardStore = create<DashboardStore>()(
  persist(
    (set, get) => ({
      // Initial state
      connected: false,
      connecting: false,
      error: null,
      reconnectAttempt: 0,

      // Gateway URL - usar localhost explícitamente (no 127.0.0.1)
      gatewayUrl: 'http://127.0.0.1:18789',

      token: null,
      darkMode: false,

      agents: null,
      sessions: null,
      cronJobs: [],
      cronStatus: null,
      tasks: [],
      taskHistoryLoading: false,
      channels: null,
      presence: [],
      models: null,
      availableModels: null,
      gatewayConfig: null,

      selectedSessionKey: null,
      selectedAgentId: null,
      chatMessages: [],
      chatLoading: false,
      chatSending: new Map(),
      activeRunId: new Map(),
      streamingContent: '',
      streamingComplete: false,
      subagentParents: new Map(),
      pendingSpawnParent: null,
      unreadCounts: new Map(),
      sessionCumulativeTokens: new Map(),

      agentsLoading: false,
      sessionsLoading: false,
      cronLoading: false,
      channelsLoading: false,
      modelsLoading: false,
      availableModelsLoading: false,
      gatewayConfigLoading: false,

      // Agent configuration
      selectedAgentConfig: null,
      configLoading: false,
      configSaving: false,
      configError: null,

      // Memory files
      memoryFiles: [],
      memoryContent: '',
      memoryLoading: false,

      // Workspace files
      workspaceFiles: [],
      workspaceContent: '',
      workspaceLoading: false,

      client: null,

      // Settings actions
      setGatewayUrl: (url) => set({ gatewayUrl: url }),
      setToken: (token) => set({ token }),
      setDarkMode: (dark) => {
        set({ darkMode: dark });
        if (dark) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      },

      // Connection actions
      connect: () => {
        let { gatewayUrl, token, handleEvent, handleHello } = get();

        const isDev = import.meta.env.DEV;
        const isLocalGateway = gatewayUrl.includes('localhost:18789') || gatewayUrl.includes('127.0.0.1:18789');

        if (isDev && isLocalGateway) {
          // Dev mode: usar proxy de Vite
          const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
          gatewayUrl = `${wsProto}://${window.location.host}/gateway`;
        } else if (window.location.protocol === 'https:' && isLocalGateway) {
          // Production over HTTPS: route through Cloudflare tunnel via /gateway
          gatewayUrl = `wss://${window.location.host}/gateway`;
        } else if (gatewayUrl.startsWith('http://') || gatewayUrl.startsWith('https://')) {
          gatewayUrl = gatewayUrl.replace(/^https?:\/\//, 'ws://');
          gatewayUrl = gatewayUrl.replace('localhost', '127.0.0.1');
        }

        set({ connecting: true, error: null });
        // No actualizamos gatewayUrl en el store para mantener la URL original


        const client = createGatewayClient({
          url: gatewayUrl,
          token: token ?? undefined,
          onHello: (hello) => {
            set({ connected: true, connecting: false, reconnectAttempt: 0 });
            handleHello(hello);
          },
          onEvent: (event) => {
            handleEvent(event);
          },
          onClose: ({ code, reason }) => {
            if (code === 1008 && reason?.includes('token mismatch')) {
              // Token mismatch: clear cached token so Firebase re-auth can provide a fresh one
              const { client } = get();
              client?.stop();
              set({ connected: false, connecting: false, token: null, client: null, error: 'Session expired. Please sign in again.' });
              return;
            }
            if (code !== 1000) {
              // Non-normal close: gateway client will auto-reconnect, keep connecting: true
              set({ connected: false, connecting: true, error: `Connection closed: ${reason || code}` });
            } else {
              // Normal close (user disconnected)
              set({ connected: false, connecting: false });
            }
          },
          onError: (error) => {
            set({ error: error.message });
          },
          onReconnecting: (attempt) => {
            set({ connecting: true, reconnectAttempt: attempt });
          },
        });

        client.start();
        set({ client });
      },

      autoConnect: () => {
        const { connected, connecting, connect } = get();
        if (!connected && !connecting) {
          connect();
        }
      },

      disconnect: () => {
        const { client } = get();
        client?.stop();
        set({
          client: null,
          connected: false,
          connecting: false,
          error: null,
        });
      },

      // Data loading
      loadAgents: async () => {
        const { client } = get();
        if (!client) return;

        set({ agentsLoading: true });
        try {
          const agents = await client.listAgents();
          set({ agents, agentsLoading: false });
        } catch (error) {
          set({ agentsLoading: false, error: String(error) });
        }
      },

      loadSessions: async () => {
        const { client, sessions: currentSessions } = get();
        if (!client) return;

        set({ sessionsLoading: true });
        try {
          const loadedSessions = await client.listSessions({ limit: 100, includeGlobal: true, includeDerivedTitles: true });

          // Build a map of current local sessions for label preservation
          const localSessionMap = new Map(
            currentSessions?.sessions.map(s => [s.key, s]) || []
          );

          // Merge backend sessions with local labels/displayNames where backend doesn't have them
          const mergedBackendSessions = loadedSessions.sessions.map(backendSession => {
            const localSession = localSessionMap.get(backendSession.key);
            if (localSession) {
              // Preserve local label/displayName if backend doesn't have one
              return {
                ...backendSession,
                label: backendSession.label || localSession.label,
                displayName: backendSession.displayName || localSession.displayName,
              };
            }
            return backendSession;
          });

          // Preserve optimistic sessions that don't exist on backend yet
          const loadedKeys = new Set(loadedSessions.sessions.map(s => s.key));
          const optimisticSessions = currentSessions?.sessions.filter(
            s => !loadedKeys.has(s.key)
          ) || [];

          // Merge: backend sessions (with preserved labels) + optimistic sessions
          const mergedSessions = {
            ...loadedSessions,
            sessions: [...mergedBackendSessions, ...optimisticSessions],
            count: loadedSessions.count + optimisticSessions.length,
          };

          // Accumulate per-session token usage (gateway overwrites per-run, we track cumulative)
          const cumTokens = new Map(get().sessionCumulativeTokens);
          for (const s of mergedBackendSessions) {
            const input = s.inputTokens || 0;
            const output = s.outputTokens || 0;
            const runTotal = input + output;
            const prev = cumTokens.get(s.key);
            if (!prev) {
              // First time seeing this session — seed with current values
              cumTokens.set(s.key, { total: runTotal, lastInput: input, lastOutput: output });
            } else if (input !== prev.lastInput || output !== prev.lastOutput) {
              // Values changed = new run completed, accumulate
              cumTokens.set(s.key, { total: prev.total + runTotal, lastInput: input, lastOutput: output });
            }
          }

          set({ sessions: mergedSessions, sessionsLoading: false, sessionCumulativeTokens: cumTokens });

          // Auto-load task history from subagent sessions
          setTimeout(() => get().loadTaskHistory(), 100);
        } catch (error) {
          set({ sessionsLoading: false, error: String(error) });
        }
      },

      loadCronJobs: async () => {
        const { client } = get();
        if (!client) {
          return;
        }

        set({ cronLoading: true });
        try {
          const [jobsResult, status] = await Promise.all([
            client.listCronJobs(),
            client.getCronStatus(),
          ]);
          set({ cronJobs: jobsResult.jobs || [], cronStatus: status, cronLoading: false });
        } catch (error) {
          console.error('[loadCronJobs] Error:', error);
          set({ cronLoading: false, error: String(error) });
        }
      },

      loadChannels: async () => {
        const { client } = get();
        if (!client) return;

        set({ channelsLoading: true });
        try {
          const channels = await client.getChannelsStatus();
          set({ channels, channelsLoading: false });
        } catch (error) {
          set({ channelsLoading: false, error: String(error) });
        }
      },

      loadModels: async () => {
        const { client } = get();
        if (!client) return;

        set({ modelsLoading: true });
        try {
          const models = await client.listModels();
          set({ models, modelsLoading: false });
        } catch (error) {
          set({ modelsLoading: false, error: String(error) });
        }
      },

      loadAvailableModels: async () => {
        const { token } = get();
        set({ availableModelsLoading: true });
        try {
          const headers: Record<string, string> = {};
          if (token) headers['Authorization'] = `Bearer ${token}`;
          const res = await fetch('/api/provider-models', { headers });
          if (res.ok) {
            const data = await res.json();
            set({ availableModels: data, availableModelsLoading: false });
          } else {
            set({ availableModelsLoading: false });
          }
        } catch {
          set({ availableModelsLoading: false });
        }
      },

      loadGatewayConfig: async () => {
        const { client } = get();
        if (!client) return;

        set({ gatewayConfigLoading: true });
        try {
          const gatewayConfig = await client.getConfig();
          set({ gatewayConfig, gatewayConfigLoading: false });
        } catch (error) {
          set({ gatewayConfigLoading: false, error: String(error) });
        }
      },

      patchGatewayConfig: async (patch) => {
        const { client, loadGatewayConfig } = get();
        if (!client) return false;

        try {
          const currentConfig = await client.getConfig();
          if (!currentConfig.valid) {
            set({ error: 'Invalid config state' });
            return false;
          }

          const result = await client.patchConfig(currentConfig.hash, patch);
          if (result.ok) {
            loadGatewayConfig().catch(() => { });
            return true;
          } else {
            set({ error: 'Failed to patch config' });
            return false;
          }
        } catch (error) {
          set({ error: String(error) });
          return false;
        }
      },

      addModelProvider: async (providerId, config) => {
        const { client, loadGatewayConfig } = get();
        if (!client) return false;

        try {
          // Get current config to get the hash
          const currentConfig = await client.getConfig();
          if (!currentConfig.valid) {
            set({ error: 'Invalid config state' });
            return false;
          }

          // Build the patch - add the new provider under models.providers
          // Transform models to match OpenClaw's expected format
          const modelsConfig = (config.models || []).map(m => ({
            id: m.id,
            name: m.name,
            reasoning: m.reasoning ?? false,
            input: ['text'] as ('text' | 'image')[],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: m.contextWindow,
            maxTokens: Math.min(m.contextWindow, 16384),
          }));

          const patch = {
            models: {
              providers: {
                [providerId]: {
                  baseUrl: config.baseUrl,
                  ...(config.apiKey && { apiKey: config.apiKey }),
                  ...(config.api && { api: config.api }),
                  models: modelsConfig,
                },
              },
            },
          };

          // Apply the patch
          const result = await client.patchConfig(currentConfig.hash, patch);
          if (result.ok) {
            // Gateway restarts after config.patch, so WebSocket will drop.
            // handleHello -> loadAll will reload config on reconnect.
            loadGatewayConfig().catch(() => { });
            return true;
          } else {
            set({ error: 'Failed to save provider config' });
            return false;
          }
        } catch (error) {
          set({ error: String(error) });
          return false;
        }
      },

      deleteModelProvider: async (providerId) => {
        const { client, loadGatewayConfig } = get();
        if (!client) return false;

        try {
          const currentConfig = await client.getConfig();
          if (!currentConfig.valid) {
            set({ error: 'Invalid config state' });
            return false;
          }

          // Get current providers and remove the target
          const config = currentConfig.config as Record<string, unknown>;
          const modelsSection = config.models as { providers?: Record<string, unknown> } | undefined;
          const currentProviders = modelsSection?.providers || {};

          if (!(providerId in currentProviders)) {
            set({ error: 'Provider not found in config' });
            return false;
          }

          // RFC 7396 merge-patch: set key to null to delete it
          const patch = {
            models: {
              providers: {
                [providerId]: null,
              },
            },
          };

          const result = await client.patchConfig(currentConfig.hash, patch);
          if (result.ok) {
            // Gateway restarts after config.patch - loadAll on reconnect handles reload
            loadGatewayConfig().catch(() => { });
            return true;
          } else {
            set({ error: 'Failed to delete provider' });
            return false;
          }
        } catch (error) {
          set({ error: String(error) });
          return false;
        }
      },

      loadAll: async () => {
        const { loadAgents, loadSessions, loadCronJobs, loadChannels, loadModels, loadAvailableModels, loadGatewayConfig } = get();
        await Promise.all([loadAgents(), loadSessions(), loadCronJobs(), loadChannels(), loadModels(), loadGatewayConfig(), loadAvailableModels()]);
      },

      // Agent actions
      deleteAgent: async (agentId) => {
        const { client, loadAgents } = get();
        if (!client) return false;

        try {
          const result = await client.request<{ ok: boolean }>('agents.delete', { agentId });
          if (result.ok) {
            setTimeout(() => loadAgents(), 5000);
            return true;
          }
          set({ error: 'Failed to delete agent' });
          return false;
        } catch (error) {
          set({ error: String(error) });
          return false;
        }
      },

      resetAgent: async (agentId) => {
        const { client } = get();
        if (!client) return false;

        try {
          // Reset the main session for this agent
          const sessionKey = `agent:${agentId}:main`;
          const result = await client.request<{ ok: boolean }>('sessions.reset', { key: sessionKey });
          return result.ok ?? false;
        } catch (error) {
          set({ error: String(error) });
          return false;
        }
      },

      // Session actions
      selectSession: (key) => {
        const { selectedSessionKey, markSessionRead } = get();
        // Skip if already on this session to avoid clearing messages unnecessarily
        if (key === selectedSessionKey) {
          return;
        }
        clearStreamingBuffer();
        if (_transitionTimerId !== null) {
          clearTimeout(_transitionTimerId);
          _transitionTimerId = null;
        }
        set({ selectedSessionKey: key, chatMessages: [], streamingContent: '', streamingComplete: false });
        if (key) {
          get().loadChatHistory(key);
          // Mark session as read when selected
          markSessionRead(key);
        }
      },

      deleteSession: async (key) => {
        const { client, sessions } = get();
        if (!client) return;

        try {
          await client.deleteSession(key);
          if (sessions) {
            set({
              sessions: {
                ...sessions,
                sessions: sessions.sessions.filter((s) => s.key !== key),
                count: sessions.count - 1,
              },
            });
          }
          if (get().selectedSessionKey === key) {
            set({ selectedSessionKey: null, chatMessages: [] });
          }
        } catch (error) {
          set({ error: String(error) });
        }
      },

      patchSession: async (key, updates) => {
        const { client, sessions } = get();
        if (!client) return;

        try {
          await client.patchSession(key, updates);
          // Update local session cache
          if (sessions) {
            set({
              sessions: {
                ...sessions,
                sessions: sessions.sessions.map((s) =>
                  s.key === key ? { ...s, ...updates } : s
                ),
              },
            });
          }
        } catch (error) {
          set({ error: String(error) });
        }
      },

      addSessionOptimistic: (key, label) => {
        const { sessions } = get();
        // Check if session already exists
        if (sessions?.sessions.some(s => s.key === key)) {
          return;
        }

        const newSession = {
          key,
          kind: 'direct' as const,
          label: label || key.split(':').pop() || key,
          updatedAt: Date.now(),
        };

        if (sessions) {
          set({
            sessions: {
              ...sessions,
              sessions: [newSession, ...sessions.sessions],
              count: sessions.count + 1,
            },
          });
        } else {
          set({
            sessions: {
              ts: Date.now(),
              path: '',
              count: 1,
              defaults: { model: null, contextTokens: null },
              sessions: [newSession],
            },
          });
        }
      },

      loadChatHistory: async (key) => {
        const { client } = get();
        if (!client) return;

        set({ chatLoading: true, error: null }); // Clear previous errors

        let effectiveKey = key;
        if (key.startsWith('dm-')) {
          const agentId = key.replace(/^dm-/, '');
          effectiveKey = `agent:${agentId}:dm-operator`;
        }

        // Ensure verboseLevel is 'full' so the gateway broadcasts tool events WITH results
        // 'on' sends events but strips result/partialResult; 'full' includes them
        client.patchSession(effectiveKey, { verboseLevel: 'full' }).catch(() => {
          // Ignore errors - session may not exist yet (e.g. new DM sessions)
        });

        try {
          const result = await client.getChatHistory(effectiveKey, { limit: 100 });
          const messages: ChatMessage[] = (result.messages || []).map((m: any, i: number) => ({
            id: m.id || `msg-${i}`,
            role: m.role || 'user',
            // Strip gateway metadata from user messages for clean display
            content: m.role === 'user'
              ? stripInboundMeta(m.content)
              : (typeof m.content === 'string'
                ? m.content
                : Array.isArray(m.content)
                  ? m.content
                    .map((item: any) => (typeof item === 'string' ? item : item?.text ?? null))
                    .filter(Boolean)
                    .join('\n') || ''
                  : ''),
            timestamp: m.timestamp || Date.now(),
            toolName: m.toolName,
            toolCall: m.toolCall,
            result: m.result,
            runId: m.runId,
          }));
          set({ chatMessages: messages, chatLoading: false });
        } catch (error) {
          // If it's a DM session that doesn't exist yet, just show empty history
          if (key.startsWith('dm-')) {
            set({ chatMessages: [], chatLoading: false });
            return;
          }
          set({ chatLoading: false, error: String(error) });
        }
      },

      // Chat actions
      sendMessage: async (message) => {
        const { client, selectedSessionKey, chatMessages, chatSending, activeRunId } = get();
        if (!client || !selectedSessionKey) return;

        // Cancel any pending transition timer from a previous completion
        if (_transitionTimerId !== null) {
          clearTimeout(_transitionTimerId);
          _transitionTimerId = null;
        }

        // Check if we're already processing a message for this session
        const isAlreadySending = chatSending.get(selectedSessionKey) === true;

        // If streaming content exists, flush it as an assistant message before sending new user message
        const currentStreaming = get().streamingContent;
        if (currentStreaming && currentStreaming.trim()) {
          flushStreamingBuffer();
          const activeRun = activeRunId.get(selectedSessionKey);
          const alreadyExists = activeRun && chatMessages.some(m => m.runId === activeRun && m.role === 'assistant');
          if (!alreadyExists) {
            const flushedMessage: ChatMessage = {
              id: generateId(),
              role: 'assistant',
              content: currentStreaming,
              timestamp: Date.now(),
              runId: activeRun,
            };
            set((state) => ({
              chatMessages: [...state.chatMessages, flushedMessage],
              streamingContent: '',
              streamingComplete: false,
            }));
          } else {
            set({ streamingContent: '', streamingComplete: false });
          }
          clearStreamingBuffer();
        }

        // Re-read chatMessages after potential flush
        const latestMessages = get().chatMessages;

        // Add user message immediately with appropriate status
        const messageId = generateId();
        const userMessage: ChatMessage = {
          id: messageId,
          role: 'user',
          content: message,
          timestamp: Date.now(),
          status: isAlreadySending ? 'queued' : 'sending',
        };

        // Update per-session sending state (only set to true if not already sending)
        const newChatSending = new Map(chatSending);
        if (!isAlreadySending) {
          newChatSending.set(selectedSessionKey, true);
        }

        set({
          chatMessages: [...latestMessages, userMessage],
          chatSending: newChatSending,
          streamingContent: '',
          streamingComplete: false,
        });

        // Handle agent routing: if it's a DM session dm-{agentId},
        // we use the agent:agentId:dm-operator format for the gateway
        let effectiveSessionKey = selectedSessionKey;
        if (selectedSessionKey.startsWith('dm-')) {
          const agentId = selectedSessionKey.replace(/^dm-/, '');
          effectiveSessionKey = `agent:${agentId}:dm-operator`;
        }

        try {
          const result = await client.sendChat(effectiveSessionKey, message, {
            idempotencyKey: messageId,
          });

          // Update message with runId — keep 'queued' status if gateway says in_flight
          console.log(`[sendMessage] gateway response: status=${result.status} runId=${result.runId} isAlreadySending=${isAlreadySending}`);
          const isInFlight = result.status === 'in_flight' || isAlreadySending;
          set({
            chatMessages: get().chatMessages.map(m =>
              m.id === messageId
                ? { ...m, runId: result.runId, status: (isInFlight ? 'queued' : 'sending') as const }
                : m
            ),
          });

          // Only update activeRunId if this was the first message (not queued/in_flight)
          if (!isAlreadySending && !isInFlight) {
            const newActiveRunId = new Map(activeRunId);
            newActiveRunId.set(selectedSessionKey, result.runId);
            set({ activeRunId: newActiveRunId });
          }

          // Refresh sessions list to show newly created sessions
          get().loadSessions();
        } catch (error) {
          // Mark message as error
          set({
            chatMessages: get().chatMessages.map(m =>
              m.id === messageId ? { ...m, status: 'error' as const } : m
            ),
          });

          // Only clear sending state if this was the active message
          if (!isAlreadySending) {
            const newChatSending = new Map(get().chatSending);
            newChatSending.delete(selectedSessionKey);
            set({ chatSending: newChatSending, error: String(error) });
          }
        }
      },

      abortChat: async () => {
        const { client, activeRunId, selectedSessionKey, chatSending, tasks } = get();
        if (!client || !selectedSessionKey) return;

        const runId = activeRunId.get(selectedSessionKey);
        if (!runId) {
          return;
        }

        // Translate DM sessionKey to effective key
        let effectiveSessionKey = selectedSessionKey;
        if (selectedSessionKey.startsWith('dm-')) {
          const agentId = selectedSessionKey.replace(/^dm-/, '');
          effectiveSessionKey = `agent:${agentId}:dm-operator`;
        }

        try {
          await client.abortChat(effectiveSessionKey, runId);

          clearStreamingBuffer();
          if (_transitionTimerId !== null) {
            clearTimeout(_transitionTimerId);
            _transitionTimerId = null;
          }

          const newActiveRunId = new Map(activeRunId);
          newActiveRunId.delete(selectedSessionKey);

          const newChatSending = new Map(chatSending);
          newChatSending.delete(selectedSessionKey);

          // Also update the task status to aborted
          set({
            activeRunId: newActiveRunId,
            chatSending: newChatSending,
            tasks: tasks.map((t) =>
              t.runId === runId ? { ...t, status: 'aborted', completedAt: Date.now() } : t
            ),
            streamingContent: '', // Clear any streaming content
            streamingComplete: false,
          });

        } catch (error) {
          console.error('[Abort] Failed:', error);
          set({ error: String(error) });
        }
      },

      clearQueue: () => {
        set((state) => ({
          chatMessages: state.chatMessages.map(m =>
            m.role === 'user' && m.status === 'queued'
              ? { ...m, status: 'error' as const }
              : m
          ),
        }));
      },

      // Cron actions
      toggleCronJob: async (id, enabled) => {
        const { client } = get();
        if (!client) {
          return;
        }

        // Optimistic update - update UI immediately
        set((state) => ({
          cronJobs: state.cronJobs.map((job) =>
            job.id === id ? { ...job, enabled } : job
          ),
        }));

        try {
          await client.updateCronJob(id, { enabled });
          // State already updated optimistically
        } catch (error) {
          console.error('[Cron] Toggle failed:', error);
          // Revert on error - get fresh state
          set((state) => ({
            cronJobs: state.cronJobs.map((job) =>
              job.id === id ? { ...job, enabled: !enabled } : job
            ),
            error: String(error),
          }));
        }
      },

      runCronJob: async (id) => {
        const { client } = get();
        if (!client) return;

        try {
          await client.runCronJob(id);
        } catch (error) {
          set({ error: String(error) });
        }
      },

      deleteCronJob: async (id) => {
        const { client } = get();
        if (!client) return;

        try {
          await client.removeCronJob(id);
          // Use updater function to get fresh state
          set((state) => ({ cronJobs: state.cronJobs.filter((job) => job.id !== id) }));
        } catch (error) {
          set({ error: String(error) });
        }
      },

      addCronJob: async (job) => {
        const { client } = get();
        if (!client) return null;

        try {
          const result = await client.addCronJob(job);
          if (result.ok) {
            // Add the new job to local state using updater function
            // This preserves the state of other jobs (e.g., toggled enabled/disabled)
            const now = Date.now();
            const newJob: CronJob = {
              id: result.id,
              name: job.name,
              description: job.description,
              enabled: job.enabled ?? true,
              schedule: job.schedule,
              payload: job.payload,
              sessionTarget: job.sessionTarget,
              wakeMode: job.wakeMode,
              agentId: job.agentId,
              createdAtMs: now,
              updatedAtMs: now,
              state: undefined,
            };
            set((state) => ({ cronJobs: [...state.cronJobs, newJob] }));
            return result.id;
          }
          return null;
        } catch (error) {
          set({ error: String(error) });
          return null;
        }
      },

      updateCronJob: async (id, updates) => {
        const { client } = get();
        if (!client) return false;

        try {
          const result = await client.updateCronJob(id, updates);
          if (result.ok) {
            // Update local state using updater function for fresh state
            set((state) => ({
              cronJobs: state.cronJobs.map((job) =>
                job.id === id ? { ...job, ...updates, updatedAtMs: Date.now() } : job
              ),
            }));
            return true;
          }
          return false;
        } catch (error) {
          set({ error: String(error) });
          return false;
        }
      },

      getCronRuns: async (jobId) => {
        const { client } = get();
        if (!client) return [];

        try {
          // Only fetch last 5 runs to keep UI simple
          const result = await client.getCronRuns(jobId, { limit: 5 });
          return result.runs || [];
        } catch (error) {
          console.error('[getCronRuns] Error:', error);
          return [];
        }
      },

      // Task actions
      updateTaskStatus: (id, status) => {
        const { tasks } = get();
        set({
          tasks: tasks.map((task) =>
            task.id === id
              ? { ...task, status, completedAt: status === 'completed' ? Date.now() : undefined }
              : task
          ),
        });
      },

      abortTask: async (runId) => {
        const { client, tasks } = get();
        if (!client) return;

        try {
          await client.abortChat(runId);
          set({
            tasks: tasks.map((task) =>
              task.runId === runId ? { ...task, status: 'aborted' as TaskStatus } : task
            ),
          });
        } catch (error) {
          set({ error: String(error) });
        }
      },

      loadTaskHistory: async () => {
        const { client, tasks } = get();
        if (!client) return;

        set({ taskHistoryLoading: true });
        try {
          // Fetch sessions that are sub-agents (spawned by other sessions)
          const result = await client.listSessions({
            limit: 100,
            includeLastMessage: true,
            includeDerivedTitles: true,
          });

          if (!result?.sessions) {
            set({ taskHistoryLoading: false });
            return;
          }

          // Filter for sub-agent sessions (key contains :subagent: or -subagent-)
          const subagentSessions = result.sessions.filter(
            (s) => s.key?.includes(':subagent:') || s.key?.includes('-subagent-')
          );

          // Convert sessions to tasks
          const historyTasks: Task[] = subagentSessions.map((session) => {
            // Extract agent ID from sessionKey: agent:{agentId}:subagent:{uuid}
            let agentId: string | undefined;
            if (session.key?.startsWith('agent:')) {
              const parts = session.key.split(':');
              if (parts.length >= 2) {
                agentId = parts[1];
              }
            }

            // Determine status based on available info
            let status: TaskStatus = 'completed';
            if (session.abortedLastRun) {
              status = 'aborted';
            }

            return {
              id: session.sessionId || session.key || generateId(),
              runId: session.sessionId || session.key || '',
              sessionKey: session.key || '',
              agentId,
              status,
              startedAt: session.updatedAt || Date.now(),
              completedAt: session.updatedAt || Date.now(),
              inputTokens: session.inputTokens,
              outputTokens: session.outputTokens,
            };
          });

          // Merge with existing tasks (avoid duplicates by sessionKey)
          const existingKeys = new Set(tasks.map((t) => t.sessionKey));
          const newTasks = historyTasks.filter((t) => !existingKeys.has(t.sessionKey));

          set({
            tasks: [...tasks, ...newTasks],
            taskHistoryLoading: false,
          });
        } catch (error) {
          console.error('[TaskHistory] Error loading:', error);
          set({ taskHistoryLoading: false, error: String(error) });
        }
      },

      // Agent configuration actions
      loadAgentConfig: async (agentId) => {
        const { client } = get();
        if (!client) return;

        set({ configLoading: true, configError: null });
        try {
          const config = await client.getAgentConfig(agentId);
          if (config) {
            set({ selectedAgentConfig: config, configLoading: false });
          } else {
            // No saved config - create empty default (UI will show gateway defaults visually)
            const defaultConfig: AgentConfiguration = {
              agentId,
              systemPrompt: '',
              contextMemory: '',
              knowledgeFiles: [],
              settings: {},
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            set({ selectedAgentConfig: defaultConfig, configLoading: false });
          }
        } catch (error) {
          // If config doesn't exist yet, create a default one
          const defaultConfig: AgentConfiguration = {
            agentId,
            systemPrompt: '',
            contextMemory: '',
            knowledgeFiles: [],
            settings: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          set({
            selectedAgentConfig: defaultConfig,
            configLoading: false,
            configError: null, // Don't show error for new agents
          });
        }
      },

      saveAgentConfig: async (agentId, config) => {
        const { client, selectedAgentConfig } = get();
        if (!client) return false;

        set({ configSaving: true, configError: null });
        try {
          const result = await client.updateAgentConfig(agentId, config);
          if (result.ok && selectedAgentConfig) {
            set({
              selectedAgentConfig: {
                ...selectedAgentConfig,
                ...config,
                updatedAt: result.updatedAt,
              },
              configSaving: false,
            });
          }
          return result.ok;
        } catch (error) {
          set({ configSaving: false, configError: String(error) });
          return false;
        }
      },

      clearAgentConfig: () => {
        set({ selectedAgentConfig: null, configError: null });
      },

      uploadKnowledgeFile: async (agentId: string, file: { name: string; content: string; type?: KnowledgeFileType }) => {
        const { client, selectedAgentConfig } = get();
        if (!client) return null;

        const fileWithType = { ...file, type: file.type ?? 'text' as KnowledgeFileType };

        try {
          const result = await client.uploadKnowledgeFile(agentId, fileWithType);
          if (result.ok && selectedAgentConfig) {
            const newFile: KnowledgeFile = {
              ...fileWithType,
              id: result.id,
              createdAt: result.createdAt,
            };
            set({
              selectedAgentConfig: {
                ...selectedAgentConfig,
                knowledgeFiles: [...selectedAgentConfig.knowledgeFiles, newFile],
              },
            });
            return result.id;
          }
          return null;
        } catch (error) {
          set({ configError: String(error) });
          return null;
        }
      },

      deleteKnowledgeFile: async (agentId: string, fileId: string) => {
        const { client, selectedAgentConfig } = get();
        if (!client) return false;

        try {
          const result = await client.deleteKnowledgeFile(agentId, fileId);
          if (result.ok && selectedAgentConfig) {
            set({
              selectedAgentConfig: {
                ...selectedAgentConfig,
                knowledgeFiles: selectedAgentConfig.knowledgeFiles.filter(f => f.id !== fileId),
              },
            });
          }
          return result.ok;
        } catch (error) {
          set({ configError: String(error) });
          return false;
        }
      },

      updateKnowledgeFile: async (agentId: string, fileId: string, updates: Record<string, unknown>) => {
        const { client, selectedAgentConfig } = get();
        if (!client) return false;

        try {
          const result = await client.updateKnowledgeFile(agentId, fileId, updates);
          if (result.ok && selectedAgentConfig) {
            set({
              selectedAgentConfig: {
                ...selectedAgentConfig,
                knowledgeFiles: selectedAgentConfig.knowledgeFiles.map(f =>
                  f.id === fileId ? { ...f, ...updates, updatedAt: result.updatedAt } : f
                ),
              },
            });
          }
          return result.ok;
        } catch (error) {
          set({ configError: String(error) });
          return false;
        }
      },

      // Memory file actions - uses gateway WebSocket methods (agents.files.*)
      listMemoryFiles: async (agentId) => {
        const { client } = get();
        if (!client) { set({ memoryFiles: [], memoryLoading: false }); return; }
        set({ memoryLoading: true });

        try {
          const result = await client.listAgentFiles(agentId);
          const files = (result?.files || []).map(f => ({
            path: f.name,
            size: f.size || 0,
            mtime: f.updatedAtMs || 0,
          }));
          set({ memoryFiles: files, memoryLoading: false });
        } catch (error) {
          console.error('[Memory] Error listing files:', error);
          set({ memoryFiles: [], memoryLoading: false });
        }
      },

      readMemoryFile: async (agentId, filePath) => {
        // filePath is the file name (e.g. 'MEMORY.md')
        const fileName = filePath.split('/').pop() || filePath;
        const { client } = get();
        if (!client) { set({ memoryContent: '', memoryLoading: false }); return; }
        set({ memoryLoading: true });

        try {
          const result = await client.getAgentFile(agentId, fileName);
          const content = result?.file?.content || '';
          set({ memoryContent: content, memoryLoading: false });
        } catch (error) {
          console.error('[Memory] Error reading file:', error);
          set({ memoryContent: '', memoryLoading: false });
        }
      },

      writeMemoryFile: async (agentId, filePath, content) => {
        const fileName = filePath.split('/').pop() || filePath;
        const { client } = get();
        if (!client) return false;

        try {
          const result = await client.setAgentFile(agentId, fileName, content);
          return result?.ok || false;
        } catch (error) {
          console.error('[Memory] Error writing file:', error);
          return false;
        }
      },

      // Workspace file actions (HTTP API via server.js)
      listWorkspaceFiles: async (agentId) => {
        const { token: authToken } = get();
        set({ workspaceLoading: true });
        try {
          const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}`, {
            headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
          });
          const result = await response.json();
          set({ workspaceFiles: result?.files || [], workspaceLoading: false });
        } catch (error) {
          console.error('[Workspace] Error listing files:', error);
          set({ workspaceFiles: [], workspaceLoading: false });
        }
      },

      readWorkspaceFile: async (agentId, filePath) => {
        const { token: authToken } = get();
        set({ workspaceLoading: true });
        try {
          const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(filePath)}`, {
            headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
          });
          const result = await response.json();
          set({ workspaceContent: result?.content || '', workspaceLoading: false });
        } catch (error) {
          console.error('[Workspace] Error reading file:', error);
          set({ workspaceContent: '', workspaceLoading: false });
        }
      },

      writeWorkspaceFile: async (agentId, filePath, content) => {
        const { token: authToken } = get();
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
          const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(filePath)}`, {
            method: 'POST', headers, body: JSON.stringify({ content }),
          });
          const result = await response.json();
          return result?.ok || false;
        } catch (error) {
          console.error('[Workspace] Error writing file:', error);
          return false;
        }
      },

      deleteWorkspaceFile: async (agentId, filePath) => {
        const { token: authToken } = get();
        try {
          const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(filePath)}`, {
            method: 'DELETE',
            headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
          });
          const result = await response.json();
          return result?.ok || false;
        } catch (error) {
          console.error('[Workspace] Error deleting file:', error);
          return false;
        }
      },

      mkdirWorkspace: async (agentId, dirPath) => {
        const { token: authToken } = get();
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
          const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/mkdir?path=${encodeURIComponent(dirPath)}`, {
            method: 'POST', headers,
          });
          const result = await response.json();
          return result?.ok || false;
        } catch (error) {
          console.error('[Workspace] Error creating directory:', error);
          return false;
        }
      },

      renameWorkspaceFile: async (agentId, from, to) => {
        const { token: authToken } = get();
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
          const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/rename`, {
            method: 'POST', headers, body: JSON.stringify({ from, to }),
          });
          const result = await response.json();
          return result?.ok || false;
        } catch (error) {
          console.error('[Workspace] Error renaming:', error);
          return false;
        }
      },

      deleteWorkspaceDir: async (agentId, dirPath) => {
        const { token: authToken } = get();
        try {
          const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/dir?path=${encodeURIComponent(dirPath)}`, {
            method: 'DELETE',
            headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
          });
          const result = await response.json();
          return result?.ok || false;
        } catch (error) {
          console.error('[Workspace] Error deleting directory:', error);
          return false;
        }
      },

      browseFilesystem: async (dirPath) => {
        const { token: authToken } = get();
        try {
          const headers: Record<string, string> = {};
          if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
          const response = await fetch(`/api/browse?path=${encodeURIComponent(dirPath)}`, { headers });
          if (!response.ok) return null;
          return await response.json();
        } catch (error) {
          console.error('[Browse] Error:', error);
          return null;
        }
      },

      // Unread message actions
      markSessionRead: (sessionKey) => {
        set((state) => {
          const newCounts = new Map(state.unreadCounts);
          newCounts.delete(sessionKey);
          return { unreadCounts: newCounts };
        });
      },

      incrementUnread: (sessionKey) => {
        set((state) => {
          const newCounts = new Map(state.unreadCounts);
          const current = newCounts.get(sessionKey) || 0;
          newCounts.set(sessionKey, current + 1);
          return { unreadCounts: newCounts };
        });
      },

      clearAllUnread: () => {
        set({ unreadCounts: new Map() });
      },

      // Event handlers
      handleEvent: (event) => {
        const { selectedSessionKey } = get();

        // Calculate effective session key for comparison
        const currentEffectiveKey = selectedSessionKey?.startsWith('dm-')
          ? `agent:${selectedSessionKey.replace(/^dm-/, '')}:dm-operator`
          : selectedSessionKey;

        // Handle streaming text from 'agent' events (stream: 'assistant')
        if (event.event === 'agent') {
          const payload = event.payload as any;
          const eventSessionKey = payload?.sessionKey;

          // Check if this event belongs to our currently selected session
          // BUT allow subagent events through for task tracking (they have different session keys)
          const isSubagentEvent = eventSessionKey?.includes(':subagent:') || eventSessionKey?.includes('-subagent-');
          const isFromSameAgent = (() => {
            if (!eventSessionKey || !currentEffectiveKey) return false;
            const eventAgentMatch = eventSessionKey.match(/^agent:([^:]+)/);
            const currentAgentMatch = currentEffectiveKey.match(/^agent:([^:]+)/);
            return eventAgentMatch && currentAgentMatch && eventAgentMatch[1] === currentAgentMatch[1];
          })();

          if (eventSessionKey && eventSessionKey !== currentEffectiveKey) {
            // Track unread for other sessions when message completes
            if (payload?.stream === 'lifecycle' &&
              (payload?.data?.phase === 'complete' || payload?.data?.phase === 'done' || payload?.data?.phase === 'end')) {
              get().incrementUnread(eventSessionKey);
            }
            // Allow subagent events from the same agent to pass through for task/tool tracking
            // but skip display events (streaming, assistant deltas) for other sessions
            if (!isSubagentEvent || !isFromSameAgent) {
              return;
            }
            // Subagent events from same agent: skip display handling below,
            // but fall through to task tracking section (second 'agent' event block)
          }

          // Only process display events (streaming, tool calls) for the current session, not subagent events
          const isCurrentSessionEvent = eventSessionKey === currentEffectiveKey || !eventSessionKey;

          if (isCurrentSessionEvent && payload?.stream === 'assistant' && payload?.data?.delta) {
            const isFirstDelta = !get().streamingContent && !_streamingBuffer;

            // If first delta, mark user message as delivered immediately (important UX feedback)
            if (isFirstDelta) {
              // Cancel any pending transition timer from a previous completion
              if (_transitionTimerId !== null) {
                clearTimeout(_transitionTimerId);
                _transitionTimerId = null;
              }
              const selKey = get().selectedSessionKey;
              const runId = payload?.runId || (selKey ? get().activeRunId.get(selKey) : undefined);
              if (runId) {
                _firstDeltaPending = { runId };
              }
            }

            // Accumulate delta in buffer (no React re-render)
            _streamingBuffer += payload.data.delta;

            // Schedule RAF flush if not already scheduled
            if (_streamingRafId === null) {
              _streamingRafId = requestAnimationFrame(() => {
                _streamingRafId = null;
                const buffered = _streamingBuffer;
                _streamingBuffer = '';
                const pendingFirst = _firstDeltaPending;
                _firstDeltaPending = null;

                if (!buffered) return;

                set((state) => {
                  const updates: Partial<DashboardStore> = {
                    streamingContent: (state.streamingContent || '') + buffered,
                  };

                  // Handle first-delta user message status update
                  if (pendingFirst?.runId) {
                    updates.chatMessages = state.chatMessages.map(m => {
                      if (m.role === 'user' && m.status === 'sending' && (m.runId === pendingFirst.runId || !m.runId)) {
                        return { ...m, status: 'delivered' as const, runId: pendingFirst.runId };
                      }
                      return m;
                    });
                  }

                  return updates;
                });
              });
            }
          } else if (isCurrentSessionEvent && payload?.stream === 'tool') {
            flushStreamingBuffer();
            const toolName = payload?.data?.name || payload?.data?.toolName;
            const phase = payload?.data?.phase;

            // Handle tool call start - show what tool is being called
            if ((phase === 'call' || phase === 'input' || phase === 'start') && toolName) {
              // First, save any accumulated streaming content as an assistant message
              set((state) => {
                const messages = [...state.chatMessages];

                // If there's streaming content, save it first
                if (state.streamingContent && state.streamingContent.trim()) {
                  const assistantMessage: ChatMessage = {
                    id: generateId(),
                    role: 'assistant',
                    content: state.streamingContent,
                    timestamp: Date.now(),
                    runId: payload?.runId,
                  };
                  messages.push(assistantMessage);
                }

                // Add tool call message (showing input/args)
                const toolCallMessage: ChatMessage = {
                  id: generateId(),
                  role: 'tool',
                  content: '', // Will be filled when result comes
                  timestamp: Date.now(),
                  toolName: toolName,
                  toolCall: payload?.data?.input || payload?.data?.args,
                  runId: payload?.runId,
                  status: 'sending',
                };
                messages.push(toolCallMessage);

                return {
                  chatMessages: messages,
                  streamingContent: '', // Clear streaming content since we saved it
                };
              });
            }

            // Handle tool results
            if (phase === 'result' && toolName) {
              const toolResult = payload?.data?.result;
              const toolArgs = payload?.data?.args || payload?.data?.input;

              set((state) => {
                // Find the pending tool message — try strict runId match first, then relaxed
                let pendingToolIdx = state.chatMessages.findIndex(
                  m => m.role === 'tool' && m.toolName === toolName && m.status === 'sending' && m.runId === payload?.runId
                );
                if (pendingToolIdx === -1) {
                  // Relaxed: match by toolName + sending status (last one wins)
                  for (let i = state.chatMessages.length - 1; i >= 0; i--) {
                    const m = state.chatMessages[i];
                    if (m.role === 'tool' && m.toolName === toolName && m.status === 'sending') {
                      pendingToolIdx = i;
                      break;
                    }
                  }
                }

                if (pendingToolIdx !== -1) {
                  // Update existing pending tool message
                  const messages = [...state.chatMessages];
                  messages[pendingToolIdx] = {
                    ...messages[pendingToolIdx],
                    content: toolResult ? (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2)) : '',
                    result: toolResult,
                    toolCall: messages[pendingToolIdx].toolCall || toolArgs,
                    status: 'delivered',
                  };
                  return { chatMessages: messages };
                } else {
                  // No pending message found, create a new one with args from result event
                  const toolMessage: ChatMessage = {
                    id: generateId(),
                    role: 'tool',
                    content: toolResult ? (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2)) : '',
                    timestamp: Date.now(),
                    toolName: toolName,
                    toolCall: toolArgs,
                    result: toolResult,
                    runId: payload?.runId,
                  };
                  return { chatMessages: [...state.chatMessages, toolMessage] };
                }
              });
            }
          }

          // Handle agent run error (LLM provider failure, auth errors, etc.)
          if (isCurrentSessionEvent && payload?.stream === 'lifecycle' && (payload?.data?.phase === 'error' || (payload?.data?.phase === 'end' && payload?.data?.isError))) {
            clearStreamingBuffer();
            if (_transitionTimerId !== null) {
              clearTimeout(_transitionTimerId);
              _transitionTimerId = null;
            }
            set((state) => {
              const runId = payload?.runId || (state.selectedSessionKey ? state.activeRunId.get(state.selectedSessionKey) : undefined);
              const errorDetail = payload?.data?.error || payload?.data?.message || '';

              // Classify rate limit type from LiteLLM error detail
              const isRateLimit = errorDetail.includes('429') || /rate limit/i.test(errorDetail);
              if (isRateLimit) {
                const limitType = /budget/i.test(errorDetail) ? 'BUDGET'
                  : /requests?\s*per\s*minute|rpm/i.test(errorDetail) ? 'RPM'
                    : /tokens?\s*per\s*minute|tpm/i.test(errorDetail) ? 'TPM'
                      : 'UNKNOWN';
                const resetMatch = errorDetail.match(/resets?\s*(?:at|in)[:\s]*(.+?)(?:\s*UTC)?\s*$/i);
                console.log(`[RateLimit] Type: ${limitType} | Reset: ${resetMatch?.[1] || 'unknown'} | Detail: ${errorDetail}`);
                const recentRateLimit = state.chatMessages.find(
                  m => m.role === 'system' && m.content?.startsWith('__provider_error__') &&
                    (m.content.includes('429') || /rate limit/i.test(m.content)) &&
                    (Date.now() - m.timestamp) < 60000
                );
                if (recentRateLimit) {
                  // Still clear sending state but don't add another error message
                  const newActiveRunId = new Map(state.activeRunId);
                  const newChatSending = new Map(state.chatSending);
                  if (state.selectedSessionKey) {
                    newActiveRunId.delete(state.selectedSessionKey);
                    newChatSending.delete(state.selectedSessionKey);
                  }
                  return {
                    streamingContent: '',
                    streamingComplete: false,
                    chatSending: newChatSending,
                    activeRunId: newActiveRunId,
                  };
                }
              }

              // Create a system error message visible to the user
              const errorMessage: ChatMessage = {
                id: generateId(),
                role: 'system',
                content: `__provider_error__${errorDetail}`,
                timestamp: Date.now(),
                runId: runId,
              };

              // Mark user message as error
              const updatedMessages = state.chatMessages.map(m => {
                if (runId && m.runId === runId && m.role === 'user' && (m.status === 'sending' || m.status === 'queued')) {
                  return { ...m, status: 'error' as const };
                }
                if (!runId && m.role === 'user' && m.status === 'sending') {
                  return { ...m, status: 'error' as const };
                }
                return m;
              });

              const newActiveRunId = new Map(state.activeRunId);
              const newChatSending = new Map(state.chatSending);
              if (state.selectedSessionKey) {
                newActiveRunId.delete(state.selectedSessionKey);
                newChatSending.delete(state.selectedSessionKey);
              }

              return {
                chatMessages: [...updatedMessages, errorMessage],
                streamingContent: '',
                streamingComplete: false,
                chatSending: newChatSending,
                activeRunId: newActiveRunId,
              };
            });
          }

          // Handle completion from agent events (some backends send it here)
          // Note: 'end' is also a completion phase in some backends
          if (isCurrentSessionEvent && payload?.stream === 'lifecycle' && (payload?.data?.phase === 'complete' || payload?.data?.phase === 'done' || (payload?.data?.phase === 'end' && !payload?.data?.isError))) {
            flushStreamingBuffer();
            // Use functional update to get latest state and avoid race conditions
            set((state) => {
              const runId = payload?.runId || (state.selectedSessionKey ? state.activeRunId.get(state.selectedSessionKey) : undefined);

              const newActiveRunId = new Map(state.activeRunId);
              const newChatSending = new Map(state.chatSending);
              if (state.selectedSessionKey) {
                newActiveRunId.delete(state.selectedSessionKey);
                newChatSending.delete(state.selectedSessionKey);
              }
              const updatedTasks = runId
                ? state.tasks.map((t) =>
                  t.runId === runId ? { ...t, status: 'completed' as const, completedAt: Date.now() } : t
                )
                : state.tasks;

              // If already completed by another handler, or no streaming content, just clear sending state
              if (state.streamingComplete || !state.streamingContent || !state.streamingContent.trim()) {
                return { chatSending: newChatSending, activeRunId: newActiveRunId, tasks: updatedTasks, streamingComplete: false };
              }

              // Deduplication check: if a message with this runId already exists in history, don't add it again
              const alreadyExists = runId && state.chatMessages.some(m => m.runId === runId && (m.role === 'assistant' || m.role === 'tool'));
              if (alreadyExists) {
                return { chatSending: newChatSending, activeRunId: newActiveRunId, tasks: updatedTasks, streamingContent: '', streamingComplete: false };
              }

              const assistantMessage: ChatMessage = {
                id: generateId(),
                role: 'assistant',
                content: state.streamingContent,
                timestamp: Date.now(),
                runId: runId,
              };

              // Update user message status from 'sending' to 'delivered'
              const hasRunIdMatch = runId && state.chatMessages.some(m => m.runId === runId && m.role === 'user' && m.status === 'sending');
              let foundSending = false;
              const updatedChatMessages = state.chatMessages.map(m => {
                if (runId && m.runId === runId && m.role === 'user' && m.status === 'sending') {
                  return { ...m, status: 'delivered' as const };
                }
                if (!hasRunIdMatch && !foundSending && m.role === 'user' && m.status === 'sending') {
                  foundSending = true;
                  return { ...m, status: 'delivered' as const, runId: runId || m.runId };
                }
                return m;
              });

              // Two-phase transition: add message + mark complete, then clear streaming after brief delay
              _transitionTimerId = setTimeout(() => {
                _transitionTimerId = null;
                useDashboardStore.setState({ streamingContent: '', streamingComplete: false });
              }, 150);

              return {
                chatMessages: [...updatedChatMessages, assistantMessage],
                streamingContent: '',
                streamingComplete: false,
                chatSending: newChatSending,
                activeRunId: newActiveRunId,
                tasks: updatedTasks,
              };
            });
            // Refresh sessions to update token counts
            setTimeout(() => get().loadSessions(), 1000);
          }
        }

        // Handle chat events
        if (event.event === 'chat') {
          const payload = event.payload as any;
          const eventSessionKey = payload?.sessionKey;

          if (eventSessionKey && eventSessionKey !== currentEffectiveKey) {
            return;
          }

          // Handle streaming text - supports both legacy (stream='text', delta) and current (state='delta', message) formats
          // Legacy format: stream='text' + delta (incremental token)
          // Current format: state='delta' + message.content (accumulated full text)
          const isLegacyDelta = payload?.stream === 'text' && payload?.delta;
          const isStateDelta = payload?.state === 'delta' && payload?.message?.content;

          const chatDeltaText = isLegacyDelta
            ? payload.delta
            : isStateDelta
              ? (Array.isArray(payload.message.content)
                ? payload.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
                : typeof payload.message.content === 'string' ? payload.message.content : null)
              : null;

          if (chatDeltaText) {
            // Cancel any pending transition timer if this is the first delta
            if (!get().streamingContent && _transitionTimerId !== null) {
              clearTimeout(_transitionTimerId);
              _transitionTimerId = null;
            }
            // Clear RAF buffer: if state='delta' (accumulated), buffer content is already
            // included in the accumulated text. If legacy delta, avoid double-append with
            // agent events that also buffer the same deltas.
            if (_streamingRafId !== null) {
              cancelAnimationFrame(_streamingRafId);
              _streamingRafId = null;
            }
            _streamingBuffer = '';
            _firstDeltaPending = null;

            set((state) => {
              const isFirstDelta = !state.streamingContent;
              const runId = payload?.runId || (state.selectedSessionKey ? state.activeRunId.get(state.selectedSessionKey) : undefined);

              // state='delta' sends accumulated content, so replace instead of append
              const newStreamingContent = isStateDelta ? chatDeltaText : state.streamingContent + chatDeltaText;

              // If this is the first delta, mark the user's sending message as delivered
              if (isFirstDelta && runId) {
                const updatedMessages = state.chatMessages.map(m => {
                  if (m.role === 'user' && m.status === 'sending' && (m.runId === runId || !m.runId)) {
                    return { ...m, status: 'delivered' as const, runId: runId };
                  }
                  return m;
                });
                return {
                  streamingContent: newStreamingContent,
                  chatMessages: updatedMessages,
                };
              }

              return {
                streamingContent: newStreamingContent,
              };
            });
          }

          // Handle tool calls
          if (payload?.toolName) {
            const toolMessage: ChatMessage = {
              id: generateId(),
              role: 'tool',
              content: payload.result ? JSON.stringify(payload.result, null, 2) : '',
              timestamp: Date.now(),
              toolName: payload.toolName,
              toolCall: payload.toolCall,
              result: payload.result,
              runId: payload.runId,
            };
            // Use functional update to avoid race conditions
            set((state) => ({ chatMessages: [...state.chatMessages, toolMessage] }));
          }

          // Handle completion (legacy: status='ok'|'done', current: state='final'|'done')
          if (payload?.status === 'ok' || payload?.status === 'done' || payload?.state === 'final' || payload?.state === 'done') {
            // Use functional update to get latest state and avoid race conditions
            set((state) => {
              const runId = payload?.runId || (state.selectedSessionKey ? state.activeRunId.get(state.selectedSessionKey) : undefined);

              const newActiveRunId = new Map(state.activeRunId);
              const newChatSending = new Map(state.chatSending);
              if (state.selectedSessionKey) {
                newActiveRunId.delete(state.selectedSessionKey);
                newChatSending.delete(state.selectedSessionKey);
              }

              // Mark task as completed
              const updatedTasks = runId
                ? state.tasks.map((t) =>
                  t.runId === runId ? { ...t, status: 'completed' as const, completedAt: Date.now() } : t
                )
                : state.tasks;

              // If already completed by another handler, or no streaming content, just clear sending state
              if (state.streamingComplete || !state.streamingContent || !state.streamingContent.trim()) {
                return {
                  chatSending: newChatSending,
                  activeRunId: newActiveRunId,
                  tasks: updatedTasks,
                  streamingComplete: false,
                };
              }

              // Deduplication check: if a message with this runId already exists in history, don't add it again
              const alreadyExists = runId && state.chatMessages.some(m => m.runId === runId && (m.role === 'assistant' || m.role === 'tool'));
              if (alreadyExists) {
                return {
                  chatSending: newChatSending,
                  activeRunId: newActiveRunId,
                  tasks: updatedTasks,
                  streamingContent: '',
                  streamingComplete: false,
                };
              }

              const assistantMessage: ChatMessage = {
                id: generateId(),
                role: 'assistant',
                content: state.streamingContent,
                timestamp: Date.now(),
                runId: runId,
              };

              return {
                chatMessages: [...state.chatMessages, assistantMessage],
                streamingContent: '',
                streamingComplete: false,
                chatSending: newChatSending,
                activeRunId: newActiveRunId,
                tasks: updatedTasks,
              };
            });
            // Refresh sessions to update token counts
            setTimeout(() => get().loadSessions(), 1000);
          }
        }

        // Handle agent events for task tracking
        // Only track: sub-agents (spawned via sessions_spawn) and background processes
        if (event.event === 'agent') {
          const payload = event.payload as any;
          const runId = payload?.runId;
          const stream = payload?.stream;
          const phase = payload?.data?.phase;
          const toolResult = payload?.data?.result;
          const taskSessionKey = payload?.sessionKey || selectedSessionKey || 'unknown';

          // Detect sub-agent by sessionKey pattern: agent:{id}:subagent:{uuid} or webchat:g-agent-{id}-subagent-{uuid}
          const isSubAgent = taskSessionKey.includes(':subagent:') || taskSessionKey.includes('-subagent-');

          // Check for background process (result contains "still running" or similar)
          const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || '');
          const isBackgroundProcess =
            resultStr.includes('still running') ||
            resultStr.includes('Command still running') ||
            resultStr.includes('background') ||
            resultStr.includes('pid ');

          // Check for lifecycle events
          const isLifecycleStart = stream === 'lifecycle' && phase === 'start';
          const isLifecycleEnd = stream === 'lifecycle' && (phase === 'end' || phase === 'error');

          // Check for tool execution
          const isToolStart = stream === 'tool' && (phase === 'start' || phase === 'call' || phase === 'input');
          const isToolEnd = stream === 'tool' && phase === 'result';
          const toolName = payload?.data?.name || payload?.data?.toolName || payload?.toolName;

          if (runId) {
            const { tasks } = get();
            const existingTask = tasks.find((t: Task) => t.runId === runId);

            // Extract agent ID from sessionKey
            let agentId: string | null = null;
            if (taskSessionKey.startsWith('agent:')) {
              const parts = taskSessionKey.split(':');
              if (parts.length >= 2) {
                agentId = parts[1];
              }
            }

            // CREATE TASK for:
            // 1. Sub-agent lifecycle start (not regular chat sessions)
            // 2. Background processes (detected from tool result)
            // Regular chat conversations are NOT tasks — only subagents and background processes.
            if (!existingTask && ((isLifecycleStart && isSubAgent) || isBackgroundProcess)) {
              const newTask: Task = {
                id: generateId(),
                runId: runId,
                sessionKey: taskSessionKey,
                agentId: agentId || undefined,
                status: 'running',
                startedAt: Date.now(),
              };
              set((state) => ({ tasks: [...state.tasks, newTask] }));
            }

            // CREATE TASK for tool execution (separate from subagent/background tasks)
            // Use a unique ID based on runId + toolName to avoid duplicates
            if (isToolStart && toolName) {
              const toolTaskId = `${runId}-tool-${toolName}`;
              const existingToolTask = tasks.find((t: Task) => t.id === toolTaskId);

              // Track potential spawn parent when spawn-related tools are called
              const isSpawnTool = toolName.toLowerCase().includes('spawn') ||
                toolName.toLowerCase().includes('task') ||
                toolName === 'sessions_spawn';
              if (isSpawnTool && selectedSessionKey) {
                set({ pendingSpawnParent: selectedSessionKey });
              }

              if (!existingToolTask) {
                const newTask: Task = {
                  id: toolTaskId,
                  runId: runId,
                  sessionKey: taskSessionKey,
                  agentId: agentId || undefined,
                  status: 'running',
                  startedAt: Date.now(),
                  toolName: toolName,
                };
                set((state) => ({ tasks: [...state.tasks, newTask] }));
              }
            }

            // COMPLETE TOOL TASK on result
            if (isToolEnd && toolName) {
              const toolTaskId = `${runId}-tool-${toolName}`;
              const existingToolTask = tasks.find((t: Task) => t.id === toolTaskId);

              if (existingToolTask) {
                const isError = payload?.data?.isError;

                set((state) => ({
                  tasks: state.tasks.map((t: Task) =>
                    t.id === toolTaskId
                      ? {
                        ...t,
                        status: isError ? 'error' : 'completed',
                        completedAt: Date.now(),
                        error: isError ? (payload?.data?.error || 'Error') : undefined,
                      }
                      : t
                  ),
                }));
              }
            }

            // Track subagent parent when we first see it (any event)
            if (isSubAgent) {
              const { subagentParents, pendingSpawnParent, sessions } = get();
              // Only track if we haven't seen this subagent before
              if (!subagentParents.has(taskSessionKey)) {
                // Determine parent: use pendingSpawnParent, or selectedSessionKey if different from subagent
                let parentKey: string | null = null;

                if (pendingSpawnParent && pendingSpawnParent !== taskSessionKey) {
                  parentKey = pendingSpawnParent;
                } else if (selectedSessionKey && selectedSessionKey !== taskSessionKey) {
                  parentKey = selectedSessionKey;
                }

                // Try to find the actual session key in the sessions list
                // This handles cases where selectedSessionKey (from URL) doesn't match gateway's key format
                if (parentKey && sessions?.sessions) {
                  // Helper to extract agent ID from various key formats
                  const extractAgentId = (key: string): string | null => {
                    const agentMatch = key.match(/^agent:([^:]+)/);
                    if (agentMatch) return agentMatch[1];
                    const webchatMatch = key.match(/^webchat:g-agent-([^-]+)/);
                    if (webchatMatch) return webchatMatch[1];
                    const dmMatch = key.match(/^dm-(.+)$/);
                    if (dmMatch) return dmMatch[1];
                    return null;
                  };

                  // First check if exact match exists
                  const exactMatch = sessions.sessions.some(s => s.key === parentKey);
                  if (!exactMatch) {
                    // Try to find by suffix or label matching
                    const parentParts = parentKey.split(':');
                    const parentAgentId = extractAgentId(parentKey);
                    const parentSuffix = parentParts.length >= 3 ? parentParts.slice(2).join(':') : null;

                    const matchedSession = sessions.sessions.find(s => {
                      // Skip subagent sessions
                      if (s.key.includes(':subagent:') || s.key.includes('-subagent-')) return false;
                      // Check agent ID
                      const sessionAgentId = extractAgentId(s.key);
                      if (sessionAgentId !== parentAgentId) return false;
                      // Check suffix match
                      if (parentSuffix) {
                        if (s.key.endsWith(`:${parentSuffix}`)) return true;
                        if (s.key.endsWith(`-${parentSuffix}`)) return true;
                        if (s.label === parentSuffix || s.displayName === parentSuffix) return true;
                      }
                      return false;
                    });

                    if (matchedSession) {
                      parentKey = matchedSession.key;
                    }
                  }
                }

                if (parentKey) {
                  // Store the parent relationship and clear pendingSpawnParent
                  set((state) => {
                    const newParents = new Map(state.subagentParents);
                    newParents.set(taskSessionKey, parentKey!);
                    return { subagentParents: newParents, pendingSpawnParent: null };
                  });
                  // Refresh sessions list so subagent appears in sidebar
                  setTimeout(() => get().loadSessions(), 500);
                }
              }
            }

            // COMPLETE TASK on lifecycle end or tool result with background process
            if (existingTask && (isLifecycleEnd || (isToolEnd && existingTask))) {
              const isError = phase === 'error' || payload?.data?.isError;

              set((state) => ({
                tasks: state.tasks.map((t: Task) =>
                  t.runId === runId
                    ? {
                      ...t,
                      status: isError ? 'error' : 'completed',
                      completedAt: Date.now(),
                      error: isError ? (payload?.data?.error || 'Error') : undefined,
                    }
                    : t
                ),
              }));
            }

            // Clear chatSending state when lifecycle ends for the selected session
            // This handles the case where the agent spawned a subagent and the parent session is still marked as sending
            if (isLifecycleEnd && selectedSessionKey) {
              const { activeRunId } = get();
              const currentActiveRunId = activeRunId.get(selectedSessionKey);

              // If this lifecycle end matches the active runId, or if it's for a subagent task that was spawned from here
              if (currentActiveRunId === runId || (isSubAgent && existingTask)) {
                clearStreamingBuffer();
                if (_transitionTimerId !== null) {
                  clearTimeout(_transitionTimerId);
                  _transitionTimerId = null;
                }
                // Single atomic update to avoid race conditions
                set((state) => {
                  // Find messages that need status updates
                  const userMessageNeedsUpdate = state.chatMessages.some(
                    m => m.runId === runId && m.role === 'user' && m.status === 'sending'
                  );
                  const nextQueuedMessage = state.chatMessages.find(
                    m => m.role === 'user' && m.status === 'queued'
                  );

                  const newChatSending = new Map(state.chatSending);
                  const newActiveRunId = new Map(state.activeRunId);

                  // Build result object - only include chatMessages if we need to modify it
                  const result: Partial<typeof state> = {
                    streamingContent: '',
                    streamingComplete: false,
                  };

                  if (nextQueuedMessage) {
                    // There's a queued message - update it to 'sending' and mark current user msg as delivered
                    result.chatMessages = state.chatMessages.map(m => {
                      if (m.id === nextQueuedMessage.id) {
                        return { ...m, status: 'sending' as const };
                      }
                      if (m.runId === runId && m.role === 'user' && m.status === 'sending') {
                        return { ...m, status: 'delivered' as const };
                      }
                      return m;
                    });
                  } else if (userMessageNeedsUpdate) {
                    // Only update the user message status, don't create a new array otherwise
                    result.chatMessages = state.chatMessages.map(m => {
                      if (m.runId === runId && m.role === 'user' && m.status === 'sending') {
                        return { ...m, status: 'delivered' as const };
                      }
                      return m;
                    });
                    // No more queued messages - clear sending state
                    newChatSending.delete(selectedSessionKey);
                    newActiveRunId.delete(selectedSessionKey);
                    result.chatSending = newChatSending;
                    result.activeRunId = newActiveRunId;
                  } else {
                    // No message updates needed - just clear sending state
                    newChatSending.delete(selectedSessionKey);
                    newActiveRunId.delete(selectedSessionKey);
                    result.chatSending = newChatSending;
                    result.activeRunId = newActiveRunId;
                  }

                  return result;
                });
              }
            }
          }
        }

        // Handle presence updates
        if (event.event === 'system-presence') {
          const payload = event.payload as any;
          if (payload?.entries) {
            set({ presence: payload.entries });
          }
        }
      },

      handleHello: (_hello) => {
        // Load initial data after connection
        get().loadAll();
      },
    }),
    {
      name: 'silos-dashboard',
      partialize: (state) => ({
        gatewayUrl: state.gatewayUrl,
        token: state.token,
        darkMode: state.darkMode,
      }),
    }
  )
);

// Initialize dark mode on load — default is always light unless user explicitly enabled dark
if (typeof window !== 'undefined') {
  const stored = localStorage.getItem('silos-dashboard');
  let isDark = false;
  if (stored) {
    try {
      const { state } = JSON.parse(stored);
      isDark = state?.darkMode === true;
    } catch {
      isDark = false;
    }
  }
  if (isDark) {
    document.documentElement.classList.add('dark');
  }
}
