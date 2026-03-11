# Session Activity Indicators — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add visual indicators for agent working/idle state, a queue activity bar above chat input, progressive stop behavior, and reorganized task panel columns.

**Architecture:** Three self-contained UI changes: (1) a small `AgentStatusDot` in the chat header, (2) an `ActivityBar` component above the input that appears only when messages are queued, (3) restructured `SessionTasksKanban` columns from Active/Completed/Failed to Queued/Active/Completed. One new store action (`clearQueue`) rounds out the changes.

**Tech Stack:** React, Zustand, Tailwind CSS, Lucide icons. All existing dependencies.

**Spec:** `docs/plans/2026-03-11-session-activity-indicators.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/store/dashboard-store.ts` | Modify | Add `clearQueue()` action |
| `src/components/views/ChatView.tsx` | Modify | Add `AgentStatusDot`, `ActivityBar`, rewire stop button, remove old queue indicator |
| `src/components/sessions/SessionTasksKanban.tsx` | Modify | Restructure columns: Queued → Active → Completed (merged with failed/aborted) |

---

## Task 1: Add `clearQueue` store action

**Files:**
- Modify: `src/store/dashboard-store.ts:168-172` (action type declaration)
- Modify: `src/store/dashboard-store.ts` (implementation, near `abortChat` at ~line 1008)

- [ ] **Step 1: Add type declaration**

In the store interface (around line 168), add the `clearQueue` action:

```typescript
// Task actions
updateTaskStatus: (id: string, status: TaskStatus) => void;
abortTask: (runId: string) => Promise<void>;
loadTaskHistory: () => Promise<void>;
clearQueue: () => void;
taskHistoryLoading: boolean;
```

- [ ] **Step 2: Implement `clearQueue`**

Add after `abortChat` (after line ~1008):

```typescript
clearQueue: () => {
  set((state) => ({
    chatMessages: state.chatMessages.map(m =>
      m.role === 'user' && m.status === 'queued'
        ? { ...m, status: 'error' as const }
        : m
    ),
  }));
},
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/store/dashboard-store.ts
git commit -m "feat: add clearQueue action to dashboard store"
```

---

## Task 2: Add `AgentStatusDot` component

**Files:**
- Modify: `src/components/views/ChatView.tsx` (add component before the main `ChatView` export, around line 610)

- [ ] **Step 1: Add the component**

Insert before the `ChatView` function (around line 1025). A simple inline component:

```tsx
function AgentStatusDot({ isWorking }: { isWorking: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {isWorking && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
      )}
      <span className={cn(
        "relative inline-flex rounded-full h-2 w-2 transition-colors duration-300",
        isWorking ? "bg-indigo-500" : "bg-emerald-500"
      )} />
    </span>
  );
}
```

- [ ] **Step 2: Wire into chat header**

In the `ChatView` component, compute `isWorking` from store state:

```typescript
const tasks = useDashboardStore((s) => s.tasks);
const isAgentWorking = chatSending || tasks.some(
  t => t.status === 'running' && t.sessionKey === effectiveKey
);
```

Replace the existing connection status dot (lines 1327-1335) — the `<span className="relative flex h-2 w-2">` block — with:

```tsx
<AgentStatusDot isWorking={connected && isAgentWorking} />
```

And update the label next to it:

```tsx
<span className="font-medium">
  {!connected ? 'Disconnected' : isAgentWorking ? 'Working...' : t('chat.systemReady')}
</span>
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/components/views/ChatView.tsx
git commit -m "feat: add AgentStatusDot with working/idle indicator"
```

---

## Task 3: Add `ActivityBar` component with progressive stop

**Files:**
- Modify: `src/components/views/ChatView.tsx` (add component + wire into layout)

- [ ] **Step 1: Add the `ActivityBar` component**

Insert near the other inline components (before `ChatView`):

```tsx
function ActivityBar({ queuedCount, onStop, onClearQueue }: {
  queuedCount: number;
  onStop: () => void;
  onClearQueue: () => void;
}) {
  const [lastStopAt, setLastStopAt] = useState(0);
  const isConfirmingClear = Date.now() - lastStopAt < 2000;

  // Reset confirmation state after 2s
  useEffect(() => {
    if (!lastStopAt) return;
    const timer = setTimeout(() => setLastStopAt(0), 2000);
    return () => clearTimeout(timer);
  }, [lastStopAt]);

  const handleStop = () => {
    if (isConfirmingClear) {
      onClearQueue();
      setLastStopAt(0);
    } else {
      onStop();
      setLastStopAt(Date.now());
    }
  };

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-amber-500/5 border border-amber-500/20 rounded-lg mx-4 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
        <Clock className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">
          {queuedCount} message{queuedCount !== 1 ? 's' : ''} queued
        </span>
      </div>
      <button
        onClick={handleStop}
        className={cn(
          "text-xs font-medium px-2.5 py-1 rounded-md transition-all",
          isConfirmingClear
            ? "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
            : "bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20"
        )}
      >
        {isConfirmingClear ? 'Clear Queue' : 'Stop'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Wire `ActivityBar` into the layout**

In the `ChatView` return, insert the `ActivityBar` just above the input area (before the `<div className="relative p-4 bg-gradient-to-t ...">` at line 1293):

```tsx
{queuedCount > 0 && (
  <ActivityBar
    queuedCount={queuedCount}
    onStop={() => {
      const { abortChat } = useDashboardStore.getState();
      abortChat();
    }}
    onClearQueue={() => {
      const { clearQueue } = useDashboardStore.getState();
      clearQueue();
    }}
  />
)}
```

- [ ] **Step 3: Remove old inline queue indicator**

Delete the old queue indicator block (lines 1348-1364) — the `{(queuedCount > 0 || (chatSending && sendingCount > 0)) && (` block with the amber badge. This is now handled by the `ActivityBar`.

Keep the `sendingCount` computation (line 1105) since it may still be useful, but remove its display from the input footer.

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/components/views/ChatView.tsx
git commit -m "feat: add ActivityBar with progressive stop for queued messages"
```

---

## Task 4: Restructure `SessionTasksKanban` columns

**Files:**
- Modify: `src/components/sessions/SessionTasksKanban.tsx:53-55` (task grouping)
- Modify: `src/components/sessions/SessionTasksKanban.tsx:114-144` (column rendering)
- Modify: `src/components/sessions/SessionTasksKanban.tsx:167-171` (add amber color style)

- [ ] **Step 1: Add `amber` color to `colStyles`**

At line 167, add amber alongside the existing colors:

```typescript
const colStyles = {
  amber:   { text: 'text-amber-600 dark:text-amber-400',   badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30', accent: 'bg-amber-500',   border: 'border-l-amber-400',   progress: '' },
  cyan:    { text: 'text-cyan-600 dark:text-cyan-400',    badge: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-500/30', accent: 'bg-cyan-500',    border: 'border-l-cyan-400',    progress: 'from-cyan-400 via-blue-500 to-cyan-400' },
  emerald: { text: 'text-emerald-600 dark:text-emerald-400', badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30', accent: 'bg-emerald-500', border: 'border-l-emerald-400', progress: '' },
  rose:    { text: 'text-rose-600 dark:text-rose-400',    badge: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30', accent: 'bg-rose-500',    border: 'border-l-rose-400',    progress: '' },
};
```

Update the `TaskColumnProps` color type:

```typescript
color: 'amber' | 'cyan' | 'emerald' | 'rose';
```

- [ ] **Step 2: Restructure task grouping**

Replace lines 53-55:

```typescript
const runningTasks = sessionTasks.filter(t => t.status === 'running');
const completedTasks = sessionTasks.filter(t => t.status === 'completed');
const failedTasks = sessionTasks.filter(t => t.status === 'error' || t.status === 'aborted');
```

With:

```typescript
const queuedTasks = sessionTasks.filter(t => t.status === 'pending');
const runningTasks = sessionTasks.filter(t => t.status === 'running');
const completedTasks = sessionTasks.filter(t =>
  t.status === 'completed' || t.status === 'error' || t.status === 'aborted'
);
```

- [ ] **Step 3: Update column rendering**

Replace the three `<TaskColumn>` blocks (lines 115-143) with:

```tsx
<TaskColumn
  label="Queued"
  icon={<Clock className="w-3 h-3" />}
  count={queuedTasks.length}
  color="amber"
  tasks={queuedTasks}
  formatDuration={formatDuration}
  onSelect={setSelectedTask}
/>
<TaskColumn
  label={t('tasks.active')}
  icon={<Play className="w-3 h-3" />}
  count={runningTasks.length}
  color="cyan"
  tasks={runningTasks}
  formatDuration={formatDuration}
  onAbort={handleAbort}
  onSelect={setSelectedTask}
/>
<TaskColumn
  label={t('tasks.completed')}
  icon={<CheckCircle2 className="w-3 h-3" />}
  count={completedTasks.length}
  color="emerald"
  tasks={completedTasks}
  formatDuration={formatDuration}
  onSelect={setSelectedTask}
/>
```

- [ ] **Step 4: Add status badges to completed task cards**

In `MiniTaskCard` (line 226), add a small status badge for error/aborted tasks within the completed column. After the existing error preview block (line 296), the card already shows `task.error`. Update the top-right area of the card (after the task name, around line 248-259):

Replace the abort button section:

```tsx
{task.status === 'running' && onAbort && (
  <button
    onClick={(e) => { e.stopPropagation(); onAbort(task.runId); }}
    className="opacity-0 group-hover:opacity-100 ml-auto p-0.5 rounded hover:bg-rose-500/20 text-muted-foreground hover:text-rose-500 transition-all shrink-0"
    title="Abort"
  >
    <X className="w-2.5 h-2.5" />
  </button>
)}
```

With:

```tsx
{task.status === 'running' && onAbort && (
  <button
    onClick={(e) => { e.stopPropagation(); onAbort(task.runId); }}
    className="opacity-0 group-hover:opacity-100 ml-auto p-0.5 rounded hover:bg-rose-500/20 text-muted-foreground hover:text-rose-500 transition-all shrink-0"
    title="Abort"
  >
    <X className="w-2.5 h-2.5" />
  </button>
)}
{task.status === 'error' && (
  <span className="ml-auto text-[8px] font-semibold px-1 py-px rounded bg-rose-500/10 text-rose-500 shrink-0">error</span>
)}
{task.status === 'aborted' && (
  <span className="ml-auto text-[8px] font-semibold px-1 py-px rounded bg-muted text-muted-foreground shrink-0">aborted</span>
)}
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/components/sessions/SessionTasksKanban.tsx
git commit -m "feat: restructure task kanban to Queued/Active/Completed columns"
```

---

## Task 5: Final integration and cleanup

**Files:**
- Modify: `src/components/views/ChatView.tsx` (verify no unused imports, clean up)

- [ ] **Step 1: Remove unused `sendingCount` display**

Verify that after Task 3, `sendingCount` is no longer displayed anywhere in the input footer. If the variable is still used elsewhere (e.g., in the placeholder logic), keep it. If not, it can stay as a computation — no harm.

- [ ] **Step 2: Verify the full flow**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: session activity indicators — complete implementation"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | `clearQueue` store action | `dashboard-store.ts` |
| 2 | `AgentStatusDot` in header | `ChatView.tsx` |
| 3 | `ActivityBar` with progressive stop | `ChatView.tsx` |
| 4 | Task kanban column restructure | `SessionTasksKanban.tsx` |
| 5 | Integration cleanup | `ChatView.tsx` |
