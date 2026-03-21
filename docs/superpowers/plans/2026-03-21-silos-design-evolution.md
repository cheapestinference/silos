# Silos Design Evolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the Silos dashboard visual layer — consistent theming through CSS tokens, depth through elevation shadows, generous radii, subtle gradients, satisfying micro-interactions, and a warm dark mode.

**Architecture:** Config-first approach. All Tailwind/CSS infrastructure (tokens, shadows, easing, radius) is built in Tasks 1-3 before any component touches. Then components are migrated in batches grouped by similarity. No new files — all edits to existing files.

**Tech Stack:** Tailwind CSS 3.4, CSS custom properties (HSL), React 19, Zustand.

**Spec:** `docs/superpowers/specs/2026-03-21-silos-design-evolution-design.md`

---

### Task 1: Tailwind Config — Shadows, Easing, Radius

**Files:**
- Modify: `tailwind.config.js`

**Why:** All elevation shadows, easing curves, and the updated radius must exist before any component references them. This is the foundation.

- [ ] **Step 1: Add elevation shadow system**

In `tailwind.config.js`, inside `theme.extend`, add the `boxShadow` object after the existing `backdropBlur` (around line 156):

```js
      boxShadow: {
        'elevation-0': 'inset 0 1px 2px hsl(var(--foreground) / 0.06)',
        'elevation-1': '0 1px 3px hsl(var(--foreground) / 0.06), 0 1px 2px hsl(var(--foreground) / 0.04)',
        'elevation-2': '0 4px 12px hsl(var(--glow) / 0.08), 0 2px 4px hsl(var(--foreground) / 0.04)',
        'elevation-3': '0 12px 40px hsl(var(--glow) / 0.15), 0 4px 12px hsl(var(--foreground) / 0.08)',
      },
```

- [ ] **Step 2: Add easing curves**

In `tailwind.config.js`, inside `theme.extend`, add after `transitionDuration`:

```js
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'smooth': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
```

- [ ] **Step 3: Fix hardcoded glow keyframe**

In `tailwind.config.js`, update the existing `glow` keyframe (around line 129) to use CSS variable instead of hardcoded indigo:

```js
        'glow': {
          '0%, 100%': { boxShadow: '0 0 5px hsl(var(--glow) / 0.5)' },
          '50%': { boxShadow: '0 0 20px hsl(var(--glow) / 0.8)' },
        },
```

- [ ] **Step 4: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -5`
Expected: No errors (config is JS, not type-checked, but ensures no syntax issues block builds).

- [ ] **Step 5: Commit**

```bash
git add tailwind.config.js
git commit -m "config: add elevation shadows, easing curves, fix glow keyframe"
```

---

### Task 2: CSS Tokens — New Variables, Streaming Cursor, Ambient Gradient

**Files:**
- Modify: `src/index.css`

**Why:** New CSS custom properties (`--glow`, `--accent-secondary`, `--surface-elevated`, `--surface-sunken`) must exist before themes.ts or components reference them.

- [ ] **Step 1: Add new tokens to `:root` (light theme)**

In `src/index.css`, inside the `:root` block (after `--info-foreground` around line 42), add:

```css
    /* Design Evolution tokens */
    --accent-secondary: 210 80% 60%;
    --glow: 211 100% 50%;
    --surface-elevated: 0 0% 100%;
    --surface-sunken: 220 13% 93%;
```

- [ ] **Step 2: Add new tokens to `.dark` block**

In `src/index.css`, inside the `.dark` block (after `--info-foreground` around line 80), add:

```css
    /* Design Evolution tokens */
    --accent-secondary: 210 80% 60%;
    --glow: 211 100% 50%;
    --surface-elevated: 222 47% 16%;
    --surface-sunken: 222 47% 9%;
```

- [ ] **Step 3: Update `--radius`**

In `src/index.css`, change the `--radius` value in `:root` (line 27):

```css
    --radius: 0.75rem;
```

- [ ] **Step 4: Update streaming cursor to use theme tokens**

Replace the hardcoded streaming cursor colors (around line 215):

```css
.streaming-cursor > :last-child::after,
.streaming-cursor > :last-child > li:last-child::after {
  content: '';
  display: inline-block;
  width: 2px;
  height: 1em;
  background: linear-gradient(to top, hsl(var(--glow)), hsl(var(--accent-secondary)));
  border-radius: 9999px;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: streaming-blink 1s ease-in-out infinite;
}
```

- [ ] **Step 5: Add ambient background gradient**

After the streaming cursor block, add:

```css
/* Ambient background glow — subtle theme-colored wash */
body::before {
  content: '';
  position: fixed;
  top: 0;
  right: 0;
  width: 60%;
  height: 60%;
  background: radial-gradient(ellipse at top right, hsl(var(--glow) / 0.03), transparent 60%);
  pointer-events: none;
  z-index: 0;
}

.dark body::before {
  background: radial-gradient(ellipse at top right, hsl(var(--glow) / 0.05), transparent 60%);
}
```

- [ ] **Step 6: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/index.css
git commit -m "config: add design evolution CSS tokens, themed streaming cursor, ambient glow"
```

---

### Task 3: Theme Definitions — New Tokens + Silos Dark Warm Shift

**Files:**
- Modify: `src/lib/themes.ts`

**Why:** All 5 themes need the 4 new token values (light + dark), and the Silos dark palette gets its warm hue shift.

- [ ] **Step 1: Add new tokens to `ThemeColors` interface**

In `src/lib/themes.ts`, add 4 new properties to the `ThemeColors` interface (after `--info-foreground`, around line 31):

```typescript
  '--accent-secondary': string;
  '--glow': string;
  '--surface-elevated': string;
  '--surface-sunken': string;
```

- [ ] **Step 2: Add tokens to Default theme (light + dark)**

In the `defaultTheme` object, add to `light` (after `--info-foreground`):

```typescript
    '--accent-secondary': '210 80% 60%',
    '--glow': '211 100% 50%',
    '--surface-elevated': '0 0% 100%',
    '--surface-sunken': '220 13% 93%',
```

And to `dark`:

```typescript
    '--accent-secondary': '210 80% 60%',
    '--glow': '211 100% 50%',
    '--surface-elevated': '222 47% 16%',
    '--surface-sunken': '222 47% 9%',
```

- [ ] **Step 3: Add tokens to Midnight theme**

Light:
```typescript
    '--accent-secondary': '300 70% 65%',
    '--glow': '271 91% 65%',
    '--surface-elevated': '275 35% 99%',
    '--surface-sunken': '270 30% 91%',
```

Dark:
```typescript
    '--accent-secondary': '300 70% 65%',
    '--glow': '271 91% 65%',
    '--surface-elevated': '270 50% 14%',
    '--surface-sunken': '268 55% 6%',
```

- [ ] **Step 4: Add tokens to Silos theme + apply dark warm shift**

Light:
```typescript
    '--accent-secondary': '30 90% 55%',
    '--glow': '16 100% 60%',
    '--surface-elevated': '0 0% 100%',
    '--surface-sunken': '220 15% 93%',
```

Dark (new tokens + warm shift on existing values):
```typescript
    '--accent-secondary': '30 90% 55%',
    '--glow': '16 100% 60%',
    '--surface-elevated': '248 16% 16%',
    '--surface-sunken': '250 18% 7%',
```

Also update these existing Silos dark values for the warm shift:
```
'--background': '250 18% 9%',        (was '240 20% 10%')
'--card': '248 16% 13%',             (was '240 18% 14%')
'--muted': '248 14% 17%',            (was '240 15% 18%')
'--border': '248 12% 20%',           (was '240 15% 19%')
'--sidebar-bg': '250 18% 11%',       (was '240 20% 12%')
'--sidebar-hover': '248 14% 17%',    (was '240 15% 18%')
'--sidebar-border': '248 12% 16%',   (was '240 15% 16%')
'--foreground': '240 10% 95%',       (was '220 20% 95%')
'--muted-foreground': '245 10% 58%', (was '220 15% 55%')
```

- [ ] **Step 5: Add tokens to Sunset theme**

Light:
```typescript
    '--accent-secondary': '25 95% 53%',
    '--glow': '38 92% 50%',
    '--surface-elevated': '35 35% 99%',
    '--surface-sunken': '35 35% 90%',
```

Dark:
```typescript
    '--accent-secondary': '25 95% 53%',
    '--glow': '38 92% 50%',
    '--surface-elevated': '28 45% 13%',
    '--surface-sunken': '25 50% 5%',
```

- [ ] **Step 6: Add tokens to Rose theme**

Light:
```typescript
    '--accent-secondary': '350 80% 65%',
    '--glow': '330 81% 60%',
    '--surface-elevated': '345 30% 99%',
    '--surface-sunken': '340 30% 91%',
```

Dark:
```typescript
    '--accent-secondary': '350 80% 65%',
    '--glow': '330 81% 60%',
    '--surface-elevated': '340 40% 13%',
    '--surface-sunken': '338 45% 6%',
```

- [ ] **Step 7: Verify TypeScript compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -10`
Expected: No errors. The interface change will cause errors if any theme object is missing the new properties.

- [ ] **Step 8: Commit**

```bash
git add src/lib/themes.ts
git commit -m "config: add design tokens to all themes, warm shift for Silos dark"
```

---

### Task 4: UI Base Components — Shadows, Radius, Focus, Haptic

**Files:**
- Modify: `src/components/ui/button.tsx`
- Modify: `src/components/ui/card.tsx`
- Modify: `src/components/ui/input.tsx`
- Modify: `src/components/ui/textarea.tsx`
- Modify: `src/components/ui/select.tsx`
- Modify: `src/components/ui/dialog.tsx`
- Modify: `src/components/ui/toast.tsx`
- Modify: `src/components/ui/tabs.tsx`
- Modify: `src/components/ui/badge.tsx`
- Modify: `src/components/ui/tooltip.tsx`
- Modify: `src/components/ui/switch.tsx`
- Modify: `src/components/ui/dropdown-menu.tsx`

**Why:** These are the building blocks used everywhere. Updating them propagates changes across the entire app.

- [ ] **Step 1: Update button.tsx**

Changes:
- `rounded-md` → `rounded-lg`
- Add `active:scale-[0.97]` to base classes
- Default variant: `bg-primary` → `bg-gradient-to-b from-primary to-primary/90 shadow-elevation-1 hover:shadow-elevation-2`
- Add focus glow: append `focus-visible:shadow-[0_0_12px_hsl(var(--glow)_/_0.15)]`

- [ ] **Step 2: Update card.tsx**

Changes:
- `rounded-lg` → `rounded-xl`
- `shadow-sm` → `shadow-elevation-1`
- `border` → `border border-border/60`

Note: Do NOT add hover effects to the base Card component — not all cards should lift. Hover effects will be added per-component where appropriate (AgentCard, etc.).

- [ ] **Step 3: Update input.tsx**

Changes:
- `rounded-md` → `rounded-lg`
- Add `shadow-elevation-0`
- Add `focus-visible:shadow-[0_0_12px_hsl(var(--glow)_/_0.15)]`

- [ ] **Step 4: Update textarea.tsx**

Changes:
- `ring-indigo-500/50` → `ring-ring`
- `border-indigo-500/50` → `border-ring`
- Add `shadow-elevation-0`

- [ ] **Step 5: Update select.tsx**

Changes:
- `ring-indigo-500/50` → `ring-ring` (trigger focus)
- `border-indigo-500/50` → `border-ring` (trigger focus)
- `text-indigo-500` → `text-primary` (check icon, line 178)
- Content: `shadow-xl` → `shadow-elevation-2`, add `rounded-xl` if not present

- [ ] **Step 6: Update dialog.tsx**

Changes:
- Content: `rounded-xl` → `rounded-2xl`, `shadow-2xl` → `shadow-elevation-3`
- Overlay: `bg-black/80` → `bg-black/60`

- [ ] **Step 7: Update toast.tsx**

Changes:
- `rounded-lg` → `rounded-xl`
- `shadow-lg` → `shadow-elevation-2`

- [ ] **Step 8: Update tabs.tsx**

Changes:
- TabsList: `rounded-lg` → `rounded-xl`
- TabsTrigger: `rounded-md` → `rounded-lg`, active `shadow-sm` → `shadow-elevation-1`

- [ ] **Step 9: Update badge.tsx**

Changes:
- Warning variant: `yellow-500/10` → `amber-500/10`, `yellow-600` → `amber-600`, `yellow-400` → `amber-400`

- [ ] **Step 10: Update tooltip.tsx**

Changes:
- `shadow-lg` → `shadow-elevation-2`

- [ ] **Step 11: Update switch.tsx**

Changes:
- `ring-indigo-500` → `ring-ring` (line 39)
- `bg-indigo-600` → `bg-primary` (line 41)

- [ ] **Step 12: Update dropdown-menu.tsx**

Changes:
- Content: `shadow-xl` → `shadow-elevation-2`
- Apply any radius bumps consistent with select content

- [ ] **Step 13: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -10`
Expected: No errors.

- [ ] **Step 14: Commit**

```bash
git add src/components/ui/
git commit -m "ui: update base components — elevation shadows, generous radius, focus glow, haptic feedback"
```

---

### Task 5: AppSidebar — Pill Indicator, Shadow, Color Migration

**Files:**
- Modify: `src/components/layout/AppSidebar.tsx`

**Why:** The sidebar is visible on every page. The pill indicator + shadow + color migration is the most impactful single-component change.

- [ ] **Step 1: Add shadow to sidebar container**

Find the `<aside>` tag and add `shadow-elevation-1` alongside the existing `border-r`:

```tsx
<aside className="w-56 flex flex-col h-screen bg-sidebar-bg border-r border-sidebar-border shadow-elevation-1">
```

- [ ] **Step 2: Update nav active state to pill + tint**

Find the NavItem component's active state. Replace:
```
bg-primary text-white shadow-sm
```
With:
```
bg-primary/15 text-primary font-semibold relative before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-4 before:rounded-full before:bg-primary
```

- [ ] **Step 3: Update session active state**

Replace hardcoded blue session active:
```
bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300
```
With:
```
bg-primary/10 text-primary
```

- [ ] **Step 4: Update logo radius**

Find the logo container with `rounded-md` and change to `rounded-xl`.

- [ ] **Step 5: Replace remaining hardcoded colors**

Search for any `indigo-`, `purple-`, `violet-` references in this file and replace per migration rules. Common patterns:
- `bg-blue-500` (agent colors in AgentItem) — these are per-agent hash colors, keep as-is (not theme accent)
- Any `text-indigo-*` → `text-primary`

- [ ] **Step 6: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -5`

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/AppSidebar.tsx
git commit -m "ui: sidebar pill indicator, elevation shadow, theme-aware colors"
```

---

### Task 6: CommandPalette + Remaining Layout

**Files:**
- Modify: `src/components/layout/CommandPalette.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/components/layout/BrowserPanel.tsx`
- Modify: `src/components/layout/FloatingBrowserPanel.tsx`

**Why:** Layout components are seen on every page. Group them for efficiency.

- [ ] **Step 1: Update CommandPalette**

Changes:
- Container: `rounded-xl` → `rounded-2xl`, `shadow-2xl` → `shadow-elevation-3`
- Selected item: `bg-indigo-500/20` → `bg-primary/15`
- Arrow icon: `text-indigo-600 dark:text-indigo-400` → `text-primary`
- Agent icon bg: `bg-purple-500/20 text-purple-600 dark:text-purple-400` → `bg-primary/15 text-primary`

- [ ] **Step 2: Migrate Sidebar.tsx colors**

Replace all `indigo-`, `purple-`, `violet-` references with theme tokens per migration rules. This is the legacy sidebar — apply same patterns as AppSidebar.

- [ ] **Step 3: Migrate BrowserPanel.tsx and FloatingBrowserPanel.tsx**

Replace any hardcoded accent colors with theme tokens.

- [ ] **Step 4: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -5`

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/
git commit -m "ui: migrate layout components to theme tokens"
```

---

### Task 7: ChatView — Streaming Cursor, Avatar, Message Animations

**Files:**
- Modify: `src/components/views/ChatView.tsx`

**Why:** ChatView has the most hardcoded colors (~36 instances) and is the primary user-facing component. It also gets the message entrance animation.

- [ ] **Step 1: Migrate assistant avatar gradient**

Find the MessageAvatar or avatar section. Replace:
```
from-indigo-500 to-indigo-600
```
or similar indigo gradients with:
```
from-primary to-accent
```

Replace `from-indigo-400 to-indigo-600` → `from-primary to-accent` for any alternate avatar gradient.

- [ ] **Step 2: Migrate shadows**

Replace all `shadow-indigo-500/XX` and `shadow-purple-500/XX` and `shadow-cyan-500/XX` patterns.
Use `shadow-elevation-1` for base, `shadow-elevation-2` for hover, or remove colored shadows where elevation system covers it.

- [ ] **Step 3: Migrate text and background colors**

Apply migration rules to all remaining hardcoded colors:
- `text-indigo-*` → `text-primary`
- `bg-indigo-*/XX` → `bg-primary/XX`
- `text-purple-*` → `text-primary` (where it's accent, not status)
- `bg-purple-*` → `bg-primary/*`
- `from-purple-500 via-violet-500 to-fuchsia-600` → `from-primary via-accent to-[hsl(var(--accent-secondary))]`

Keep semantic colors: `green-500` (online), `red-500` (error), `amber-500` (warning), `cyan-500` (subagent).

- [ ] **Step 4: Migrate wave bar colors**

Find TypingIndicator wave bars with `bg-purple-400` or `bg-indigo-400`, replace with `bg-primary/60`.

- [ ] **Step 5: Add user message entrance animation**

Find the MessageBubble render for user messages (`msg.role === 'user'`). Add to the container div:

```
animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-300
```

- [ ] **Step 6: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -5`

- [ ] **Step 7: Commit**

```bash
git add src/components/views/ChatView.tsx
git commit -m "ui: ChatView theme migration — avatar, shadows, message animations"
```

---

### Task 8: Auth Pages — LoginPage + ConnectPage

**Files:**
- Modify: `src/components/views/LoginPage.tsx`
- Modify: `src/components/views/ConnectPage.tsx`

**Why:** These share identical patterns. The login is the first impression — it should use theme colors.

- [ ] **Step 1: Update LoginPage**

Changes:
- Logo gradient: `from-indigo-600 to-purple-600` → `from-primary to-[hsl(var(--accent-secondary))]`
- Background glow blobs: `bg-indigo-600/20` → `bg-[hsl(var(--glow)_/_0.2)]`, `bg-purple-600/10` → `bg-[hsl(var(--accent-secondary)_/_0.1)]`
- Submit button: `bg-indigo-600 hover:bg-indigo-500` → `bg-primary hover:bg-primary/90`
- Focus rings: `focus:ring-indigo-500` → `focus:ring-ring`, `focus:border-indigo-500` → `focus:border-ring`
- Loading spinner border: `border-indigo-500` → `border-primary`

- [ ] **Step 2: Update ConnectPage with same pattern**

Apply identical replacements as LoginPage.

- [ ] **Step 3: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -5`

- [ ] **Step 4: Commit**

```bash
git add src/components/views/LoginPage.tsx src/components/views/ConnectPage.tsx
git commit -m "ui: auth pages — theme-aware gradients, buttons, focus rings"
```

---

### Task 9: Dashboard Views — UnifiedDashboard, SessionDetail, Agents, Settings, Tasks, Sessions

**Files:**
- Modify: `src/components/views/UnifiedDashboard.tsx`
- Modify: `src/components/views/SessionDetailView.tsx`
- Modify: `src/components/views/AgentsView.tsx`
- Modify: `src/components/views/SettingsPage.tsx`
- Modify: `src/components/views/TasksPage.tsx`
- Modify: `src/components/views/SessionsPage.tsx`

**Why:** These are the main dashboard pages. Group them since they all follow the same migration pattern.

- [ ] **Step 1: Update UnifiedDashboard**

Changes:
- Divider: `via-violet-500/30` → `via-primary/20`
- Stat icon backgrounds: `bg-violet-500/12` → `bg-primary/10`, same for `bg-blue-500/12`, `bg-amber-500/12`, `bg-cyan-500/12`, `bg-emerald-500/12` — keep semantic ones (amber, cyan, emerald), migrate violet/blue used as accent
- Chart bar fill: `"#7c3aed"` → use `hsl(var(--primary))` or pass the CSS variable value. Since Recharts needs a string color, use: `fill="hsl(var(--primary))"` or compute it from the theme.

- [ ] **Step 2: Update SessionDetailView**

Changes:
- Avatar bg: `bg-violet-500/10` → `bg-primary/10`
- Border: `border-violet-500/25` → `border-primary/20`
- Active model: `bg-indigo-500/10 text-indigo-600 dark:text-indigo-400` → `bg-primary/10 text-primary`

- [ ] **Step 3: Update AgentsView**

Changes:
- Empty state: `bg-indigo-500/10 text-indigo-500` → `bg-primary/10 text-primary`
- Button: `bg-indigo-600 hover:bg-indigo-700` → `bg-primary hover:bg-primary/90`

- [ ] **Step 4: Update SettingsPage**

Changes:
- Focus: `border-teal-500/50` → `border-ring`
- Tags: `bg-teal-500/15 text-teal-600 dark:text-teal-300` → `bg-primary/15 text-primary`
- Active options: `bg-teal-500/20 text-teal-600 dark:text-teal-300 border-teal-500/40` → `bg-primary/20 text-primary border-primary/40`

- [ ] **Step 5: Update TasksPage**

Apply generic migration rules — replace all `indigo-`, `purple-`, `violet-`, `teal-` used as accent with `primary` tokens.

- [ ] **Step 6: Update SessionsPage**

Apply generic migration rules — replace hardcoded accent colors.

- [ ] **Step 7: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -5`

- [ ] **Step 8: Commit**

```bash
git add src/components/views/
git commit -m "ui: dashboard views — complete theme token migration"
```

---

### Task 10: Agent Components — Color Migration (13 files)

**Files:**
- Modify: `src/components/agents/AgentCard.tsx`
- Modify: `src/components/agents/shared.tsx`
- Modify: `src/components/agents/AgentDetailView.tsx`
- Modify: `src/components/agents/MemoryTab.tsx`
- Modify: `src/components/agents/SkillsPanel.tsx`
- Modify: `src/components/agents/TaskDetailModal.tsx`
- Modify: `src/components/agents/SettingsTab.tsx`
- Modify: `src/components/agents/PersonaTab.tsx`
- Modify: `src/components/agents/AgentConfigEditor.tsx`
- Modify: `src/components/agents/BrainPanel.tsx`
- Modify: `src/components/agents/AgentToolsPanel.tsx`
- Modify: `src/components/agents/OverviewPanel.tsx`
- Modify: `src/components/agents/ConfigPanel.tsx`
- Modify: `src/components/agents/KnowledgeTab.tsx`
- Modify: `src/components/agents/KnowledgeBrowser.tsx`
- Modify: `src/components/agents/ScheduledPanel.tsx`
- Modify: `src/components/agents/WorkspacePanel.tsx`

**Why:** These files all follow the same pattern — replace hardcoded accent colors with theme tokens. Batch them for efficiency.

- [ ] **Step 1: Update AgentCard.tsx**

Changes:
- Hover border: `border-indigo-500/50` → `border-primary/30`
- Hover shadow: `shadow-indigo-500/5` → `hover:shadow-elevation-2`
- Avatar gradients: each hardcoded gradient → `from-primary to-accent` (or keep variety by using different opacity levels of primary)
- Chat button: `bg-indigo-600 hover:bg-indigo-700` → `bg-primary hover:bg-primary/90`
- Card: `rounded-xl` → `rounded-2xl`
- Add hover lift: `hover:-translate-y-0.5 transition-all duration-200`
- Add stagger entrance: accept `index` prop or use CSS for `animate-in fade-in slide-in-from-bottom-2 duration-300`

- [ ] **Step 2: Update shared.tsx**

Changes:
- StatCard colors: `bg-violet-500/10 border-violet-500/20 text-violet-600 dark:text-violet-400` → `bg-primary/10 border-primary/20 text-primary`
- Same for violet value colors: `text-violet-700 dark:text-violet-300` → `text-primary`
- TabButton active: `from-violet-500/20 to-purple-500/20 text-violet-700 dark:text-violet-300 shadow-violet-500/5` → `from-primary/20 to-accent/20 text-primary shadow-elevation-1`
- Badge: `bg-cyan-500` — keep (semantic for subagent)

Note: Keep `cyan`, `emerald`, `amber` stat card variants if they are semantically distinct (sessions=cyan, memory=emerald, etc.). Only migrate when the color is used as generic accent.

- [ ] **Step 3: Batch migrate remaining 11 agent files**

For each file, apply the generic migration rules:

| Pattern | Replacement |
|---|---|
| `bg-indigo-*` | `bg-primary` or `bg-primary/XX` |
| `text-indigo-600`, `dark:text-indigo-400` | `text-primary` |
| `text-violet-600`, `dark:text-violet-400` | `text-primary` |
| `text-purple-600`, `dark:text-purple-400` | `text-primary` |
| `bg-violet-500/XX` | `bg-primary/XX` |
| `border-indigo-500/XX` | `border-primary/XX` |
| `from-indigo-* to-purple-*` | `from-primary to-accent` |

Keep semantic colors: `green`, `red`, `amber`, `cyan`, `emerald`.

Files to process: `AgentDetailView.tsx`, `MemoryTab.tsx`, `SkillsPanel.tsx`, `TaskDetailModal.tsx`, `SettingsTab.tsx`, `PersonaTab.tsx`, `AgentConfigEditor.tsx`, `BrainPanel.tsx`, `AgentToolsPanel.tsx`, `OverviewPanel.tsx`, `ConfigPanel.tsx`, `KnowledgeTab.tsx`, `KnowledgeBrowser.tsx`, `ScheduledPanel.tsx`, `WorkspacePanel.tsx`.

- [ ] **Step 4: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -10`

- [ ] **Step 5: Commit**

```bash
git add src/components/agents/
git commit -m "ui: agent components — complete theme token migration (13 files)"
```

---

### Task 11: Remaining Components — Cron, Modals, Dashboard, Sessions, App

**Files:**
- Modify: `src/components/cron/CronJobCard.tsx`
- Modify: `src/components/modals/AddMemberModal.tsx`
- Modify: `src/components/modals/CreateChannelModal.tsx`
- Modify: `src/components/dashboard/AgentAvatar.tsx`
- Modify: `src/components/dashboard/SessionSelector.tsx`
- Modify: `src/components/sessions/SessionIntelligenceHeader.tsx`
- Modify: `src/components/sessions/SessionTasksKanban.tsx`
- Modify: `src/components/sessions/WorkspaceExplorer.tsx`
- Modify: `src/components/layout/SessionTasksPanel.tsx`
- Modify: `src/components/cron/CronStatsWidget.tsx`
- Modify: `src/App.tsx`

**Why:** Mop up remaining files with hardcoded colors and non-standard opacities.

- [ ] **Step 1: Update AgentAvatar.tsx**

Changes:
- Placeholder gradient: `from-indigo-500/20 to-purple-500/20` → `from-primary/20 to-accent/20`
- Busy glow: `bg-blue-500/20` → `bg-primary/20`, `text-blue-500` → `text-primary` (when used as accent glow, not status)
- `ai-glow-blue` → ensure this custom class references `--glow` token

- [ ] **Step 2: Update SessionSelector.tsx**

Changes:
- Selected border: `border-indigo-500` → `border-primary`
- Icon selected bg: `bg-indigo-500/20 text-indigo-600 dark:text-indigo-400` → `bg-primary/20 text-primary`
- Gradient: `from-indigo-500/5` → `from-primary/5`

- [ ] **Step 3: Update SessionIntelligenceHeader.tsx**

Changes:
- Surface badge: `bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20` → `bg-primary/10 text-primary border-primary/20`
- Token color: `text-indigo-600 dark:text-indigo-400` → `text-primary`

- [ ] **Step 4: Update CronJobCard.tsx + CronStatsWidget.tsx**

Apply generic migration rules for any hardcoded accent colors. Keep semantic status colors (green=OK, red=error, yellow=skipped, blue=running).

- [ ] **Step 5: Update session components (SessionTasksKanban, WorkspaceExplorer, SessionTasksPanel)**

Apply generic migration rules and opacity standardization.

- [ ] **Step 6: Update modals (AddMemberModal, CreateChannelModal)**

Note: `CreateAgentModal.tsx` was reviewed and has no hardcoded accent colors — skip it.

Apply generic migration rules — replace accent colors.

- [ ] **Step 7: Update App.tsx**

Replace any hardcoded `indigo-`, `purple-`, `violet-` references with theme tokens.

- [ ] **Step 8: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -5`

- [ ] **Step 9: Commit**

```bash
git add src/components/cron/ src/components/modals/ src/components/dashboard/ src/components/sessions/ src/components/layout/SessionTasksPanel.tsx src/App.tsx
git commit -m "ui: remaining components — theme token migration complete"
```

---

### Task 12: Opacity Standardization Pass

**Files:**
- All previously modified files (cross-cutting)

**Why:** Clean up non-standard opacity values to the 7-level scale.

- [ ] **Step 1: Find and replace non-standard opacities**

Run search across all `.tsx` and `.css` files. Use a pattern that matches Tailwind opacity suffixes (preceded by a color class), not numbers like `grid-cols-12`:
```bash
grep -rn '\-[a-z]*-[0-9]*/12\b\|\-[a-z]*-[0-9]*/25\b\|\-[a-z]*-[0-9]*/30\b\|\-[a-z]*-[0-9]*/50\b\|border/30\|border/50\|foreground/25\|foreground/30\|foreground/50\|white/25\|white/30\|white/50\|black/25\|black/30\|black/50' src/ --include="*.tsx" --include="*.css" | grep -v node_modules
```
Or more practically, search for the specific patterns known to exist: `/12`, `/25`, `/30`, `/50` appearing after a color name or `white`/`black`/`foreground`.

Apply replacements:
- `/12` → `/10`
- `/25` → `/20`
- `/30` → `/20`
- `/50` → `/40` or `/60` (use judgment: backgrounds → `/40`, text → `/60`)

Be careful: `/50` in `border-border/50` is fine as `/40`. But `bg-black/50` → `bg-black/40`. `text-white/50` → `text-white/40` or `/60`.

Do NOT touch:
- Color names containing these numbers (e.g., `indigo-500` — the `/500` grep exclusion handles this)
- Opacity values in `bg-black/60` or `bg-black/80` (already standard)

- [ ] **Step 2: Verify compilation**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -5`

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "ui: standardize opacity scale — eliminate /12, /25, /30, /50"
```

---

### Task 13: Typography Cleanup (Phase 1)

**Files:**
- All view and component files (cross-cutting)

**Why:** Eliminate `text-[9px]` — the most impactful typography fix. Full typography scale consolidation (`text-[11px]`/`text-[12px]`/`text-xs` unification) is deferred to a future pass as it requires visual review of each instance to ensure density is preserved.

- [ ] **Step 1: Eliminate text-[9px]**

```bash
grep -rn 'text-\[9px\]' src/ --include="*.tsx"
```

Replace all instances with `text-[10px]`.

- [ ] **Step 2: Verify no visual regressions in tiny text**

The change from 9px to 10px affects badge labels and tiny metadata. Check that these still fit their containers.

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1 | head -5`

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "ui: eliminate text-[9px] — minimum 10px for legibility"
```

---

### Task 14: Full Verification + Hardcoded Color Audit

**Files:** None (verification only)

**Why:** Final pass to ensure no hardcoded accent colors remain and the app compiles cleanly.

- [ ] **Step 1: Run full TypeScript check**

Run: `cd /home/ubuntu/silos && npx tsc --noEmit 2>&1`
Expected: No errors.

- [ ] **Step 2: Audit remaining hardcoded colors**

```bash
grep -rn 'indigo-\|purple-\|violet-\|fuchsia-\|teal-' src/ --include="*.tsx" --include="*.css" | grep -v node_modules | grep -v '\.md'
```

Expected: Zero results, or only results in comments/documentation. If any remain, fix them per migration rules.

- [ ] **Step 3: Build the project**

Run: `cd /home/ubuntu/silos && npm run build 2>&1 | tail -10`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit if any fixes were needed**

```bash
git add -u
git commit -m "fix: address remaining hardcoded colors found in audit"
```

---

### Task 15: Visual Smoke Test

**Why:** Verify the design changes look correct in the browser.

- [ ] **Step 1: Start dev servers**

Use the `silos-dev` skill to start the local development environment.

- [ ] **Step 2: Visual verification checklist**

Open the dashboard and verify:
- [ ] Cards have visible elevation shadows
- [ ] Card radius is visibly more generous than before
- [ ] Buttons have gradient and press feedback (`active:scale`)
- [ ] Sidebar has pill indicator on active nav item
- [ ] Sidebar has subtle shadow (no visible border in dark mode)
- [ ] Streaming cursor uses theme color (not always purple)
- [ ] Login page uses theme colors for logo gradient and glow
- [ ] Chat messages from user have entrance animation
- [ ] Inputs show sunken shadow and focus glow
- [ ] Command palette has updated radius and shadow
- [ ] Switch component uses theme color when checked

- [ ] **Step 3: Test theme switching**

Switch to each theme (Default, Midnight, Silos, Sunset, Rose) and verify:
- [ ] All accent colors change consistently
- [ ] Shadows tint matches the theme
- [ ] Streaming cursor matches the theme
- [ ] No orphaned indigo/purple colors visible

- [ ] **Step 4: Test Silos dark mode specifically**

Switch to Silos theme + dark mode and verify:
- [ ] Background is warm navy (not cold blue)
- [ ] Text is neutral white (not blue-tinted)
- [ ] Ambient glow is visible (subtle orange tint in top-right)

- [ ] **Step 5: Accessibility contrast check**

Verify WCAG AA contrast ratios (4.5:1 minimum for text) for:
- [ ] Muted foreground text on background (warm shift changed both)
- [ ] Text at `/60` opacity on dark backgrounds
- [ ] Dialog overlay at `bg-black/60` — content behind should be sufficiently dimmed

Use browser DevTools (Inspect → color contrast ratio) or an online contrast checker.

- [ ] **Step 6: Fix any visual issues found, commit**

```bash
git add -u
git commit -m "fix: visual adjustments from smoke test"
```
