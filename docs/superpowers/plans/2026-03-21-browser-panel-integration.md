# Browser Panel Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate a split-view browser panel with agent status bar, pause/resume, and detach/pop-out into the Silos dashboard.

**Architecture:** Refactor existing `BrowserPanel` into a split-view layout inside `MainShell`. Browser state moves from local `useState` to Zustand store. Agent browser activity is detected from tool-use events in the existing WebSocket stream. Detach mode uses a React portal for overlay and `window.open()` for pop-out.

**Tech Stack:** React 19, Zustand, TypeScript, Tailwind CSS, Lucide icons, noVNC (existing iframe)

**Spec:** `docs/superpowers/specs/2026-03-21-browser-panel-integration-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/store/dashboard-store.ts` | Add browser state fields + browser tool event detection |
| Create | `src/lib/browser-utils.ts` | Shared `buildNoVncUrl` helper (extracted from BrowserPanel) |
| Modify | `src/MainShell.tsx` | Replace current layout with split view + drag handle |
| Rewrite | `src/components/layout/BrowserPanel.tsx` | Refactored panel: header, body, agent status bar |
| Create | `src/components/layout/DragHandle.tsx` | Resizable split handle |
| Create | `src/components/layout/FloatingBrowserPanel.tsx` | Overlay detach via React portal |
| Create | `src/components/layout/AgentStatusBar.tsx` | Agent action text + pause/resume button |
| Modify | `src/components/layout/AppSidebar.tsx` | Wire toggle to store instead of props callback |

---

## Task 1: Add browser state to Zustand store

**Files:**
- Modify: `src/store/dashboard-store.ts`

- [ ] **Step 1: Add browser state fields to the store interface and initial state**

In the store interface (around line 80-234), add:

```typescript
// Browser panel state
browserPanelOpen: boolean;
browserDetached: 'none' | 'overlay' | 'popout';
browserSplitRatio: number;
browserAgentAction: string | null;
browserAgentPaused: boolean;
```

In the store creation (initial values), add:

```typescript
browserPanelOpen: false,
browserDetached: 'none' as const,
browserSplitRatio: 0.5,
browserAgentAction: null,
browserAgentPaused: false,
```

- [ ] **Step 2: Add browser action methods**

Add these methods to the store interface and implementation:

```typescript
// Interface additions:
setBrowserPanelOpen: (open: boolean) => void;
setBrowserDetached: (mode: 'none' | 'overlay' | 'popout') => void;
setBrowserSplitRatio: (ratio: number) => void;
setBrowserAgentAction: (action: string | null) => void;
setBrowserAgentPaused: (paused: boolean) => void;
sendBrowserInterrupt: (text: string) => Promise<void>;

// Implementation:
setBrowserPanelOpen: (open) => set({ browserPanelOpen: open }),
setBrowserDetached: (mode) => set({ browserDetached: mode }),
setBrowserSplitRatio: (ratio) => set({ browserSplitRatio: ratio }),
setBrowserAgentAction: (action) => set({ browserAgentAction: action }),
setBrowserAgentPaused: (paused) => set({ browserAgentPaused: paused }),
sendBrowserInterrupt: async (text: string) => {
  // Bypass the message queue — sends immediately even during active runs.
  // Used for pause/resume which must reach the agent while it's working.
  const { client, selectedSessionKey } = get();
  if (!client || !selectedSessionKey) return;
  try {
    await client.sendChat(selectedSessionKey, text);
  } catch (e) {
    console.error('[browser-interrupt] failed:', e);
  }
},
```

- [ ] **Step 3: Add `browserSplitRatio` to persist partialize**

In the persist config (around line 2371-2380), add `browserSplitRatio` to the partialize function:

```typescript
partialize: (state) => ({
  gatewayUrl: state.gatewayUrl,
  token: state.token,
  darkMode: state.darkMode,
  browserSplitRatio: state.browserSplitRatio,
}),
```

- [ ] **Step 4: Add browser tool detection in `handleEvent`**

In the `handleEvent` function, inside the agent event handler where tool streams are processed (around lines 1779-1870), add browser tool detection:

When `payload.stream === 'tool'`:
- On `phase === 'call'` or `phase === 'input'` or `phase === 'start'`:
  - Check if `payload.data.name === 'browser'` (or starts with `browser`)
  - If so: extract a human-readable action description from `payload.data.input` or `payload.data.args` (e.g., `{ action: 'click', ref: 12 }` → `"clicking element 12..."`)
  - Call `set({ browserAgentAction: description })`
  - If `!get().browserPanelOpen`, call `set({ browserPanelOpen: true })` (auto-open)
- On `phase === 'result'`:
  - If the tool message's `toolName === 'browser'` (or starts with `browser`):
  - Call `set({ browserAgentAction: null })`

Helper function to add (above `handleEvent` or inline):

```typescript
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
```

- [ ] **Step 5: Verify store compiles**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors related to browser state fields.

- [ ] **Step 6: Commit**

```bash
git add src/store/dashboard-store.ts
git commit -m "feat(browser): add browser panel state to Zustand store with tool event detection"
```

---

## Task 2: Extract shared buildNoVncUrl helper

**Files:**
- Create: `src/lib/browser-utils.ts`

- [ ] **Step 1: Create the shared helper**

```typescript
export function buildNoVncUrl(token: string | null, opts: { password?: string; resize?: boolean } = {}) {
  const isDev = window.location.port === '3001' || window.location.port === '3002';
  const baseUrl = isDev
    ? `http://${window.location.hostname}:6080`
    : `${window.location.origin}/browser`;

  const params = new URLSearchParams();
  params.set('autoconnect', 'true');
  params.set('resize', opts.resize ? 'remote' : 'scale');
  if (opts.password) params.set('password', opts.password);

  if (!isDev && token) {
    params.set('token', token);
    params.set('path', `browser/websockify?token=${token}`);
  }

  return `${baseUrl}/browser.html?${params.toString()}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/browser-utils.ts
git commit -m "refactor(browser): extract buildNoVncUrl to shared utility"
```

---

## Task 3: Create DragHandle component

**Files:**
- Create: `src/components/layout/DragHandle.tsx`

- [ ] **Step 1: Create the DragHandle component**

```typescript
import { useCallback, useRef, useEffect } from 'react';

interface DragHandleProps {
  onResize: (ratio: number) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  minLeftPx?: number;
  minRightPx?: number;
}

export function DragHandle({ onResize, containerRef, minLeftPx = 300, minRightPx = 320 }: DragHandleProps) {
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const total = rect.width;
      const clamped = Math.max(minLeftPx, Math.min(total - minRightPx, x));
      onResize(clamped / total);
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onResize, containerRef, minLeftPx, minRightPx]);

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 cursor-col-resize bg-border hover:bg-primary/50 transition-colors flex-shrink-0 group relative"
      title="Drag to resize"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | grep DragHandle || echo "OK"`

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/DragHandle.tsx
git commit -m "feat(browser): add DragHandle component for split view resize"
```

---

## Task 4: Create AgentStatusBar component

**Files:**
- Create: `src/components/layout/AgentStatusBar.tsx`

- [ ] **Step 1: Create the AgentStatusBar component**

```typescript
import { Pause, Play } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useDashboardStore } from '../../store/dashboard-store';

export function AgentStatusBar() {
  const {
    browserAgentAction,
    browserAgentPaused,
    setBrowserAgentPaused,
  } = useDashboardStore();

  // Only show when agent is actively using browser
  if (!browserAgentAction && !browserAgentPaused) return null;

  const handlePauseResume = () => {
    const { sendBrowserInterrupt } = useDashboardStore.getState();
    if (browserAgentPaused) {
      setBrowserAgentPaused(false);
      sendBrowserInterrupt('resume');
    } else {
      setBrowserAgentPaused(true);
      sendBrowserInterrupt('pause');
    }
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 border-t border-border text-xs transition-colors",
        browserAgentPaused
          ? "bg-amber-500/10 border-amber-500/30"
          : "bg-card/50"
      )}
    >
      {/* Animated dot */}
      <div
        className={cn(
          "w-2 h-2 rounded-full flex-shrink-0",
          browserAgentPaused
            ? "bg-amber-500"
            : "bg-green-500 animate-pulse"
        )}
      />

      {/* Action text */}
      <span className={cn(
        "flex-1 truncate",
        browserAgentPaused ? "text-amber-400" : "text-muted-foreground"
      )}>
        {browserAgentPaused
          ? "Paused — you have control"
          : browserAgentAction || "Working..."}
      </span>

      {/* Pause/Resume button */}
      <button
        onClick={handlePauseResume}
        className={cn(
          "flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold transition-colors flex-shrink-0",
          browserAgentPaused
            ? "bg-green-600 hover:bg-green-500 text-white"
            : "bg-red-600 hover:bg-red-500 text-white"
        )}
      >
        {browserAgentPaused ? (
          <><Play className="w-3 h-3" /> RESUME</>
        ) : (
          <><Pause className="w-3 h-3" /> PAUSE</>
        )}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | grep AgentStatusBar || echo "OK"`

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/AgentStatusBar.tsx
git commit -m "feat(browser): add AgentStatusBar with pause/resume controls"
```

---

## Task 5: Refactor BrowserPanel for split view

**Files:**
- Rewrite: `src/components/layout/BrowserPanel.tsx`

- [ ] **Step 1: Rewrite BrowserPanel**

The refactored component removes the `open`/`onClose` props (state now from store), uses the new `AgentStatusBar`, and adds detach controls:

```typescript
import { useState, useEffect, useRef } from 'react';
import { Monitor, X, RefreshCw, ExternalLink, PanelRightClose } from 'lucide-react';
import { cn } from '../../lib/utils';
import { buildNoVncUrl } from '../../lib/browser-utils';
import { useDashboardStore } from '../../store/dashboard-store';
import { AgentStatusBar } from './AgentStatusBar';

export function BrowserPanel() {
  const {
    browserPanelOpen,
    browserDetached,
    setBrowserPanelOpen,
    setBrowserDetached,
    token,
  } = useDashboardStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [connected, setConnected] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const url = buildNoVncUrl(token, { password: 'abc123', resize: true });

  useEffect(() => {
    if (browserPanelOpen) {
      setLoading(true);
      setError(false);
    }
  }, [browserPanelOpen]);

  if (!browserPanelOpen || browserDetached !== 'none') return null;

  const handleRefresh = () => {
    setLoading(true);
    setError(false);
    if (iframeRef.current) iframeRef.current.src = url;
  };

  const handlePopout = () => {
    window.open(url, '_blank', 'width=1024,height=768');
    setBrowserDetached('popout');
  };

  const handleDetachOverlay = () => {
    setBrowserDetached('overlay');
  };

  return (
    <div className="flex flex-col border-l border-border bg-background h-full min-w-[320px]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className={cn("w-2 h-2 rounded-full", connected ? "bg-green-500" : "bg-red-500")} />
          <span className="text-xs font-semibold text-foreground">Remote Browser</span>
          {loading && (
            <div className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={handleRefresh} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Refresh">
            <RefreshCw className="w-3 h-3" />
          </button>
          <button onClick={handleDetachOverlay} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Detach to overlay">
            <PanelRightClose className="w-3 h-3" />
          </button>
          <button onClick={handlePopout} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Pop out to window">
            <ExternalLink className="w-3 h-3" />
          </button>
          <button onClick={() => setBrowserPanelOpen(false)} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors" title="Close">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 relative bg-black min-h-0">
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Monitor className="w-8 h-8 opacity-40" />
            <p className="text-sm">Browser not available</p>
            <button onClick={handleRefresh} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-muted hover:bg-accent transition-colors">
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={url}
            className="w-full h-full border-0"
            onLoad={() => { setLoading(false); setConnected(true); }}
            onError={() => { setLoading(false); setError(true); setConnected(false); }}
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>

      {/* Agent status bar */}
      <AgentStatusBar />
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/BrowserPanel.tsx
git commit -m "feat(browser): refactor BrowserPanel to use store state + agent status bar"
```

---

## Task 6: Create FloatingBrowserPanel for overlay detach

**Files:**
- Create: `src/components/layout/FloatingBrowserPanel.tsx`

- [ ] **Step 1: Create the FloatingBrowserPanel component**

```typescript
import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Monitor, X, RefreshCw, ExternalLink, PanelRightOpen, GripHorizontal } from 'lucide-react';
import { cn } from '../../lib/utils';
import { buildNoVncUrl } from '../../lib/browser-utils';
import { useDashboardStore } from '../../store/dashboard-store';
import { AgentStatusBar } from './AgentStatusBar';

export function FloatingBrowserPanel() {
  const {
    browserPanelOpen,
    browserDetached,
    setBrowserDetached,
    setBrowserPanelOpen,
    token,
  } = useDashboardStore();

  const [pos, setPos] = useState({ x: 100, y: 60 });
  const [size, setSize] = useState({ w: Math.min(800, window.innerWidth * 0.6), h: Math.min(600, window.innerHeight * 0.7) });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizing = useRef(false);

  const url = buildNoVncUrl(token, { password: 'abc123', resize: true });

  // Drag
  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    document.body.style.userSelect = 'none';
  }, [pos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y });
      }
      if (resizing.current) {
        setSize(s => ({
          w: Math.max(400, e.clientX - pos.x),
          h: Math.max(300, e.clientY - pos.y),
        }));
      }
    };
    const onUp = () => {
      dragging.current = false;
      resizing.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pos]);

  if (!browserPanelOpen || browserDetached !== 'overlay') return null;

  const handleReattach = () => setBrowserDetached('none');

  const handlePopout = () => {
    window.open(url, '_blank', 'width=1024,height=768');
    setBrowserDetached('popout');
  };

  const handleRefresh = () => {
    setLoading(true);
    setError(false);
    if (iframeRef.current) iframeRef.current.src = url;
  };

  return createPortal(
    <div
      className="fixed z-50 flex flex-col rounded-lg border border-border bg-background shadow-2xl overflow-hidden"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      {/* Draggable header */}
      <div
        onMouseDown={onDragStart}
        className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/80 cursor-grab active:cursor-grabbing flex-shrink-0"
      >
        <div className="flex items-center gap-2">
          <GripHorizontal className="w-3 h-3 text-muted-foreground" />
          <span className="text-xs font-semibold text-foreground">Remote Browser</span>
          {loading && (
            <div className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={handleRefresh} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Refresh">
            <RefreshCw className="w-3 h-3" />
          </button>
          <button onClick={handleReattach} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Re-attach to split">
            <PanelRightOpen className="w-3 h-3" />
          </button>
          <button onClick={handlePopout} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Pop out">
            <ExternalLink className="w-3 h-3" />
          </button>
          <button onClick={() => setBrowserPanelOpen(false)} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors" title="Close">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 relative bg-black min-h-0">
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Monitor className="w-8 h-8 opacity-40" />
            <p className="text-sm">Browser not available</p>
            <button onClick={handleRefresh} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-muted hover:bg-accent transition-colors">
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={url}
            className="w-full h-full border-0"
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setError(true); }}
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>

      <AgentStatusBar />

      {/* Resize handle (bottom-right corner) */}
      <div
        onMouseDown={(e) => { e.preventDefault(); resizing.current = true; document.body.style.cursor = 'nwse-resize'; document.body.style.userSelect = 'none'; }}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
      />
    </div>,
    document.body
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/FloatingBrowserPanel.tsx
git commit -m "feat(browser): add FloatingBrowserPanel overlay with drag and resize"
```

---

## Task 7: Refactor MainShell for split view layout

**Files:**
- Modify: `src/MainShell.tsx`

- [ ] **Step 1: Update MainShell to use store state and split layout**

Replace the current layout. Key changes:
- Remove `useState` for `browserOpen` — use store's `browserPanelOpen`
- Add `useRef` for the split container
- Import and render `DragHandle` between `<main>` and `<BrowserPanel>`
- Import and render `FloatingBrowserPanel` at the end (portal, always mounted)
- Pass `browserSplitRatio` as flex-basis to both panes

Updated `MainShell`:

```typescript
import { useRef } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { Loader2, WifiOff, RefreshCw } from 'lucide-react';
import { AppSidebar } from './components/layout/AppSidebar';
import { CommandPalette } from './components/layout/CommandPalette';
import { BrowserPanel } from './components/layout/BrowserPanel';
import { FloatingBrowserPanel } from './components/layout/FloatingBrowserPanel';
import { DragHandle } from './components/layout/DragHandle';
import { ToastProvider, useToast } from './components/ui/toast';
import { useDashboardStore } from './store/dashboard-store';
import useTranslation from './i18n';
```

Keep `ReconnectToast` and `ConnectionOverlay` unchanged.

Replace the `MainShell` function body:

```typescript
export function MainShell() {
  const { connected, token, browserPanelOpen, browserDetached, browserSplitRatio, setBrowserSplitRatio } = useDashboardStore();
  const splitRef = useRef<HTMLDivElement>(null);

  if (!token) {
    return <Navigate to="/connect" replace />;
  }

  const showSplit = browserPanelOpen && browserDetached === 'none';

  return (
    <ToastProvider>
      <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
        <AppSidebar />
        <div ref={splitRef} className="flex-1 flex min-w-0">
          <main
            className="flex flex-col min-w-0 transition-all duration-200"
            style={{ flex: showSplit ? `0 0 ${browserSplitRatio * 100}%` : '1 1 100%' }}
          >
            <Outlet />
          </main>
          {showSplit && (
            <>
              <DragHandle
                containerRef={splitRef}
                onResize={setBrowserSplitRatio}
              />
              <div style={{ flex: `0 0 ${(1 - browserSplitRatio) * 100}%` }} className="min-w-[320px]">
                <BrowserPanel />
              </div>
            </>
          )}
        </div>
        <FloatingBrowserPanel />
        <CommandPalette />
      </div>
      {!connected && <ConnectionOverlay />}
      <ReconnectToast />
    </ToastProvider>
  );
}
```

- [ ] **Step 2: Verify it compiles and renders**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -20`

Then start dev server and verify:
- Dashboard loads normally without browser panel
- No console errors

- [ ] **Step 3: Commit**

```bash
git add src/MainShell.tsx
git commit -m "feat(browser): wire split view layout in MainShell with drag handle"
```

---

## Task 8: Update AppSidebar to use store

**Files:**
- Modify: `src/components/layout/AppSidebar.tsx`

- [ ] **Step 1: Replace props-based browser toggle with store**

Remove `onBrowserToggle` and `browserOpen` from props. Read/write `browserPanelOpen` from the store instead.

In the component:
- Add to store destructuring: `browserPanelOpen, setBrowserPanelOpen`
- Replace `onBrowserToggle?.()` with `setBrowserPanelOpen(!browserPanelOpen)`
- Replace `browserOpen` checks with `browserPanelOpen`
- Remove `onBrowserToggle` and `browserOpen` from the function signature
- The button visibility condition `connected && onBrowserToggle` becomes just `connected`

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/AppSidebar.tsx
git commit -m "feat(browser): wire sidebar browser toggle to Zustand store"
```

---

## Task 9: Manual verification and cleanup

- [ ] **Step 1: Start dev server and test core flows**

Run: `cd /home/ubuntu/silos && npm run dev`

Test checklist:
1. Dashboard loads — no console errors
2. Click Monitor icon in sidebar → browser panel opens as split view (right side)
3. Drag handle resizes the split — ratio persists on refresh
4. Click close (X) → panel closes, chat reclaims full width
5. Click Monitor again → panel reopens at saved ratio
6. Click detach → panel moves to floating overlay, chat goes full width
7. Drag overlay by title bar — moves freely
8. Click re-attach → returns to split view
9. Click pop-out → opens native window with noVNC, overlay closes
10. Close browser panel → `browserDetached` resets to `'none'`

- [ ] **Step 2: Fix any TypeScript or runtime errors found during testing**

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(browser): address issues found during manual testing"
```
