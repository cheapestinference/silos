# Browser Panel Integration — Design Spec

**Date:** 2026-03-21
**Status:** Approved

## Problem

Silos dashboard needs an integrated browser panel so users can:
1. See the remote browser (VPS) in real-time while chatting with the agent
2. Log into sites manually (e.g., Twitter/X) then hand control to the OpenClaw agent
3. Monitor what the agent is doing in the browser and pause/resume as needed

## Decisions

- **No external browser automation framework needed** — OpenClaw ships with a complete `browser` tool (40+ actions, accessibility tree snapshots, CDP-native, multi-profile)
- **noVNC** remains the visual transport (already integrated — iframe connecting to VPS via websockify)
- OpenClaw's browser tool handles all agent-side automation (click, type, navigate, extract, etc.)

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Silos Dashboard (React)                        │
│  ├─ ChatView (left)                             │
│  ├─ Drag Handle                                 │
│  └─ BrowserPanel (right)                        │
│      ├─ Header: connection status, controls     │
│      ├─ Body: noVNC iframe                      │
│      └─ AgentStatusBar: action text + PAUSE     │
├─────────────────────────────────────────────────┤
│  OpenClaw Gateway (VPS)                         │
│  ├─ Browser tool (CDP → Chromium)               │
│  ├─ Browser control API (loopback HTTP)         │
│  └─ websockify (VNC → WebSocket for noVNC)      │
└─────────────────────────────────────────────────┘
```

## Design

### 1. Layout — Split View

- Default mode: chat (left) + browser panel (right), horizontal split
- Resizable via drag handle between panes
- Default ratio: 50/50, persisted in localStorage
- When panel closes, chat reclaims full width with smooth transition
- Minimum panel width: 320px

### 2. BrowserPanel Component

**Header bar:**
- Connection indicator (green/red dot)
- Title: "Remote Browser"
- Buttons: Refresh | Detach to overlay | Pop-out to native window | Close

**Body:**
- iframe with noVNC stream (existing implementation, connects to VPS via websockify)
- When agent is paused, user interacts with the iframe normally (click, scroll, type)

**Agent status bar** (footer, only visible when agent is using browser):
- Animated dot + current action text (e.g., "navigating to x.com...", "clicking Like on tweet #2...")
- PAUSE/RESUME button
- When paused: bar color changes to amber, shows "Paused — you have control" + RESUME button

### 3. Detach Modes

**Overlay (default detach):**
- `position: fixed` div with drag handle on title bar, resize handles on edges
- Retains header + body + agent status bar
- High z-index with drop shadow
- "Re-attach" button to return to split view

**Pop-out (native window):**
- `window.open()` with noVNC URL directly
- No agent status bar (that info remains in the chat)
- For multi-monitor setups

### 4. Auto-Open / Manual Open

- **Auto-open:** when the agent starts using the browser tool (detected via chat events containing browser actions), the panel opens automatically if closed
- **No auto-close:** the panel stays open until the user closes it manually
- **Manual toggle:** Monitor icon button in the sidebar, available at any time
- Panel open/closed state lives in the dashboard store

### 5. Pause / Resume Flow

```
Agent executing browser actions
  └─ User clicks PAUSE
      └─ Dashboard sends a plain chat message: "pause" (or localized equivalent)
      └─ Status bar → amber immediately (optimistic UI)
      └─ Agent acknowledges pause in its response (soft pause — not guaranteed instant)
      └─ User interacts with browser freely (login, scroll, etc.)
      └─ User clicks RESUME
          └─ Dashboard sends a plain chat message: "resume" / "continue"
          └─ Agent resumes from current browser state
```

**Mechanism:** Soft pause via plain chat messages. The dashboard sends a regular user message (e.g., "pause") through the existing OpenClaw chat channel. The agent interprets this as "stop browser actions and wait for further instructions." This is a cooperative pause — the agent may finish its current action before stopping. The UI shows "Paused" optimistically on click, without waiting for agent acknowledgment.

**Why not a hard/RPC pause:** OpenClaw has no built-in pause/resume API for agent runs. A plain chat message is the simplest mechanism that works today. If a future OpenClaw version adds a pause RPC, we can upgrade the UI to use it without changing the UX.

### 6. Store Changes

**Migration note:** `browserOpen` currently lives as `useState` in `MainShell.tsx` (line 76). It must be moved to the Zustand store as `browserPanelOpen` so that auto-open from agent events and sidebar toggle both share the same state.

`browserSplitRatio` uses the store's existing Zustand `persist` middleware (already configured for other fields), not a separate localStorage key.

```typescript
// Additions to useDashboardStore (Zustand, persisted)
browserPanelOpen: boolean          // panel visible in split view
browserDetached: 'none' | 'overlay' | 'popout'  // detach mode
browserSplitRatio: number          // 0.5 default
browserAgentAction: string | null  // current action text from agent events
browserAgentPaused: boolean        // pause state (optimistic UI)
```

### 7. Component Tree

```
MainShell
├── AppSidebar (existing — add browser toggle button)
├── ChatView (existing — constrained to left split)
├── DragHandle (new — resize split)
└── BrowserPanel (refactored from existing)
    ├── BrowserHeader (connection + controls)
    ├── BrowserBody (noVNC iframe)
    └── AgentStatusBar (new — action text + pause)

// When detached as overlay:
Portal
└── FloatingBrowserPanel
    ├── DragHandle (title bar)
    ├── BrowserHeader
    ├── BrowserBody
    └── AgentStatusBar

// When popped out:
window.open() → noVNC URL (existing browser.html)
```

### 8. Agent Event Integration

The dashboard already receives streaming events from OpenClaw via WebSocket. There are no dedicated browser events — we detect browser activity by parsing existing tool-use events from the chat stream.

**Detection logic:** When the agent calls the `browser` tool, the chat event stream includes tool-use events with `tool_name` (or equivalent field) indicating the tool being invoked and the action parameters. The dashboard should:

1. **Detect browser tool calls** by checking if `tool_name === 'browser'` (or starts with `browser_`) in incoming tool-use chat events
2. **Extract action description** from the tool call parameters (e.g., `action: "click"`, `ref: 12` → "clicking element 12...")
3. **Set `browserAgentAction`** with a human-readable description of the action
4. **Auto-open panel** if `browserPanelOpen` is false when a browser tool call is detected
5. **Clear `browserAgentAction`** when the tool-use result event arrives (action completed)

The exact event payload structure depends on the OpenClaw chat event format. During implementation, inspect the actual `EventFrame` types in the codebase to determine the correct field names for tool name and parameters.

### 9. noVNC Connection

Existing implementation (no changes needed):
- Dev: connects to `http://{hostname}:6080` (direct noVNC)
- Prod: connects to `{origin}/browser` (proxied through gateway)
- Auth: gateway token passed as query param for prod WebSocket path

### 10. Scope Boundaries

**In scope:**
- Split view layout with drag handle
- Browser panel with agent status bar
- Detach to overlay + pop-out to native window
- Auto-open on agent browser use
- Pause/resume UI (button + status bar state)
- Sidebar toggle button

**Out of scope (future):**
- Agent snapshot viewer (showing what the agent "sees" as text)
- Browser tool configuration UI (profile selection, CDP settings)
- Multi-browser sessions
- Recording/replay of agent browser sessions
