# Logs Viewer + Lobster Workflows + Tasks/Flows UX — Design Spec

**Date:** 2026-04-08
**Status:** Approved

---

## 1. Logs Viewer (`/logs`)

### Data source
- Gateway RPC method `logs.tail` returns JSONL lines with cursor-based pagination
- Response: `{ file, cursor, size, lines[], truncated?, reset? }`

### Behavior
- **Reactive polling**: `useLogTail` hook polls every 1.5s
- **Visibility-aware**: stops polling when `document.hidden === true`, resumes with last cursor on `visibilitychange`
- **Cursor tracking**: maintains cursor position across polls; detects log rotation via `reset` flag
- **Auto-scroll**: locks to bottom by default; pauses on manual scroll-up; "Jump to bottom" FAB appears

### UI
- Terminal-aesthetic monospace log viewer with dark background
- Each line parsed from JSONL: `{ timestamp, level, subsystem, message }`
- Color-coded levels: error=red, warn=amber, info=cyan, debug=muted/gray, trace=dimmer
- Filter bar: level dropdown (multi-select) + text search input
- Header with file path display, line count, connection status indicator
- Pause/resume button to freeze polling

### Components
- `src/components/views/LogsPage.tsx` — main page
- `src/components/logs/LogViewer.tsx` — core viewer with virtual scroll
- `src/components/logs/LogLine.tsx` — individual log line renderer
- `src/components/logs/LogFilterBar.tsx` — filter controls
- `src/hooks/useLogTail.ts` — reactive polling hook

### Gateway client addition
```typescript
async tailLogs(params?: { cursor?: number; limit?: number; maxBytes?: number }): Promise<LogTailResult>
```

### Types
```typescript
interface LogTailResult {
  file: string;
  cursor: number;
  size: number;
  lines: string[];
  truncated?: boolean;
  reset?: boolean;
}

interface ParsedLogLine {
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  subsystem: string;
  message: string;
  raw: string;
}
```

---

## 2. Lobster Workflows (`/workflows`)

### Data sources
- `.lobster` files read from agent workspaces via Express routes
- YAML parsing client-side for pipeline visualization
- Approval state from session chat history (tool results with `needs_approval`)

### Express routes
```
GET  /api/lobster/files                    — scan all agent dirs for .lobster files
GET  /api/lobster/files/:agentId/:filename — read specific .lobster file content
```

### UI — Gallery View
- Grid of workflow cards (responsive: 1-3 columns)
- Each card: workflow name, step count, step-type icons preview, agent badge
- Click opens detail view
- Empty state with explanation of Lobster and how to create workflows

### UI — Pipeline Visualizer
- Vertical connected-node layout
- Each step rendered as a typed card:
  - `exec` / `command` → Terminal icon, shows command snippet
  - `approve` / `approval: required` → Shield icon, amber accent
  - `llm-task` / `openclaw.invoke --tool llm-task` → Brain icon, purple accent
  - `openclaw.invoke` → Plug icon, blue accent
- Data flow arrows between nodes showing `stdin: $step.stdout` connections
- `condition` steps show a diamond gate node
- Args section at top if workflow has `args`

### UI — Detail View
- Split layout: visual pipeline (left 60%) + YAML source (right 40%)
- YAML shown in monospace with syntax highlighting (basic: keys=cyan, strings=green, comments=gray)
- "Run" button: navigates to agent chat with pre-filled message: `Run the workflow: <name>`
- Metadata: filename, agent, step count, argument definitions

### UI — Approval Center
- Sidebar badge showing count of pending approvals
- Approval banner within workflow detail when a running execution is paused
- Approve/Deny buttons with preview data from the step output
- Uses `resumeToken` to send approval via chat

### Components
- `src/components/views/WorkflowsPage.tsx` — main page with gallery + detail
- `src/components/lobster/WorkflowCard.tsx` — gallery card
- `src/components/lobster/PipelineVisualizer.tsx` — vertical node flow
- `src/components/lobster/StepNode.tsx` — individual step card
- `src/components/lobster/WorkflowDetail.tsx` — split detail view
- `src/components/lobster/YamlViewer.tsx` — syntax-highlighted YAML
- `src/components/lobster/ApprovalBanner.tsx` — approval UI

### Types
```typescript
interface LobsterWorkflow {
  agentId: string;
  filename: string;
  name: string;
  args?: Record<string, { default?: string; description?: string }>;
  steps: LobsterStep[];
  raw: string; // original YAML
}

interface LobsterStep {
  id: string;
  command: string;
  stdin?: string;       // e.g., "$collect.stdout"
  condition?: string;   // e.g., "$approve.approved"
  approval?: 'required' | 'optional';
  env?: Record<string, string>;
  type: 'exec' | 'approve' | 'llm-task' | 'invoke' | 'unknown';
}
```

### Server route implementation
- Scan agent directories under OpenClaw state dir for `*.lobster` files
- Also check agent workspace directories
- Return file list with metadata (name, path, agent association)
- Read individual files and return raw YAML content

---

## 3. Tasks/Flows UX Enhancement

### Auto-refresh
- `useAutoRefresh` hook: polls `fetchTasks()` + `fetchFlows()` every 5s
- Only active when `document.visibilityState === 'visible'` AND at least one task has status `running` or `queued`
- Stops polling when all tasks are terminal

### Flow Timeline
- Horizontal waterfall/Gantt visualization in `TaskFlowDetail`
- Each task as a bar: x-axis = time, width = duration
- Color = status (green=succeeded, blue=running, red=failed, gray=queued)
- Shows relative timing of parallel vs sequential tasks
- Hover reveals details

### Enhanced Task Cards
- Running tasks show animated pulse dot
- Last progress message shown inline (truncated)
- Relative time display ("2m ago") that auto-updates
- Runtime icon (subagent=bot, cron=clock, cli=terminal, acp=plug)

### Better Filtering
- Search input: matches label, taskId, agentId
- Filter chips: runtime type, status
- Combined with existing flow filter

### Enhanced Detail Views
- Copy-to-clipboard buttons on IDs, errors
- Collapsible sections for metadata, chat, errors
- Error display with monospace formatting and expand/collapse for stack traces
- Chat messages show formatted code blocks
- Navigation breadcrumbs: Flow → Task

### Components modified
- `TasksFlowsPage.tsx` — add auto-refresh, search/filter bar
- `TaskRunCard.tsx` — pulse animation, progress preview
- `FlowCard.tsx` — enhanced status display
- `TaskRunDetail.tsx` — copy buttons, better error display, breadcrumbs
- `TaskFlowDetail.tsx` — add flow timeline waterfall
- New: `src/components/tasks/FlowTimeline.tsx` — Gantt/waterfall component
- New: `src/hooks/useAutoRefresh.ts` — visibility-aware polling

---

## 4. Sidebar Updates

- Add "Logs" entry with ScrollText icon
- Add "Workflows" entry with Workflow icon
- Approval badge count on Workflows entry (when pending approvals exist)

---

## 5. Shared Patterns

- All polling hooks use `document.visibilityState` to pause when tab is inactive
- All new pages follow existing layout pattern: header + flex content
- All text through i18n `useTranslation()` where practical
- Types in `src/types/` , API helpers in `src/lib/`
- Components follow 50-150 line guideline, composed into pages
