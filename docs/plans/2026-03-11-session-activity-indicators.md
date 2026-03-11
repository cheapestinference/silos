# Session Activity Indicators

**Date**: 2026-03-11
**Status**: Approved

## Summary

Add visual indicators for agent/session state in the chat view: a header badge showing working/idle, an activity bar for queued chat messages, and reorganized task panel columns.

## Components

### 1. Agent Status Dot (Header)

A small animated dot next to the session name in the chat header.

- **Working**: pulsing dot (indigo/cyan glow animation)
- **Idle**: static green dot, no animation

Logic:
```
isWorking = chatSending.get(sessionKey) || tasks.some(t => t.status === 'running' && t.sessionKey === sessionKey)
```

No text, no dropdown. Just the dot.

### 2. Activity Bar (Above Chat Input)

Appears only when `queuedCount > 0` (user messages waiting to be processed). Slides in from bottom with animation.

```
┌─────────────────────────────────────────────────────┐
│ ⏳ 2 messages queued       [Clear Queue]    [Stop]  │
└─────────────────────────────────────────────────────┘
```

- Shows count of `queued` user messages
- Stop button: aborts the active run (`abortChat(sessionKey, runId)`)
- When `queuedCount === 0`, the bar disappears — stop button returns to its current position next to Send

**When there is no queue but agent is processing**: the existing Stop button next to Send handles it (no activity bar needed).

### 3. Progressive Stop

| Action | Effect |
|--------|--------|
| 1st click | `abortChat(sessionKey, runId)` — kills the active run |
| 2nd click (within 2s) | Clears queue: all `queued` messages → `error` status with "cancelled" |

Implementation:
- After first click, Stop button transforms to "Clear Queue" (red styling, 2s timeout)
- If not clicked within 2s, reverts to normal Stop
- State: `lastStopClickedAt: number` tracked in component (not store)

### 4. Tasks Panel Reorganization

Current columns: Active | Completed | Failed

New columns: **Queued | Active | Completed**

- **Queued**: tasks with `pending` status
- **Active**: tasks with `running` status, each with individual `×` stop button
- **Completed**: tasks with `completed`, `error`, or `aborted` status
  - `error` tasks: red badge
  - `aborted` tasks: gray badge
  - `completed` tasks: green badge (or no badge)

Individual task stop: calls `abortChat(sessionKey, task.runId)` for that specific task's run.

## New Store Actions

### `clearQueue()`
Marks all `queued` messages as `error` with a cancellation indicator. Does not abort the active run.

```typescript
clearQueue: () => {
  set((state) => ({
    chatMessages: state.chatMessages.map(m =>
      m.status === 'queued' ? { ...m, status: 'error' as const } : m
    )
  }));
}
```

### `abortTask(taskId: string)`
Finds the task, extracts its `runId`, calls `abortChat` for that specific run.

```typescript
abortTask: async (taskId: string) => {
  const task = get().tasks.find(t => t.id === taskId);
  if (!task || task.status !== 'running') return;
  await get().client.abortChat(task.sessionKey, task.runId);
  // Task status will be updated by the lifecycle event handler
}
```

## New Components

### `AgentStatusDot`
- Props: `isWorking: boolean`
- Renders a `w-2 h-2` dot with conditional pulse animation
- Used in the chat header next to session name

### `ActivityBar`
- Props: `queuedCount: number`, `onStop: () => void`, `onClearQueue: () => void`
- Self-contained component with internal `lastStopAt` state for progressive stop
- Conditionally rendered when `queuedCount > 0`

## What Gets Reused

- `chatSending` Map, `activeRunId` Map, `tasks[]` — all existing
- `abortChat()` action — existing, used for both general and per-task stop
- Message status system (`queued`/`sending`/`delivered`/`error`) — existing
- Stop button logic — moved from inline-with-send into ActivityBar when queue active

## What Does NOT Change

- Input area stays enabled during processing (allows queueing)
- Placeholder text ("Agent is processing...") stays
- Tools panel (right side) stays unchanged
- No new server/gateway RPCs needed
- No persistence changes

## Files to Modify

1. `src/store/dashboard-store.ts` — add `clearQueue()` and `abortTask()` actions
2. `src/components/views/ChatView.tsx` — add `AgentStatusDot`, `ActivityBar`, move stop logic, update task panel columns
