import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { GatewayClient, createGatewayClient } from '../lib/gateway-client';
import { applyTheme } from '../lib/themes';
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
import { isSilentReply } from '../lib/reasoning-tags';
import {
  handleAgentDisplayEvent as _handleAgentDisplayEvent,
  handleChatEvent as _handleChatEvent,
  handleTaskTracking as _handleTaskTracking,
} from './chat-event-handlers';

// isSilentReply imported from lib/reasoning-tags

// --- Streaming: simple replace model (mirrors OpenClaw Control UI) ---
// Each chat:state='delta' carries the full accumulated text → direct replace into state.
// No intermediate buffer, no RAF batching — React already batches setState calls.

interface DashboardStore {
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
  chatSending: Map<string, boolean>; // Per-session sending state
  activeRunId: Map<string, string>; // Per-session active run ID
  runHadTools: Map<string, boolean>; // Per-session: did current run use tools?
  messageQueue: Map<string, Array<{ id: string; text: string }>>; // Per-session unsent message queue
  streamingContent: string;
  streamingRunId: string | null; // RunId associated with current streaming content
  streamingComplete: boolean;
  subagentParents: Map<string, string>; // subagentSessionKey -> parentSessionKey
  pendingSpawnParent: string | null; // Parent session for next spawned subagent
  unreadCounts: Map<string, number>; // sessionKey -> unread message count
  sessionCumulativeTokens: Map<string, { total: number; lastInput: number; lastOutput: number }>;
  rateLimitedUntil: number; // Timestamp until rate limit is active (survives component unmount)

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

  // Remove OpenClaw runtime context blocks (subagent completion events, internal task results).
  // These are prepended to user messages by the gateway and are AI-facing only.
  // Pattern: "OpenClaw runtime context (internal):" followed by everything up to the end,
  // since the entire message body IS the runtime context (no user text follows).
  text = text.replace(/OpenClaw runtime context \(internal\):[\s\S]*/g, '');

  // Remove "Untrusted context (metadata, ...)" trailing blocks
  text = text.replace(/Untrusted context \(metadata[^)]*\):[\s\S]*/g, '');


  // Remove date/time prefix like "[Wed 2026-02-25 14:30 GMT+1]" or "[2026-03-11 21:47:32 GMT+1]" that gateway adds
  text = text.replace(/^\[(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+[^\]]*\]\s*/i, '');

  return text.trim();
}

function describeBrowserAction(input: Record<string, unknown>): string {
  const action = (input?.action as string) || (input?.command as string) || 'working';
  const url = input?.url as string;
  const ref = input?.ref;
  const text = input?.text as string;

  if (action === 'navigate' && url) return `navigating to ${url}...`;
  if (action === 'click' && ref) return `clicking element ${ref}...`;
  if (action === 'type' && ref) return `typing in element ${ref}...`;
  if (action === 'snapshot') return 'reading page...';
  if (action === 'screenshot') return 'taking screenshot...';
  if (action === 'evaluate') return 'running script...';
  if (text) return `${action}: "${text.slice(0, 40)}"...`;
  return `${action}...`;
}

// Generation counter for loadChatHistory — discards stale responses from concurrent calls
let _chatHistoryGen = 0;

export const useDashboardStore = create<DashboardStore>()(
  persist(
    (set, get) => ({
      // Initial state
      _hydrated: false,
      connected: false,
      connecting: false,
      initialLoading: false,
      error: null,
      reconnectAttempt: 0,

      // Gateway URL - usar localhost explícitamente (no 127.0.0.1)
      gatewayUrl: 'http://127.0.0.1:18789',

      token: null,
      darkMode: false,
      theme: 'default',

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
      runHadTools: new Map(),
      messageQueue: new Map(),
      streamingContent: '',
      streamingRunId: null,
      streamingComplete: false,
      subagentParents: new Map(),
      pendingSpawnParent: null,
      unreadCounts: new Map(),
      sessionCumulativeTokens: (() => {
        try {
          const raw = localStorage.getItem('silos:cumTokens');
          if (raw) {
            const entries = JSON.parse(raw) as [string, { total: number; lastInput: number; lastOutput: number }][];
            return new Map(entries);
          }
        } catch { /* ignore corrupt data */ }
        return new Map();
      })(),
      rateLimitedUntil: 0,

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

      // Browser panel
      browserPanelOpen: false,
      browserDetached: 'none' as const,
      browserAgentAction: null,

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
        applyTheme(get().theme, dark);
      },
      setTheme: (themeId) => {
        set({ theme: themeId });
        applyTheme(themeId, get().darkMode);
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
          onGap: ({ expected, received }: { expected: number; received: number }) => {
            console.warn(`[gateway] Event gap: expected seq ${expected}, got ${received}`);
            const sk = get().selectedSessionKey;
            if (sk) {
              get().loadChatHistory(sk);
            }
          },
          onClose: ({ code, reason }) => {
            if (code === 1008 && reason?.includes('token mismatch')) {
              // Token mismatch: server was likely reset — clear all stale data
              const { client } = get();
              client?.stop();
              set({
                connected: false, connecting: false, token: null, client: null,
                agents: null, sessions: null, tasks: [], cronJobs: [], cronStatus: null,
                channels: null, models: null, availableModels: null, gatewayConfig: null,
                error: 'Session expired. Please sign in again.',
              });
              return;
            }
            // Service restart (e.g. config save) — reconnect silently, no error
            if (code === 1012) {
              set({ connected: false, connecting: true, error: null });
              return;
            }
            if (code !== 1000) {
              // Non-normal close: gateway client will auto-reconnect, keep connecting: true
              set({ connected: false, connecting: true, initialLoading: false, error: `Connection closed: ${reason || code}` });
            } else {
              // Normal close (user disconnected)
              set({ connected: false, connecting: false, initialLoading: false });
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
          initialLoading: false,
          error: null,
          token: null,
        });
      },

      // Data loading
      loadAgents: async () => {
        const { client } = get();
        if (!client) return;

        set({ agentsLoading: true });
        try {
          const agents = await client.listAgents();
          // Don't overwrite a populated agents list with an empty one —
          // the gateway may still be initializing after a restart.
          const current = get().agents;
          if (agents.agents.length === 0 && current?.agents && current.agents.length > 0) {
            set({ agentsLoading: false });
            return;
          }
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

          try { localStorage.setItem('silos:cumTokens', JSON.stringify([...cumTokens])); } catch { /* quota */ }
          set({ sessions: mergedSessions, sessionsLoading: false, sessionCumulativeTokens: cumTokens });
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
            contextWindow: m.contextWindow || undefined,
            maxTokens: m.contextWindow ? Math.min(m.contextWindow, 16384) : 16384,
            compat: { supportsUsageInStreaming: true },
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
        // (no buffer to cancel — streaming writes directly to state)
        // Clear potentially stale per-session state for the session we're LEAVING.
        // Completion/error events are ignored while viewing another session,
        // so chatSending/activeRunId may be stuck from a finished run.
        const newChatSending = new Map(get().chatSending);
        const newActiveRunId = new Map(get().activeRunId);
        if (selectedSessionKey) {
          newChatSending.delete(selectedSessionKey);
          newActiveRunId.delete(selectedSessionKey);
        }
        set({
          selectedSessionKey: key,
          chatMessages: [],
          chatSending: newChatSending,
          activeRunId: newActiveRunId,
          streamingContent: '',
          streamingRunId: null,
          streamingComplete: false,
        });
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
        const { client } = get();
        if (!client) return;

        try {
          await client.patchSession(key, updates);
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

        const gen = ++_chatHistoryGen;
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
          const result = await client.getChatHistory(effectiveKey, { limit: 200 });

          // Extract text from content, preserving tool_use blocks as separate messages
          const extractedToolUseMessages: ChatMessage[] = [];
          const messages: ChatMessage[] = (result.messages || []).map((m: any, i: number) => {
            let textContent: string;
            if (m.role === 'user') {
              textContent = stripInboundMeta(m.content);
            } else if (typeof m.content === 'string') {
              textContent = m.content;
            } else if (Array.isArray(m.content)) {
              // Extract text blocks
              const textParts = m.content
                .filter((item: any) => !item || typeof item === 'string' || item?.type === 'text')
                .map((item: any) => (typeof item === 'string' ? item : item?.text ?? null))
                .filter(Boolean);
              textContent = textParts.join('\n') || '';

              // Extract tool_use blocks as separate tool messages
              for (const item of m.content) {
                if (item?.type === 'tool_use' && item.name) {
                  extractedToolUseMessages.push({
                    id: item.id || `tool-${m.id || i}-${item.name}`,
                    role: 'tool',
                    content: '',
                    timestamp: m.timestamp || Date.now(),
                    toolName: item.name,
                    toolCall: item.input,
                    runId: m.runId,
                    status: 'delivered',
                  });
                }
              }
            } else {
              textContent = '';
            }

            return {
              id: m.id || `msg-${i}`,
              role: m.role || 'user',
              content: textContent,
              timestamp: m.timestamp || Date.now(),
              toolName: m.toolName,
              toolCall: m.toolCall,
              result: m.result,
              runId: m.runId,
            };
          }).filter((m) => {
            // Hide tool-result messages (gateway stores them with role='toolResult')
            if (m.role === 'toolResult') return false;
            // Hide user messages that became empty after stripping runtime context / metadata
            if (m.role === 'user' && (!m.content || !m.content.trim())) return false;
            // Hide NO_REPLY assistant messages (gateway control token for silent runs)
            if (m.role === 'assistant' && isSilentReply(m.content)) return false;
            return true;
          });
          // Guard: user may have switched sessions or another loadChatHistory call was made
          if (get().selectedSessionKey !== key || gen !== _chatHistoryGen) return;
          // Merge tool messages: gateway history doesn't return tool events, so we
          // need them from two sources:
          // 1. extractedToolUseMessages: tool_use blocks found in assistant content arrays
          // 2. existingToolMessages: tool events captured during streaming
          // Deduplicate: if a tool_use block matches a streaming tool message (same toolName
          // + runId + similar timestamp), keep only the streaming one (it has richer data).
          const existingToolMessages = get().chatMessages.filter(
            m => m.role === 'tool' || m.toolName || m.toolCall || m.result
          );

          // Build a set of (toolName, runId) pairs from existing streaming tools for dedup
          const existingToolKeys = new Set(
            existingToolMessages
              .filter(m => m.toolName && m.runId)
              .map(m => `${m.toolName}:${m.runId}`)
          );

          // Only add extracted tool_use messages that don't overlap with streaming tools
          const uniqueExtracted = extractedToolUseMessages.filter(
            m => !m.runId || !m.toolName || !existingToolKeys.has(`${m.toolName}:${m.runId}`)
          );

          const allToolMessages = [...existingToolMessages, ...uniqueExtracted];
          let merged = messages;
          if (allToolMessages.length > 0) {
            merged = [...messages, ...allToolMessages].sort(
              (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
            );
          }

          // Preserve locally queued messages — check both chatMessages (may have been cleared
          // by selectSession) AND messageQueue (always survives session switches)
          const queued = get().chatMessages.filter(m => m.status === 'queued');
          const orphanedQueue = get().messageQueue.get(key);
          if (orphanedQueue && orphanedQueue.length > 0) {
            const existingIds = new Set(queued.map(m => m.id));
            for (const q of orphanedQueue) {
              if (!existingIds.has(q.id)) {
                queued.push({
                  id: q.id,
                  role: 'user' as const,
                  content: q.text,
                  timestamp: Date.now(),
                  status: 'queued' as const,
                });
              }
            }
          }
          set({ chatMessages: queued.length > 0 ? [...merged, ...queued] : merged, chatLoading: false });
          // If there are orphaned queued messages and no active run, dispatch them
          if (queued.length > 0 && !get().activeRunId.get(key)) {
            setTimeout(() => get()._dispatchNextQueued(key), 100);
          }
        } catch (error) {
          if (get().selectedSessionKey !== key || gen !== _chatHistoryGen) return;
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
        const { client, selectedSessionKey, chatSending } = get();
        if (!client || !selectedSessionKey) return;

        // Check if we're already processing a message for this session
        const isAlreadySending = chatSending.get(selectedSessionKey) === true;

        const messageId = generateId();
        const userMessage: ChatMessage = {
          id: messageId,
          role: 'user',
          content: message,
          timestamp: Date.now(),
          status: isAlreadySending ? 'queued' : 'sending',
        };

        if (isAlreadySending) {
          // ── TRUE CLIENT-SIDE QUEUE ──
          // Don't send to gateway. Just park the message locally.
          // It will be dispatched when the current run completes.
          const newQueue = new Map(get().messageQueue);
          const sessionQueue = [...(newQueue.get(selectedSessionKey) || []), { id: messageId, text: message }];
          newQueue.set(selectedSessionKey, sessionQueue);
          set({
            chatMessages: [...get().chatMessages, userMessage],
            messageQueue: newQueue,
          });
          return;
        }

        // First message — send to gateway immediately
        const newChatSending = new Map(chatSending);
        newChatSending.set(selectedSessionKey, true);

        // (no buffer to cancel — streaming writes directly to state)
        set({
          chatMessages: [...get().chatMessages, userMessage],
          chatSending: newChatSending,
          streamingContent: '',
          streamingRunId: null,
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

          // Update message with runId
          set({
            chatMessages: get().chatMessages.map(m =>
              m.id === messageId ? { ...m, runId: result.runId } : m
            ),
          });

          const newActiveRunId = new Map(get().activeRunId);
          newActiveRunId.set(selectedSessionKey, result.runId);
          set({ activeRunId: newActiveRunId });

          // Refresh sessions list to show newly created sessions
          get().loadSessions();
        } catch (error) {
          // Mark message as error and clear sending state
          const newChatSending2 = new Map(get().chatSending);
          newChatSending2.delete(selectedSessionKey);
          set({
            chatMessages: get().chatMessages.map(m =>
              m.id === messageId ? { ...m, status: 'error' as const } : m
            ),
            chatSending: newChatSending2,
            error: String(error),
          });
        }
      },

      abortChat: async () => {
        const { client, activeRunId, selectedSessionKey, chatSending, tasks } = get();
        if (!client || !selectedSessionKey) return;

        const runId = activeRunId.get(selectedSessionKey);

        // Translate DM sessionKey to effective key
        let effectiveSessionKey = selectedSessionKey;
        if (selectedSessionKey.startsWith('dm-')) {
          const agentId = selectedSessionKey.replace(/^dm-/, '');
          effectiveSessionKey = `agent:${agentId}:dm-operator`;
        }

        try {
          // Send abort even without runId — gateway accepts sessionKey-only abort
          // to handle cases where the page was refreshed mid-run
          await client.abortChat(effectiveSessionKey, runId || undefined);

          const newActiveRunId = new Map(activeRunId);
          newActiveRunId.delete(selectedSessionKey);

          const newChatSending = new Map(chatSending);
          newChatSending.delete(selectedSessionKey);

          const newRunHadTools = new Map(get().runHadTools);
          newRunHadTools.delete(selectedSessionKey);

          // Save partial streaming content as assistant message before clearing
          // (no buffer to flush — streaming writes directly to state)
          const partialContent = get().streamingContent;
          if (partialContent && partialContent.trim()) {
            const partialMessage: ChatMessage = {
              id: generateId(),
              role: 'assistant',
              content: partialContent,
              timestamp: Date.now(),
              runId,
            };
            set((state) => ({
              chatMessages: [...state.chatMessages, partialMessage],
            }));
          }

          // Also update the task status to aborted
          // (no buffer to cancel — streaming writes directly to state)
          set({
            activeRunId: newActiveRunId,
            chatSending: newChatSending,
            runHadTools: newRunHadTools,
            tasks: tasks.map((t) =>
              (runId && t.runId === runId) ? { ...t, status: 'cancelled' as TaskStatus, completedAt: Date.now() } : t
            ),
            streamingContent: '',
            streamingRunId: null,
            streamingComplete: false,
          });

          // Dispatch next queued message — agent is now free
          setTimeout(() => get()._dispatchNextQueued(selectedSessionKey), 100);

        } catch (error) {
          console.error('[Abort] Failed:', error);
          // Still clear local state even if gateway abort fails
          const newActiveRunId = new Map(get().activeRunId);
          newActiveRunId.delete(selectedSessionKey);
          const newChatSending = new Map(get().chatSending);
          newChatSending.delete(selectedSessionKey);
          const newRunHadTools = new Map(get().runHadTools);
          newRunHadTools.delete(selectedSessionKey);

          // Save partial content before clearing
          // (no buffer to flush — streaming writes directly to state)
          const partialContent = get().streamingContent;
          if (partialContent && partialContent.trim()) {
            set((state) => ({
              chatMessages: [...state.chatMessages, {
                id: generateId(),
                role: 'assistant' as const,
                content: partialContent,
                timestamp: Date.now(),
                runId,
              }],
            }));
          }

          // (no buffer to cancel — streaming writes directly to state)
          set({
            activeRunId: newActiveRunId,
            chatSending: newChatSending,
            runHadTools: newRunHadTools,
            streamingContent: '',
            streamingRunId: null,
            streamingComplete: false,
          });
          // Still try to dispatch queued messages
          setTimeout(() => get()._dispatchNextQueued(selectedSessionKey), 100);
        }
      },

      // Internal: dispatch the next queued message for a session to the gateway
      _dispatchNextQueued: async (sessionKey: string) => {
        const { client, messageQueue } = get();
        if (!client) return;

        const queue = messageQueue.get(sessionKey);
        if (!queue || queue.length === 0) {
          // No more queued messages — fully clear sending state
          const newChatSending = new Map(get().chatSending);
          const newActiveRunId = new Map(get().activeRunId);
          newChatSending.delete(sessionKey);
          newActiveRunId.delete(sessionKey);
          set({ chatSending: newChatSending, activeRunId: newActiveRunId });
          return;
        }

        // Pop first queued message
        const next = queue[0];
        const newQueue = new Map(messageQueue);
        newQueue.set(sessionKey, queue.slice(1));

        // Transition message status: queued → sending
        // (no buffer to cancel — streaming writes directly to state)
        const newChatSending = new Map(get().chatSending);
        newChatSending.set(sessionKey, true);
        set({
          messageQueue: newQueue,
          chatMessages: get().chatMessages.map(m =>
            m.id === next.id ? { ...m, status: 'sending' as const } : m
          ),
          chatSending: newChatSending,
          streamingContent: '',
          streamingRunId: null,
          streamingComplete: false,
        });

        // Resolve effective session key
        let effectiveSessionKey = sessionKey;
        if (sessionKey.startsWith('dm-')) {
          const agentId = sessionKey.replace(/^dm-/, '');
          effectiveSessionKey = `agent:${agentId}:dm-operator`;
        }

        try {
          const result = await client.sendChat(effectiveSessionKey, next.text, {
            idempotencyKey: next.id,
          });

          set({
            chatMessages: get().chatMessages.map(m =>
              m.id === next.id ? { ...m, runId: result.runId } : m
            ),
          });

          const newActiveRunId = new Map(get().activeRunId);
          newActiveRunId.set(sessionKey, result.runId);
          set({ activeRunId: newActiveRunId });
        } catch (error) {
          // Mark this message as error and try next in queue
          set({
            chatMessages: get().chatMessages.map(m =>
              m.id === next.id ? { ...m, status: 'error' as const } : m
            ),
          });
          setTimeout(() => get()._dispatchNextQueued(sessionKey), 0);
        }
      },

      clearQueue: () => {
        const { selectedSessionKey } = get();
        const newQueue = new Map(get().messageQueue);
        if (selectedSessionKey) newQueue.delete(selectedSessionKey);
        set((state) => ({
          chatMessages: state.chatMessages.map(m =>
            m.role === 'user' && m.status === 'queued'
              ? { ...m, status: 'error' as const }
              : m
          ),
          messageQueue: newQueue,
        }));
      },

      removeLastQueued: () => {
        const { selectedSessionKey } = get();
        if (!selectedSessionKey) return;

        // Find the last queued chat message and remove it
        set((state) => {
          const messages = [...state.chatMessages];
          let lastIdx = -1;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user' && messages[i].status === 'queued') {
              lastIdx = i;
              break;
            }
          }
          if (lastIdx === -1) return state;

          const removedId = messages[lastIdx].id;
          messages.splice(lastIdx, 1);

          // Also remove from the messageQueue
          const newQueue = new Map(state.messageQueue);
          const sessionQueue = newQueue.get(selectedSessionKey);
          if (sessionQueue) {
            const filtered = sessionQueue.filter(m => m.id !== removedId);
            if (filtered.length > 0) {
              newQueue.set(selectedSessionKey, filtered);
            } else {
              newQueue.delete(selectedSessionKey);
            }
          }

          return { chatMessages: messages, messageQueue: newQueue };
        });
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
              ? { ...task, status, completedAt: status === 'succeeded' ? Date.now() : undefined }
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
              task.runId === runId ? { ...task, status: 'cancelled' as TaskStatus } : task
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
            let status: TaskStatus = 'succeeded';
            if (session.abortedLastRun) {
              status = 'cancelled';
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

      // Browser panel actions
      setBrowserPanelOpen: (open) => set({
        browserPanelOpen: open,
        ...(open === false ? { browserDetached: 'none' as const } : {}),
      }),
      setBrowserDetached: (mode) => set({ browserDetached: mode }),
      setBrowserAgentAction: (action) => set({ browserAgentAction: action }),

      // Event handlers — dispatches to focused handlers in chat-event-handlers.ts
      handleEvent: (event) => {
        const { selectedSessionKey } = get();
        const storeAccessor = { get, set };

        const currentEffectiveKey = selectedSessionKey?.startsWith('dm-')
          ? `agent:${selectedSessionKey.replace(/^dm-/, '')}:dm-operator`
          : selectedSessionKey;

        // Agent events: display (tools, errors) + task tracking
        if (event.event === 'agent') {
          const payload = event.payload as any;
          const shouldTrack = _handleAgentDisplayEvent(storeAccessor, payload, currentEffectiveKey);
          if (shouldTrack) {
            _handleTaskTracking(storeAccessor, payload, selectedSessionKey);
          }
        }

        // Chat events: streaming, completion, abort
        if (event.event === 'chat') {
          const payload = event.payload as any;
          _handleChatEvent(storeAccessor, payload, currentEffectiveKey);
        }

        // Presence updates
        if (event.event === 'system-presence') {
          const payload = event.payload as any;
          if (payload?.entries) {
            set({ presence: payload.entries });
          }
        }
      },

      handleHello: (_hello) => {
        // Reset orphaned in-flight state from before disconnect.
        // Any run's final event was lost during the disconnect window.
        // (no buffer to cancel — streaming writes directly to state)
        // Only show full-screen loading overlay on first connection (no data yet).
        // On reconnects, data is already in the store — just refresh silently.
        const isFirstLoad = !get().agents && !get().sessions;
        set({
          chatSending: new Map(),
          activeRunId: new Map(),
          runHadTools: new Map(),
          streamingContent: '',
          streamingRunId: null,
          streamingComplete: false,
          initialLoading: isFirstLoad,
        });

        // Load initial data after connection.
        // The gateway may still be initializing (providers/models can take >60s on cold start).
        // If models or gateway config come back empty, keep retrying every 5s until data arrives
        // or the connection drops. Max 12 retries (~60s).
        const retryLoadIfEmpty = (attemptsLeft: number) => {
          if (attemptsLeft <= 0 || !get().connected) return;
          setTimeout(() => {
            if (!get().connected) return;
            get().loadAll().then(() => {
              const { models, gatewayConfig } = get();
              const hasModels = models?.models && models.models.length > 0;
              const cfg = gatewayConfig?.config as Record<string, unknown> | undefined;
              const providers = (cfg?.models as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
              const hasProviders = providers && Object.keys(providers).length > 0;
              if (!hasModels || !hasProviders) {
                retryLoadIfEmpty(attemptsLeft - 1);
              }
            }).catch(() => {});
          }, 5000);
        };

        get().loadAll().then(() => {
          set({ initialLoading: false });
          // Reload chat history for the current session (recover messages lost during disconnect)
          const sk = get().selectedSessionKey;
          if (sk) {
            get().loadChatHistory(sk);
          }
          const { agents, models, gatewayConfig } = get();
          const hasAgents = agents?.agents && agents.agents.length > 0;
          const hasModels = models?.models && models.models.length > 0;
          const cfg = gatewayConfig?.config as Record<string, unknown> | undefined;
          const providers = (cfg?.models as Record<string, unknown>)?.providers as Record<string, unknown> | undefined;
          const hasProviders = providers && Object.keys(providers).length > 0;
          if (!hasAgents || !hasModels || !hasProviders) {
            retryLoadIfEmpty(12);
          }
        }).catch(() => {
          set({ initialLoading: false });
        });
      },
    }),
    {
      name: 'silos-dashboard',
      partialize: (state) => ({
        gatewayUrl: state.gatewayUrl,
        token: state.token,
        darkMode: state.darkMode,
        theme: state.theme,
      }),
      onRehydrateStorage: () => () => {
        useDashboardStore.setState({ _hydrated: true });
      },
    }
  )
);

// Initialize dark mode and theme on load
if (typeof window !== 'undefined') {
  const stored = localStorage.getItem('silos-dashboard');
  let isDark = false;
  let themeId = 'default';
  if (stored) {
    try {
      const { state } = JSON.parse(stored);
      isDark = state?.darkMode === true;
      themeId = state?.theme || 'default';
    } catch {
      isDark = false;
    }
  }
  if (isDark) {
    document.documentElement.classList.add('dark');
  }
  if (themeId !== 'default') {
    applyTheme(themeId, isDark);
  }
}
