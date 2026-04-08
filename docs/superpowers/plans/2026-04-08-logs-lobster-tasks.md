# Logs Viewer + Lobster Workflows + Tasks/Flows UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reactive Logs Viewer page, an ambitious Lobster Workflows page with pipeline visualization, and upgrade the existing Tasks/Flows page with exceptional UX.

**Architecture:** Three independent feature surfaces sharing common patterns: visibility-aware polling hooks, Tailwind+Lucide UI, Express API routes proxying OpenClaw CLI/gateway. Lobster files are scanned server-side from agent workspaces and parsed with js-yaml. Logs use the gateway's `logs.tail` RPC via WebSocket. Tasks/Flows get auto-refresh and a flow timeline waterfall.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 3, Zustand 5, Lucide React, React Router 7, Express 5, js-yaml (new dep), existing gateway WebSocket RPC client.

**Note:** This codebase has no test framework configured. Steps focus on implementation and manual verification.

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/types/logs.ts` | LogTailResult, ParsedLogLine types |
| `src/types/lobster.ts` | LobsterWorkflow, LobsterStep, LobsterFile types |
| `src/lib/lobster-api.ts` | HTTP fetch wrappers for `/api/lobster/*` |
| `src/hooks/useLogTail.ts` | Visibility-aware log polling with cursor tracking |
| `src/hooks/useAutoRefresh.ts` | Generic visibility-aware polling hook |
| `src/components/logs/LogViewer.tsx` | Core log display with auto-scroll |
| `src/components/logs/LogLine.tsx` | Single log line with level coloring |
| `src/components/logs/LogFilterBar.tsx` | Level filter + text search |
| `src/components/views/LogsPage.tsx` | Logs page shell |
| `src/components/lobster/WorkflowCard.tsx` | Gallery card for a workflow |
| `src/components/lobster/StepNode.tsx` | Pipeline step node |
| `src/components/lobster/PipelineVisualizer.tsx` | Vertical connected-node pipeline |
| `src/components/lobster/YamlViewer.tsx` | Syntax-highlighted YAML |
| `src/components/lobster/WorkflowDetail.tsx` | Split view: pipeline + YAML |
| `src/components/views/WorkflowsPage.tsx` | Workflows page shell |
| `src/components/tasks/FlowTimeline.tsx` | Horizontal waterfall for flow tasks |
| `server/routes/lobster.js` | Express routes for `.lobster` file scanning |

### Modified Files
| File | Changes |
|------|---------|
| `src/lib/gateway-client.ts:401` | Add `tailLogs()` method |
| `src/components/layout/AppSidebar.tsx:329-349` | Add Logs + Workflows nav items |
| `src/App.tsx:19,264` | Import + add `/logs` and `/workflows` routes |
| `server.js:12,90` | Import + register lobster router |
| `src/components/views/TasksFlowsPage.tsx` | Add auto-refresh, search bar, enhanced UX |
| `src/components/tasks/TaskRunCard.tsx` | Add pulse animation, progress preview |
| `src/components/tasks/TaskFlowDetail.tsx` | Add FlowTimeline waterfall |
| `package.json` | Add `js-yaml` dependency |

---

## Task 1: Foundation — Types, Gateway Client, Dependencies

**Files:**
- Create: `src/types/logs.ts`
- Create: `src/types/lobster.ts`
- Modify: `src/lib/gateway-client.ts:401`
- Modify: `package.json`

- [ ] **Step 1: Install js-yaml**

```bash
cd /home/ubuntu/silos && npm install js-yaml && npm install -D @types/js-yaml
```

- [ ] **Step 2: Create log types**

Create `src/types/logs.ts`:

```typescript
export interface LogTailResult {
  file: string;
  cursor: number;
  size: number;
  lines: string[];
  truncated?: boolean;
  reset?: boolean;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface ParsedLogLine {
  timestamp: string;
  level: LogLevel;
  subsystem: string;
  message: string;
  raw: string;
}

export const logLevelConfig: Record<LogLevel, { label: string; color: string; bg: string }> = {
  error: { label: 'ERROR', color: 'text-red-400',    bg: 'bg-red-500/10' },
  warn:  { label: 'WARN',  color: 'text-amber-400',  bg: 'bg-amber-500/10' },
  info:  { label: 'INFO',  color: 'text-cyan-400',   bg: 'bg-cyan-500/10' },
  debug: { label: 'DEBUG', color: 'text-gray-500',   bg: 'bg-gray-500/10' },
  trace: { label: 'TRACE', color: 'text-gray-600',   bg: 'bg-gray-600/10' },
};

export function parseLogLine(raw: string): ParsedLogLine {
  try {
    const obj = JSON.parse(raw);
    return {
      timestamp: obj.time || obj.timestamp || obj.ts || '',
      level: normalizeLevel(obj.level || obj.lvl || 'info'),
      subsystem: obj.subsystem || obj.component || obj.name || '',
      message: obj.msg || obj.message || raw,
      raw,
    };
  } catch {
    // Fallback for non-JSON lines
    const levelMatch = raw.match(/\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/i);
    return {
      timestamp: '',
      level: levelMatch ? normalizeLevel(levelMatch[1]) : 'info',
      subsystem: '',
      message: raw,
      raw,
    };
  }
}

function normalizeLevel(level: string): LogLevel {
  const l = level.toLowerCase();
  if (l === 'error' || l === 'err') return 'error';
  if (l === 'warn' || l === 'warning') return 'warn';
  if (l === 'debug' || l === 'dbg') return 'debug';
  if (l === 'trace') return 'trace';
  return 'info';
}
```

- [ ] **Step 3: Create lobster types**

Create `src/types/lobster.ts`:

```typescript
export type LobsterStepType = 'exec' | 'approve' | 'llm-task' | 'invoke' | 'unknown';

export interface LobsterStep {
  id: string;
  command: string;
  stdin?: string;
  condition?: string;
  approval?: string;
  env?: Record<string, string>;
  type: LobsterStepType;
}

export interface LobsterWorkflow {
  agentId: string;
  filename: string;
  name: string;
  args?: Record<string, { default?: string; description?: string }>;
  steps: LobsterStep[];
  raw: string;
}

export interface LobsterFileEntry {
  agentId: string;
  agentName?: string;
  filename: string;
  name: string;
  stepCount: number;
  hasApproval: boolean;
  hasLlmTask: boolean;
}

export function inferStepType(command: string, approval?: string): LobsterStepType {
  if (approval === 'required' || approval === 'optional') return 'approve';
  if (command.includes('llm-task')) return 'llm-task';
  if (command.includes('openclaw.invoke')) return 'invoke';
  if (command.startsWith('approve')) return 'approve';
  return 'exec';
}
```

- [ ] **Step 4: Add tailLogs to gateway client**

In `src/lib/gateway-client.ts`, add before the closing `}` of the class (before line 405):

```typescript
  // Logs
  async tailLogs(params?: { cursor?: number; limit?: number; maxBytes?: number }) {
    return this.request<import('../types/logs').LogTailResult>('logs.tail', params);
  }
```

- [ ] **Step 5: Commit**

```bash
git add src/types/logs.ts src/types/lobster.ts src/lib/gateway-client.ts package.json package-lock.json
git commit -m "feat: add types for logs and lobster, add tailLogs gateway method"
```

---

## Task 2: Server Routes — Lobster File Scanner

**Files:**
- Create: `server/routes/lobster.js`
- Modify: `server.js:12,90`

- [ ] **Step 1: Create lobster router**

Create `server/routes/lobster.js`:

```javascript
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';

export function createLobsterRouter(openclawBase, authMiddleware) {
  const router = Router();

  // Derive the agents directory from openclaw base
  // Agents live in <openclawBase>/agents/<agentId>/
  const agentsDir = path.join(openclawBase, 'agents');

  async function findLobsterFiles() {
    const results = [];
    try {
      const agentDirs = await fs.readdir(agentsDir);
      for (const agentId of agentDirs) {
        const agentPath = path.join(agentsDir, agentId);
        const stat = await fs.stat(agentPath).catch(() => null);
        if (!stat?.isDirectory()) continue;

        // Scan agent dir and workspace for .lobster files
        const dirsToScan = [agentPath];
        const workspacePath = path.join(agentPath, 'workspace');
        const wsStat = await fs.stat(workspacePath).catch(() => null);
        if (wsStat?.isDirectory()) dirsToScan.push(workspacePath);

        for (const dir of dirsToScan) {
          try {
            const files = await fs.readdir(dir);
            for (const file of files) {
              if (!file.endsWith('.lobster')) continue;
              const filePath = path.join(dir, file);
              try {
                const content = await fs.readFile(filePath, 'utf8');
                const parsed = yaml.load(content) || {};
                const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
                results.push({
                  agentId,
                  filename: file,
                  name: parsed.name || file.replace('.lobster', ''),
                  stepCount: steps.length,
                  hasApproval: steps.some(s => s.approval === 'required' || s.approval === 'optional'),
                  hasLlmTask: steps.some(s => (s.command || '').includes('llm-task')),
                });
              } catch { /* skip unparseable files */ }
            }
          } catch { /* skip unreadable dirs */ }
        }
      }
    } catch { /* agents dir may not exist */ }
    return results;
  }

  // GET /api/lobster/files — list all .lobster files across agents
  router.get('/api/lobster/files', authMiddleware, async (_req, res) => {
    try {
      const files = await findLobsterFiles();
      res.json({ files });
    } catch (err) {
      console.error('[Lobster] Error scanning files:', err.message);
      res.status(500).json({ error: 'Failed to scan lobster files' });
    }
  });

  // GET /api/lobster/files/:agentId/:filename — read a specific .lobster file
  router.get('/api/lobster/files/:agentId/:filename', authMiddleware, async (req, res) => {
    const { agentId, filename } = req.params;
    // Prevent path traversal
    if (agentId.includes('..') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!filename.endsWith('.lobster')) {
      return res.status(400).json({ error: 'Not a .lobster file' });
    }

    const possiblePaths = [
      path.join(agentsDir, agentId, filename),
      path.join(agentsDir, agentId, 'workspace', filename),
    ];

    for (const filePath of possiblePaths) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = yaml.load(content) || {};
        const steps = (Array.isArray(parsed.steps) ? parsed.steps : []).map((s, i) => ({
          id: s.id || `step-${i}`,
          command: s.command || '',
          stdin: s.stdin || undefined,
          condition: s.condition || undefined,
          approval: s.approval || undefined,
          env: s.env || undefined,
        }));
        return res.json({
          agentId,
          filename,
          name: parsed.name || filename.replace('.lobster', ''),
          args: parsed.args || undefined,
          steps,
          raw: content,
        });
      } catch { /* try next path */ }
    }

    res.status(404).json({ error: 'File not found' });
  });

  return router;
}
```

- [ ] **Step 2: Register lobster router in server.js**

In `server.js`, add after line 12 (the tasks import):

```javascript
import { createLobsterRouter } from './server/routes/lobster.js';
```

In `server.js`, add after line 90 (the tasks router registration):

```javascript
app.use(createLobsterRouter(OPENCLAW_BASE, authMiddleware));
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/lobster.js server.js
git commit -m "feat: add server routes for lobster workflow file scanning"
```

---

## Task 3: API Helpers — Lobster

**Files:**
- Create: `src/lib/lobster-api.ts`

- [ ] **Step 1: Create lobster API helper**

Create `src/lib/lobster-api.ts`:

```typescript
import type { LobsterFileEntry, LobsterWorkflow, LobsterStep } from '../types/lobster';
import { inferStepType } from '../types/lobster';
import { useDashboardStore } from '../store/dashboard-store';

const API_BASE = '/api';

function getAuthHeaders(): Record<string, string> {
  const token = useDashboardStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchLobsterFiles(): Promise<LobsterFileEntry[]> {
  const data = await fetchJson<{ files: LobsterFileEntry[] }>(`${API_BASE}/lobster/files`);
  return data.files || [];
}

export async function fetchLobsterWorkflow(agentId: string, filename: string): Promise<LobsterWorkflow | null> {
  try {
    const data = await fetchJson<{
      agentId: string; filename: string; name: string;
      args?: Record<string, { default?: string; description?: string }>;
      steps: Array<{ id: string; command: string; stdin?: string; condition?: string; approval?: string; env?: Record<string, string> }>;
      raw: string;
    }>(`${API_BASE}/lobster/files/${encodeURIComponent(agentId)}/${encodeURIComponent(filename)}`);

    const steps: LobsterStep[] = data.steps.map(s => ({
      ...s,
      type: inferStepType(s.command, s.approval),
    }));

    return { ...data, steps };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/lobster-api.ts
git commit -m "feat: add lobster API helper"
```

---

## Task 4: Hooks — useLogTail & useAutoRefresh

**Files:**
- Create: `src/hooks/useLogTail.ts`
- Create: `src/hooks/useAutoRefresh.ts`

- [ ] **Step 1: Create useAutoRefresh hook**

Create `src/hooks/useAutoRefresh.ts`:

```typescript
import { useEffect, useRef, useCallback } from 'react';

/**
 * Visibility-aware polling hook. Calls `callback` every `intervalMs`
 * only when the document is visible AND `enabled` is true.
 * Pauses when tab is hidden, resumes on focus.
 */
export function useAutoRefresh(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled: boolean,
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const tick = useCallback(() => {
    if (document.visibilityState === 'visible') {
      callbackRef.current();
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const id = setInterval(tick, intervalMs);

    // Also fire on tab becoming visible after being hidden
    const onVisChange = () => {
      if (document.visibilityState === 'visible') {
        callbackRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVisChange);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [tick, intervalMs, enabled]);
}
```

- [ ] **Step 2: Create useLogTail hook**

Create `src/hooks/useLogTail.ts`:

```typescript
import { useState, useRef, useCallback, useEffect } from 'react';
import { getGatewayClient } from '../lib/gateway-client';
import type { ParsedLogLine, LogLevel } from '../types/logs';
import { parseLogLine } from '../types/logs';

const POLL_INTERVAL = 1500;
const MAX_LINES = 2000;

interface UseLogTailOptions {
  levelFilter?: LogLevel[];
  searchText?: string;
}

export function useLogTail(options: UseLogTailOptions = {}) {
  const [lines, setLines] = useState<ParsedLogLine[]>([]);
  const [file, setFile] = useState<string>('');
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const cursorRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;

    const client = getGatewayClient();
    if (!client?.connected) {
      setConnected(false);
      return;
    }

    try {
      const result = await client.tailLogs({
        cursor: cursorRef.current,
        limit: 500,
      });

      setConnected(true);
      if (result.file) setFile(result.file);

      // Handle log rotation
      if (result.reset) {
        cursorRef.current = 0;
        setLines([]);
      }

      if (result.lines.length > 0) {
        cursorRef.current = result.cursor;
        const parsed = result.lines.map(parseLogLine);
        setLines(prev => {
          const combined = [...prev, ...parsed];
          return combined.length > MAX_LINES
            ? combined.slice(combined.length - MAX_LINES)
            : combined;
        });
      }
    } catch {
      setConnected(false);
    }
  }, []);

  // Start/stop polling
  useEffect(() => {
    if (paused) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }

    // Initial fetch
    poll();

    timerRef.current = setInterval(poll, POLL_INTERVAL);

    const onVisChange = () => {
      if (document.visibilityState === 'visible' && !paused) {
        poll();
      }
    };
    document.addEventListener('visibilitychange', onVisChange);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [poll, paused]);

  // Apply client-side filtering
  const filteredLines = lines.filter(line => {
    if (options.levelFilter && options.levelFilter.length > 0 && !options.levelFilter.includes(line.level)) {
      return false;
    }
    if (options.searchText) {
      const search = options.searchText.toLowerCase();
      return line.message.toLowerCase().includes(search) ||
             line.subsystem.toLowerCase().includes(search) ||
             line.raw.toLowerCase().includes(search);
    }
    return true;
  });

  const clear = useCallback(() => {
    setLines([]);
    cursorRef.current = 0;
  }, []);

  return {
    lines: filteredLines,
    allLines: lines,
    file,
    connected,
    paused,
    setPaused,
    clear,
    totalCount: lines.length,
    filteredCount: filteredLines.length,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useLogTail.ts src/hooks/useAutoRefresh.ts
git commit -m "feat: add useLogTail and useAutoRefresh hooks"
```

---

## Task 5: Logs Page

**Files:**
- Create: `src/components/logs/LogLine.tsx`
- Create: `src/components/logs/LogFilterBar.tsx`
- Create: `src/components/logs/LogViewer.tsx`
- Create: `src/components/views/LogsPage.tsx`

- [ ] **Step 1: Create LogLine component**

Create `src/components/logs/LogLine.tsx`:

```tsx
import { logLevelConfig } from '../../types/logs';
import type { ParsedLogLine } from '../../types/logs';

interface LogLineProps {
  line: ParsedLogLine;
  showTimestamp: boolean;
}

export function LogLine({ line, showTimestamp }: LogLineProps) {
  const level = logLevelConfig[line.level] || logLevelConfig.info;

  // Format timestamp for display
  const ts = line.timestamp
    ? new Date(line.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
    : '';

  return (
    <div className="flex items-start gap-2 px-3 py-0.5 hover:bg-white/[0.02] font-mono text-[11px] leading-relaxed group">
      {showTimestamp && ts && (
        <span className="text-gray-600 shrink-0 select-none tabular-nums w-24">{ts}</span>
      )}
      <span className={`${level.color} shrink-0 w-12 text-right font-semibold select-none`}>
        {level.label}
      </span>
      {line.subsystem && (
        <span className="text-violet-400/70 shrink-0 max-w-28 truncate select-none">[{line.subsystem}]</span>
      )}
      <span className="text-gray-300 break-all flex-1 whitespace-pre-wrap">{line.message}</span>
    </div>
  );
}
```

- [ ] **Step 2: Create LogFilterBar component**

Create `src/components/logs/LogFilterBar.tsx`:

```tsx
import { Search, Filter } from 'lucide-react';
import type { LogLevel } from '../../types/logs';

const levels: { key: LogLevel; label: string; color: string }[] = [
  { key: 'error', label: 'Error', color: 'bg-red-500' },
  { key: 'warn',  label: 'Warn',  color: 'bg-amber-500' },
  { key: 'info',  label: 'Info',  color: 'bg-cyan-500' },
  { key: 'debug', label: 'Debug', color: 'bg-gray-500' },
  { key: 'trace', label: 'Trace', color: 'bg-gray-600' },
];

interface LogFilterBarProps {
  activeLevels: LogLevel[];
  onToggleLevel: (level: LogLevel) => void;
  searchText: string;
  onSearchChange: (text: string) => void;
}

export function LogFilterBar({ activeLevels, onToggleLevel, searchText, onSearchChange }: LogFilterBarProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      {/* Level toggles */}
      <div className="flex items-center gap-1">
        <Filter className="w-3.5 h-3.5 text-gray-500 mr-1" />
        {levels.map(l => {
          const active = activeLevels.includes(l.key);
          return (
            <button
              key={l.key}
              onClick={() => onToggleLevel(l.key)}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-all ${
                active
                  ? `${l.color} text-white`
                  : 'bg-gray-800 text-gray-500 hover:text-gray-400'
              }`}
            >
              {l.label}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="flex-1 relative max-w-xs ml-auto">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
        <input
          type="text"
          value={searchText}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Filter logs..."
          className="w-full pl-8 pr-3 py-1 bg-gray-800/50 border border-gray-700/50 rounded-md text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-gray-600"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create LogViewer component**

Create `src/components/logs/LogViewer.tsx`:

```tsx
import { useRef, useEffect, useState, useCallback } from 'react';
import { ArrowDown } from 'lucide-react';
import { LogLine } from './LogLine';
import type { ParsedLogLine } from '../../types/logs';

interface LogViewerProps {
  lines: ParsedLogLine[];
  showTimestamps?: boolean;
}

export function LogViewer({ lines, showTimestamps = true }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevLengthRef = useRef(0);

  // Auto-scroll when new lines arrive
  useEffect(() => {
    if (autoScroll && containerRef.current && lines.length > prevLengthRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    prevLengthRef.current = lines.length;
  }, [lines.length, autoScroll]);

  // Detect manual scroll
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
    setShowScrollBtn(!atBottom);
  }, []);

  const jumpToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setAutoScroll(true);
      setShowScrollBtn(false);
    }
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto bg-[#0d1117]"
      >
        {lines.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-600 text-sm font-mono">Waiting for logs...</p>
          </div>
        ) : (
          <div className="py-2">
            {lines.map((line, i) => (
              <LogLine key={i} line={line} showTimestamp={showTimestamps} />
            ))}
          </div>
        )}
      </div>

      {/* Jump to bottom FAB */}
      {showScrollBtn && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 right-4 p-2 bg-gray-800 border border-gray-600 rounded-full shadow-lg hover:bg-gray-700 transition-colors"
        >
          <ArrowDown className="w-4 h-4 text-gray-300" />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create LogsPage**

Create `src/components/views/LogsPage.tsx`:

```tsx
import { useState, useCallback } from 'react';
import { ScrollText, Pause, Play, Trash2, FileText } from 'lucide-react';
import { useLogTail } from '../../hooks/useLogTail';
import { LogViewer } from '../logs/LogViewer';
import { LogFilterBar } from '../logs/LogFilterBar';
import type { LogLevel } from '../../types/logs';

export function LogsPage() {
  const [activeLevels, setActiveLevels] = useState<LogLevel[]>([
    'error', 'warn', 'info', 'debug',
  ]);
  const [searchText, setSearchText] = useState('');

  const { lines, file, connected, paused, setPaused, clear, totalCount, filteredCount } = useLogTail({
    levelFilter: activeLevels,
    searchText,
  });

  const handleToggleLevel = useCallback((level: LogLevel) => {
    setActiveLevels(prev =>
      prev.includes(level) ? prev.filter(l => l !== level) : [...prev, level]
    );
  }, []);

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <ScrollText className="w-4 h-4 text-cyan-400" />
          <h1 className="text-sm font-semibold text-gray-200">Gateway Logs</h1>
          <div className="flex items-center gap-1.5 ml-2">
            <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-600'}`} />
            <span className="text-[10px] text-gray-500">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Stats */}
          <span className="text-[10px] text-gray-600 tabular-nums">
            {filteredCount !== totalCount ? `${filteredCount}/` : ''}{totalCount} lines
          </span>

          {/* File path */}
          {file && (
            <span className="text-[10px] text-gray-700 font-mono max-w-48 truncate flex items-center gap-1" title={file}>
              <FileText className="w-3 h-3" />{file.split('/').pop()}
            </span>
          )}

          {/* Pause/Resume */}
          <button
            onClick={() => setPaused(!paused)}
            className={`p-1.5 rounded-md text-xs transition-colors ${
              paused
                ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
            }`}
            title={paused ? 'Resume' : 'Pause'}
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>

          {/* Clear */}
          <button
            onClick={clear}
            className="p-1.5 rounded-md text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
            title="Clear"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <LogFilterBar
        activeLevels={activeLevels}
        onToggleLevel={handleToggleLevel}
        searchText={searchText}
        onSearchChange={setSearchText}
      />

      {/* Log viewer */}
      <LogViewer lines={lines} />
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/logs/ src/components/views/LogsPage.tsx
git commit -m "feat: add logs viewer page with reactive polling and filtering"
```

---

## Task 6: Lobster Workflows Page

**Files:**
- Create: `src/components/lobster/StepNode.tsx`
- Create: `src/components/lobster/PipelineVisualizer.tsx`
- Create: `src/components/lobster/YamlViewer.tsx`
- Create: `src/components/lobster/WorkflowCard.tsx`
- Create: `src/components/lobster/WorkflowDetail.tsx`
- Create: `src/components/views/WorkflowsPage.tsx`

- [ ] **Step 1: Create StepNode component**

Create `src/components/lobster/StepNode.tsx`:

```tsx
import { Terminal, ShieldCheck, Brain, Plug, ArrowDown, Diamond } from 'lucide-react';
import type { LobsterStep } from '../../types/lobster';

interface StepNodeProps {
  step: LobsterStep;
  index: number;
  isLast: boolean;
}

const typeConfig = {
  exec:       { icon: Terminal,     color: 'border-emerald-500/40 bg-emerald-500/5', accent: 'text-emerald-400', label: 'exec' },
  approve:    { icon: ShieldCheck,  color: 'border-amber-500/40 bg-amber-500/5',    accent: 'text-amber-400',   label: 'approval' },
  'llm-task': { icon: Brain,        color: 'border-violet-500/40 bg-violet-500/5',  accent: 'text-violet-400',  label: 'llm-task' },
  invoke:     { icon: Plug,         color: 'border-blue-500/40 bg-blue-500/5',      accent: 'text-blue-400',    label: 'invoke' },
  unknown:    { icon: Terminal,     color: 'border-gray-500/40 bg-gray-500/5',      accent: 'text-gray-400',    label: 'step' },
};

export function StepNode({ step, index, isLast }: StepNodeProps) {
  const config = typeConfig[step.type] || typeConfig.unknown;
  const Icon = config.icon;

  return (
    <div className="flex flex-col items-center">
      {/* Condition gate */}
      {step.condition && (
        <div className="flex items-center gap-2 mb-2 px-3 py-1 bg-amber-500/10 border border-amber-500/20 rounded-md">
          <Diamond className="w-3 h-3 text-amber-400" />
          <span className="text-[10px] text-amber-400 font-mono">{step.condition}</span>
        </div>
      )}

      {/* Data flow label */}
      {step.stdin && (
        <div className="mb-1">
          <span className="text-[9px] text-gray-500 font-mono bg-gray-800/60 px-2 py-0.5 rounded">
            stdin: {step.stdin}
          </span>
        </div>
      )}

      {/* Step card */}
      <div className={`w-full max-w-sm border rounded-lg p-3 transition-all hover:shadow-md hover:shadow-black/20 ${config.color}`}>
        <div className="flex items-center gap-2.5">
          <div className={`p-1.5 rounded-md bg-black/20 ${config.accent}`}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 font-mono">#{index + 1}</span>
              <span className={`text-xs font-semibold ${config.accent}`}>{step.id}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-black/20 text-gray-500 font-mono">{config.label}</span>
            </div>
            <p className="text-[11px] text-gray-400 font-mono mt-1 truncate" title={step.command}>
              {step.command}
            </p>
          </div>
        </div>

        {step.approval && (
          <div className="mt-2 flex items-center gap-1.5 text-amber-400">
            <ShieldCheck className="w-3 h-3" />
            <span className="text-[10px] font-medium">Approval {step.approval}</span>
          </div>
        )}
      </div>

      {/* Connector arrow */}
      {!isLast && (
        <div className="flex flex-col items-center py-1.5 text-gray-700">
          <div className="w-px h-3 bg-gray-700" />
          <ArrowDown className="w-3 h-3" />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create PipelineVisualizer component**

Create `src/components/lobster/PipelineVisualizer.tsx`:

```tsx
import { Settings2 } from 'lucide-react';
import type { LobsterStep } from '../../types/lobster';
import { StepNode } from './StepNode';

interface PipelineVisualizerProps {
  steps: LobsterStep[];
  args?: Record<string, { default?: string; description?: string }>;
}

export function PipelineVisualizer({ steps, args }: PipelineVisualizerProps) {
  return (
    <div className="p-6">
      {/* Args section */}
      {args && Object.keys(args).length > 0 && (
        <div className="mb-6 p-3 bg-gray-800/40 border border-gray-700/50 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Settings2 className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-xs font-semibold text-gray-400">Arguments</span>
          </div>
          <div className="space-y-1">
            {Object.entries(args).map(([key, val]) => (
              <div key={key} className="flex items-center gap-2 text-[11px]">
                <span className="text-cyan-400 font-mono">{key}</span>
                {val.default && (
                  <span className="text-gray-600">= <span className="text-gray-500">{val.default}</span></span>
                )}
                {val.description && (
                  <span className="text-gray-600 ml-1">— {val.description}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Steps */}
      <div className="flex flex-col items-center space-y-0">
        {steps.map((step, i) => (
          <StepNode key={step.id} step={step} index={i} isLast={i === steps.length - 1} />
        ))}
      </div>

      {steps.length === 0 && (
        <p className="text-center text-gray-600 text-sm py-8">No steps defined</p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create YamlViewer component**

Create `src/components/lobster/YamlViewer.tsx`:

```tsx
interface YamlViewerProps {
  content: string;
}

function highlightYaml(raw: string): JSX.Element[] {
  return raw.split('\n').map((line, i) => {
    let html = line;
    // Comments
    if (line.trimStart().startsWith('#')) {
      return <span key={i} className="text-gray-600">{line}</span>;
    }
    // Key: value
    const keyMatch = line.match(/^(\s*)([\w.-]+)(\s*:)(.*)/);
    if (keyMatch) {
      const [, indent, key, colon, rest] = keyMatch;
      return (
        <span key={i}>
          {indent}<span className="text-cyan-400">{key}</span><span className="text-gray-500">{colon}</span>
          <span className="text-amber-300">{rest}</span>
        </span>
      );
    }
    // List items
    if (line.trimStart().startsWith('- ')) {
      const idx = line.indexOf('- ');
      return (
        <span key={i}>
          {line.slice(0, idx)}<span className="text-gray-500">- </span>
          <span className="text-gray-300">{line.slice(idx + 2)}</span>
        </span>
      );
    }
    return <span key={i} className="text-gray-300">{html}</span>;
  });
}

export function YamlViewer({ content }: YamlViewerProps) {
  const lines = highlightYaml(content);

  return (
    <div className="h-full overflow-auto bg-[#0d1117] p-4">
      <pre className="font-mono text-[11px] leading-relaxed">
        {lines.map((line, i) => (
          <div key={i} className="flex hover:bg-white/[0.02]">
            <span className="text-gray-700 select-none w-8 text-right pr-3 shrink-0 tabular-nums">{i + 1}</span>
            {line}
          </div>
        ))}
      </pre>
    </div>
  );
}
```

- [ ] **Step 4: Create WorkflowCard component**

Create `src/components/lobster/WorkflowCard.tsx`:

```tsx
import { Terminal, ShieldCheck, Brain, Layers, Bot } from 'lucide-react';
import type { LobsterFileEntry } from '../../types/lobster';

interface WorkflowCardProps {
  workflow: LobsterFileEntry;
  onClick: () => void;
}

export function WorkflowCard({ workflow, onClick }: WorkflowCardProps) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left p-4 rounded-xl border border-border bg-card hover:bg-muted/30 hover:border-primary/30 transition-all group"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-gradient-to-br from-orange-500/20 to-amber-500/20 border border-orange-500/20 group-hover:from-orange-500/30 group-hover:to-amber-500/30 transition-all">
          <Layers className="w-5 h-5 text-orange-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{workflow.name}</h3>
          <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{workflow.filename}</p>
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 mt-3">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Terminal className="w-3 h-3" />
          <span>{workflow.stepCount} steps</span>
        </div>
        {workflow.hasApproval && (
          <div className="flex items-center gap-1 text-[10px] text-amber-500">
            <ShieldCheck className="w-3 h-3" />
            <span>Approval</span>
          </div>
        )}
        {workflow.hasLlmTask && (
          <div className="flex items-center gap-1 text-[10px] text-violet-500">
            <Brain className="w-3 h-3" />
            <span>LLM</span>
          </div>
        )}
      </div>

      {/* Agent badge */}
      <div className="flex items-center gap-1.5 mt-3 text-[10px] text-muted-foreground">
        <Bot className="w-3 h-3" />
        <span className="font-mono">{workflow.agentId}</span>
      </div>
    </button>
  );
}
```

- [ ] **Step 5: Create WorkflowDetail component**

Create `src/components/lobster/WorkflowDetail.tsx`:

```tsx
import { ArrowLeft, Play, Terminal, ShieldCheck, Brain, Settings2 } from 'lucide-react';
import type { LobsterWorkflow } from '../../types/lobster';
import { PipelineVisualizer } from './PipelineVisualizer';
import { YamlViewer } from './YamlViewer';
import { useNavigate } from 'react-router-dom';

interface WorkflowDetailProps {
  workflow: LobsterWorkflow;
  onBack: () => void;
}

export function WorkflowDetail({ workflow, onBack }: WorkflowDetailProps) {
  const navigate = useNavigate();

  const handleRun = () => {
    // Navigate to agent chat with pre-filled context
    const sessionKey = `agent:${workflow.agentId}:main`;
    navigate(`/session/${sessionKey}?prompt=${encodeURIComponent(`Run the lobster workflow: ${workflow.name}`)}`);
  };

  const approvalCount = workflow.steps.filter(s => s.type === 'approve').length;
  const llmCount = workflow.steps.filter(s => s.type === 'llm-task').length;
  const execCount = workflow.steps.filter(s => s.type === 'exec').length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border shrink-0">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-foreground truncate">{workflow.name}</h2>
          <p className="text-[10px] text-muted-foreground font-mono">{workflow.agentId}/{workflow.filename}</p>
        </div>

        {/* Stats chips */}
        <div className="flex items-center gap-2 text-[10px]">
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500">
            <Terminal className="w-3 h-3" />{execCount}
          </span>
          {approvalCount > 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500">
              <ShieldCheck className="w-3 h-3" />{approvalCount}
            </span>
          )}
          {llmCount > 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-500">
              <Brain className="w-3 h-3" />{llmCount}
            </span>
          )}
        </div>

        <button
          onClick={handleRun}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          <Play className="w-3.5 h-3.5" />
          Run
        </button>
      </div>

      {/* Args summary if any */}
      {workflow.args && Object.keys(workflow.args).length > 0 && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-border bg-muted/20">
          <Settings2 className="w-3 h-3 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground">
            Args: {Object.keys(workflow.args).map(k => (
              <span key={k} className="font-mono text-cyan-500 ml-1">{k}</span>
            ))}
          </span>
        </div>
      )}

      {/* Split view */}
      <div className="flex-1 flex overflow-hidden">
        {/* Pipeline visual — left */}
        <div className="flex-1 overflow-y-auto border-r border-border">
          <PipelineVisualizer steps={workflow.steps} args={workflow.args} />
        </div>

        {/* YAML source — right */}
        <div className="w-[40%] shrink-0">
          <YamlViewer content={workflow.raw} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Create WorkflowsPage**

Create `src/components/views/WorkflowsPage.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { Loader2, Layers, Inbox } from 'lucide-react';
import { fetchLobsterFiles, fetchLobsterWorkflow } from '../../lib/lobster-api';
import type { LobsterFileEntry, LobsterWorkflow } from '../../types/lobster';
import { WorkflowCard } from '../lobster/WorkflowCard';
import { WorkflowDetail } from '../lobster/WorkflowDetail';

export function WorkflowsPage() {
  const [files, setFiles] = useState<LobsterFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<LobsterWorkflow | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchLobsterFiles()
      .then(setFiles)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSelectWorkflow = async (file: LobsterFileEntry) => {
    setLoadingDetail(true);
    const workflow = await fetchLobsterWorkflow(file.agentId, file.filename);
    if (workflow) setSelectedWorkflow(workflow);
    setLoadingDetail(false);
  };

  // Detail view
  if (selectedWorkflow) {
    return <WorkflowDetail workflow={selectedWorkflow} onBack={() => setSelectedWorkflow(null)} />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <Layers className="w-4 h-4 text-orange-400" />
          <h1 className="text-lg font-semibold text-foreground">Workflows</h1>
        </div>
        <span className="text-xs text-muted-foreground">{files.length} workflow{files.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-500">
          {error}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
          </div>
        ) : loadingDetail ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            <span className="ml-2 text-sm text-muted-foreground">Loading workflow...</span>
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Inbox className="w-10 h-10 text-muted-foreground/30 mb-3" />
            <h3 className="text-sm font-medium text-foreground">No workflows found</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm text-center">
              Create <code className="px-1 py-0.5 bg-muted rounded text-[10px]">.lobster</code> files in your agent workspaces to define automated pipelines with approval checkpoints.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {files.map(file => (
              <WorkflowCard
                key={`${file.agentId}/${file.filename}`}
                workflow={file}
                onClick={() => handleSelectWorkflow(file)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add src/components/lobster/ src/components/views/WorkflowsPage.tsx
git commit -m "feat: add lobster workflows page with pipeline visualization"
```

---

## Task 7: Tasks/Flows UX Enhancement

**Files:**
- Create: `src/components/tasks/FlowTimeline.tsx`
- Modify: `src/components/views/TasksFlowsPage.tsx`
- Modify: `src/components/tasks/TaskRunCard.tsx`
- Modify: `src/components/tasks/TaskFlowDetail.tsx`

- [ ] **Step 1: Create FlowTimeline waterfall component**

Create `src/components/tasks/FlowTimeline.tsx`:

```tsx
import type { TaskRun } from '../../types/tasks';
import { taskRunStatusConfig } from '../../types/tasks';

interface FlowTimelineProps {
  tasks: TaskRun[];
}

const statusColors: Record<string, string> = {
  queued: 'bg-gray-400',
  running: 'bg-blue-500',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  timed_out: 'bg-orange-500',
  cancelled: 'bg-gray-500',
  lost: 'bg-gray-600',
};

export function FlowTimeline({ tasks }: FlowTimelineProps) {
  if (tasks.length === 0) return null;

  // Calculate time bounds
  const now = Date.now();
  const allStarts = tasks.map(t => t.startedAt || t.createdAt).filter(Boolean);
  const allEnds = tasks.map(t => t.endedAt || (t.status === 'running' ? now : t.startedAt || t.createdAt)).filter(Boolean);
  const minTime = Math.min(...allStarts);
  const maxTime = Math.max(...allEnds, now);
  const range = maxTime - minTime || 1;

  return (
    <div className="py-3">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-5">
        Timeline
      </p>
      <div className="space-y-1.5 px-5">
        {tasks.map(task => {
          const start = task.startedAt || task.createdAt;
          const end = task.endedAt || (task.status === 'running' ? now : start);
          const left = ((start - minTime) / range) * 100;
          const width = Math.max(((end - start) / range) * 100, 1.5);
          const color = statusColors[task.status] || 'bg-gray-500';
          const status = taskRunStatusConfig[task.status];

          return (
            <div key={task.taskId} className="flex items-center gap-2 group">
              {/* Label */}
              <span className="text-[10px] text-muted-foreground truncate w-24 shrink-0 text-right font-mono" title={task.label || task.taskId}>
                {task.label || task.taskId.slice(0, 10)}
              </span>

              {/* Bar container */}
              <div className="flex-1 h-5 relative bg-muted/30 rounded-sm overflow-hidden">
                <div
                  className={`absolute top-0.5 bottom-0.5 rounded-sm ${color} ${
                    task.status === 'running' ? 'animate-pulse' : ''
                  } transition-all`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${status?.label || task.status} — ${task.label || task.taskId}`}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Time axis labels */}
      <div className="flex justify-between px-5 mt-1 ml-28">
        <span className="text-[9px] text-muted-foreground/60 tabular-nums">
          {new Date(minTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
        <span className="text-[9px] text-muted-foreground/60 tabular-nums">
          {new Date(maxTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Enhance TaskRunCard with pulse and progress**

Replace the full content of `src/components/tasks/TaskRunCard.tsx` with:

```tsx
import { Clock, Loader2, CheckCircle, XCircle, Ban, Skull, Timer, Bot, Terminal, CalendarClock, Plug } from 'lucide-react';
import type { TaskRun } from '../../types/tasks';
import { taskRunStatusConfig } from '../../types/tasks';

interface TaskRunCardProps {
  task: TaskRun;
  compact?: boolean;
  onClick: () => void;
}

function StatusIcon({ status }: { status: TaskRun['status'] }) {
  const cls = "w-3.5 h-3.5";
  switch (status) {
    case 'queued':    return <Clock className={`${cls} text-gray-400`} />;
    case 'running':   return <Loader2 className={`${cls} text-blue-500 animate-spin`} />;
    case 'succeeded': return <CheckCircle className={`${cls} text-emerald-500`} />;
    case 'failed':    return <XCircle className={`${cls} text-red-500`} />;
    case 'timed_out': return <Timer className={`${cls} text-orange-500`} />;
    case 'cancelled': return <Ban className={`${cls} text-gray-500`} />;
    case 'lost':      return <Skull className={`${cls} text-gray-600`} />;
    default:          return <Clock className={`${cls} text-gray-400`} />;
  }
}

const runtimeIcons: Record<string, React.ElementType> = {
  subagent: Bot,
  cron: CalendarClock,
  cli: Terminal,
  acp: Plug,
};

function formatDuration(startMs?: number, endMs?: number) {
  if (!startMs) return '';
  const ms = (endMs || Date.now()) - startMs;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function TaskRunCard({ task, compact, onClick }: TaskRunCardProps) {
  const status = taskRunStatusConfig[task.status];
  const RuntimeIcon = runtimeIcons[task.runtime] || Terminal;
  const isActive = task.status === 'running';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg border transition-all ${
        isActive
          ? 'border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10 shadow-sm shadow-blue-500/10'
          : 'border-border bg-card hover:bg-muted/40'
      }`}
    >
      <div className="flex items-center gap-2">
        {/* Pulse dot for running */}
        {isActive && (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
        )}
        {!isActive && <StatusIcon status={task.status} />}
        <span className="text-xs font-medium text-foreground truncate flex-1">
          {task.label || task.taskId.slice(0, 12)}
        </span>
        <RuntimeIcon className="w-3 h-3 text-muted-foreground shrink-0" />
      </div>

      {!compact && (
        <>
          {task.agentId && (
            <p className="text-[10px] text-muted-foreground mt-1 truncate">{task.agentId}</p>
          )}

          {task.progressSummary && isActive && (
            <p className="text-[10px] text-blue-400 mt-1.5 truncate leading-tight">{task.progressSummary}</p>
          )}

          {task.terminalSummary && !isActive && (
            <p className="text-[10px] text-muted-foreground mt-1.5 truncate leading-tight">{task.terminalSummary}</p>
          )}

          <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
            {task.startedAt && (
              <span className="tabular-nums">{formatDuration(task.startedAt, task.endedAt)}</span>
            )}
            <span className="ml-auto tabular-nums">{timeAgo(task.createdAt)}</span>
          </div>
        </>
      )}
    </button>
  );
}
```

- [ ] **Step 3: Add FlowTimeline to TaskFlowDetail**

In `src/components/tasks/TaskFlowDetail.tsx`, add this import at the top (after line 4):

```typescript
import { FlowTimeline } from './FlowTimeline';
```

In `src/components/tasks/TaskFlowDetail.tsx`, add the FlowTimeline between the progress section and blocked info section. Insert after the closing `</div>` of the progress section (after line 84) and before the blocked info div (line 87):

```tsx
      {/* Timeline waterfall */}
      {flow.tasks && flow.tasks.length > 0 && (
        <div className="border-t border-border">
          <FlowTimeline tasks={flow.tasks} />
        </div>
      )}
```

- [ ] **Step 4: Enhance TasksFlowsPage with auto-refresh and search**

Replace the full content of `src/components/views/TasksFlowsPage.tsx` with:

```tsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw, Loader2, Inbox, Search } from 'lucide-react';
import { fetchTasks, fetchFlows } from '../../lib/tasks-api';
import type { TaskRun, TaskFlow } from '../../types/tasks';
import { FlowList } from '../tasks/FlowList';
import { TaskKanban } from '../tasks/TaskKanban';
import { DetailDrawer } from '../tasks/DetailDrawer';
import { TaskRunDetail } from '../tasks/TaskRunDetail';
import { TaskFlowDetail } from '../tasks/TaskFlowDetail';
import { useNavigate } from 'react-router-dom';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';

type DrawerContent =
  | { type: 'task'; task: TaskRun }
  | { type: 'flow'; flowId: string }
  | null;

export function TasksFlowsPage() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TaskRun[]>([]);
  const [flows, setFlows] = useState<TaskFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [showStandalone, setShowStandalone] = useState(false);
  const [drawer, setDrawer] = useState<DrawerContent>(null);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [tasksData, flowsData] = await Promise.all([fetchTasks(), fetchFlows()]);
      setTasks(tasksData);
      setFlows(flowsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh when there are active tasks
  const hasActiveTasks = useMemo(
    () => tasks.some(t => t.status === 'running' || t.status === 'queued'),
    [tasks]
  );
  useAutoRefresh(() => loadData(true), 5000, hasActiveTasks);

  // Filter tasks based on selection + search
  const filteredTasks = useMemo(() => {
    let result = selectedFlowId
      ? tasks.filter(t => t.parentFlowId === selectedFlowId)
      : showStandalone
        ? tasks.filter(t => !t.parentFlowId)
        : tasks;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(t =>
        (t.label || '').toLowerCase().includes(q) ||
        t.taskId.toLowerCase().includes(q) ||
        (t.agentId || '').toLowerCase().includes(q) ||
        t.runtime.toLowerCase().includes(q)
      );
    }

    return result;
  }, [tasks, selectedFlowId, showStandalone, searchQuery]);

  const handleSelectFlow = (flowId: string | null) => {
    setSelectedFlowId(flowId);
    setShowStandalone(false);
  };

  const handleToggleStandalone = () => {
    setShowStandalone(!showStandalone);
    setSelectedFlowId(null);
  };

  const handleTaskClick = (task: TaskRun) => {
    setDrawer({ type: 'task', task });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">Tasks & Flows</h1>
          {hasActiveTasks && (
            <span className="flex items-center gap-1.5 text-[10px] text-blue-500">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
              </span>
              Auto-refreshing
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search tasks..."
              className="pl-8 pr-3 py-1.5 w-48 bg-muted/50 border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
            />
          </div>

          <button
            onClick={() => loadData()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-500">
          {error}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel */}
        <div className="w-72 border-r border-border shrink-0 overflow-hidden flex flex-col">
          <FlowList
            flows={flows}
            tasks={tasks}
            selectedFlowId={selectedFlowId}
            onSelectFlow={handleSelectFlow}
            showStandalone={showStandalone}
            onToggleStandalone={handleToggleStandalone}
          />
        </div>

        {/* Right panel */}
        <div className="flex-1 p-4 overflow-hidden flex flex-col">
          {loading && tasks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center">
              <Inbox className="w-8 h-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">
                {searchQuery ? 'No matching tasks' : selectedFlowId ? 'No tasks in this flow' : 'No tasks yet'}
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {searchQuery ? 'Try a different search term' : 'Tasks appear here when agents run background work'}
              </p>
            </div>
          ) : (
            <TaskKanban tasks={filteredTasks} onTaskClick={handleTaskClick} />
          )}
        </div>
      </div>

      {/* Detail Drawer */}
      <DetailDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        title={drawer?.type === 'task' ? 'Task Run' : drawer?.type === 'flow' ? 'Task Flow' : ''}
        subtitle={drawer?.type === 'task' ? drawer.task.label || drawer.task.taskId : drawer?.type === 'flow' ? drawer.flowId : undefined}
      >
        {drawer?.type === 'task' && (
          <TaskRunDetail
            task={drawer.task}
            onNavigateToFlow={(flowId) => {
              setDrawer(null);
              setSelectedFlowId(flowId);
            }}
            onNavigateToSession={(key) => navigate(`/session/${encodeURIComponent(key)}`)}
          />
        )}
        {drawer?.type === 'flow' && (
          <TaskFlowDetail
            flowId={drawer.flowId}
            onSelectTask={(task) => setDrawer({ type: 'task', task })}
          />
        )}
      </DetailDrawer>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/tasks/FlowTimeline.tsx src/components/tasks/TaskRunCard.tsx src/components/tasks/TaskFlowDetail.tsx src/components/views/TasksFlowsPage.tsx
git commit -m "feat: enhance tasks/flows with auto-refresh, search, timeline, and pulse animations"
```

---

## Task 8: Routing & Sidebar Integration

**Files:**
- Modify: `src/App.tsx:19,264`
- Modify: `src/components/layout/AppSidebar.tsx:7,329-349`

- [ ] **Step 1: Add routes to App.tsx**

In `src/App.tsx`, add imports after line 21 (after the CronPage import):

```typescript
import { LogsPage } from './components/views/LogsPage';
import { WorkflowsPage } from './components/views/WorkflowsPage';
```

In `src/App.tsx`, add routes after line 264 (after the `/tasks` route):

```tsx
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
```

- [ ] **Step 2: Add nav items to AppSidebar**

In `src/components/layout/AppSidebar.tsx`, add `ScrollText` and `Workflow` to the lucide-react import on line 7 (add to the existing import):

After `ListTodo,` add:
```
  ScrollText,
  Workflow,
```

In `src/components/layout/AppSidebar.tsx`, in the main navigation section (around lines 329-349), add new NavItems after the Tasks NavItem (after the `</NavItem>` for tasks, around line 342):

```tsx
        <NavItem
          icon={Workflow}
          label="Workflows"
          active={isActive('/workflows')}
          onClick={() => navigate('/workflows')}
        />
        <NavItem
          icon={ScrollText}
          label="Logs"
          active={isActive('/logs')}
          onClick={() => navigate('/logs')}
        />
```

- [ ] **Step 3: Verify dev server runs**

```bash
cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -30
```

Expected: No TypeScript errors (or only pre-existing ones).

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/components/layout/AppSidebar.tsx
git commit -m "feat: add logs and workflows routes and sidebar nav items"
```

---

## Verification

- [ ] **Final check: Start dev server and verify all pages load**

```bash
cd /home/ubuntu/silos && npx vite build 2>&1 | tail -20
```

Expected: Successful build with no errors.
