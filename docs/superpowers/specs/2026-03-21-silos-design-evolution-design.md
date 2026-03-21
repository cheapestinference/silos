# Silos Dashboard — Design Evolution Spec

> **Goal:** Elevate the Silos dashboard from functional to psychologically pleasurable — consistent theming, depth through shadows, generous radii, subtle gradients, satisfying micro-interactions, and a warm dark mode that reflects the brand.

**Approach:** B — Design Evolution. Evolve existing components without rewriting the base library.

**Tech Stack:** Tailwind CSS 3.4, CSS custom properties, existing shadcn/ui components.

---

## 1. Color System — Token-Driven, No Hardcoded Colors

### Problem
~70 instances of hardcoded `indigo-500`, `purple-600`, `violet-500` etc. across components. Changing the theme has almost no visual effect outside the sidebar.

### New CSS Tokens

Add 5 new tokens to `ThemeColors` interface and all theme definitions in `themes.ts`, plus `:root` / `.dark` in `index.css`:

```
--accent-secondary    Second accent for bi-color gradients
--glow                Shadow tint color (matches primary hue)
--surface-elevated    Elevated card surface (slightly lighter/darker than card)
--surface-sunken      Sunken surface for inputs, progress bars
--streaming-cursor    Streaming cursor color (matches primary)
```

#### Values per theme

| Token | Default (blue) | Silos (orange) | Midnight (purple) | Sunset (amber) | Rose (pink) |
|---|---|---|---|---|---|
| `--accent-secondary` | `210 80% 60%` | `30 90% 55%` | `300 70% 65%` | `25 95% 53%` | `350 80% 65%` |
| `--glow` | `211 100% 50%` | `16 100% 60%` | `271 91% 65%` | `38 92% 50%` | `330 81% 60%` |
| `--surface-elevated` light/dark | `0 0% 100%` / `222 47% 16%` | `0 0% 100%` / `248 16% 16%` | `275 35% 99%` / `270 50% 14%` | `35 35% 99%` / `28 45% 13%` | `345 30% 99%` / `340 40% 13%` |
| `--surface-sunken` light/dark | `220 13% 93%` / `222 47% 9%` | `220 15% 93%` / `250 18% 7%` | `270 30% 91%` / `268 55% 6%` | `35 35% 90%` / `25 50% 5%` | `340 30% 91%` / `338 45% 6%` |
| `--streaming-cursor` | `211 100% 50%` | `16 100% 60%` | `271 91% 65%` | `38 92% 50%` | `330 81% 60%` |

#### Migration rules

| Hardcoded | Replacement |
|---|---|
| `bg-indigo-600`, `bg-indigo-500` | `bg-primary` |
| `bg-indigo-500/XX` | `bg-primary/XX` |
| `text-indigo-600`, `dark:text-indigo-400` | `text-primary` |
| `border-indigo-500/XX` | `border-primary/XX` |
| `ring-indigo-500/50` | `ring-ring` |
| `shadow-indigo-500/XX` | `shadow-[hsl(var(--glow)/0.XX)]` |
| `from-indigo-500 to-indigo-600` | `from-primary to-accent` |
| `from-purple-400 to-fuchsia-400` | via `--streaming-cursor` / `--accent-secondary` |
| `bg-violet-500/XX` (stat icons) | `bg-primary/XX` |
| `#a855f6`, `#d946ef` (CSS) | `hsl(var(--streaming-cursor))`, `hsl(var(--accent-secondary))` |
| `#7c3aed` (chart) | `hsl(var(--primary))` |

#### Semantic exceptions (NOT migrated)
These are universal status colors and remain hardcoded:
- `green-500/600` — success, online
- `red-500/600` — error, offline
- `amber-500/600` — warning
- `cyan-500/600` — subagent indicator (domain-specific semantic)

---

## 2. Shadow & Elevation System

### 4 levels defined in `tailwind.config.js`

```js
boxShadow: {
  'elevation-0': 'inset 0 1px 2px hsl(var(--foreground) / 0.06)',
  'elevation-1': '0 1px 3px hsl(var(--foreground) / 0.06), 0 1px 2px hsl(var(--foreground) / 0.04)',
  'elevation-2': '0 4px 12px hsl(var(--glow) / 0.08), 0 2px 4px hsl(var(--foreground) / 0.04)',
  'elevation-3': '0 12px 40px hsl(var(--glow) / 0.15), 0 4px 12px hsl(var(--foreground) / 0.08)',
}
```

### Component mapping

| Component | Current | Proposed |
|---|---|---|
| Inputs, textarea, select | none | `shadow-elevation-0` |
| Cards (base) | `shadow-sm` | `shadow-elevation-1` |
| Cards (hover) | `hover:shadow-lg` | `hover:shadow-elevation-2` |
| Tooltips | `shadow-lg` | `shadow-elevation-2` |
| Toasts | `shadow-lg` | `shadow-elevation-2` |
| Dropdowns/select content | `shadow-xl` | `shadow-elevation-2` |
| Dialogs/modals | `shadow-2xl` | `shadow-elevation-3` |
| Command palette | `shadow-2xl` | `shadow-elevation-3` |
| Sidebar | `border-r` only | `shadow-elevation-1` (remove border-r) |

---

## 3. Border Radius — Generous & Consistent

### Updated `--radius` scale

```css
:root {
  --radius: 0.75rem;   /* 12px, was 6px */
}
```

Tailwind resolves `rounded-lg` = `var(--radius)` = 12px, `rounded-md` = 10px, `rounded-sm` = 8px.

### Component mapping

| Component | Current | Proposed |
|---|---|---|
| Button | `rounded-md` (4px) | `rounded-lg` (12px) |
| Input | `rounded-md` (4px) | `rounded-lg` (12px) |
| Card | `rounded-lg` (6px) | `rounded-xl` (16px) |
| Dialog | `rounded-xl` (12px) | `rounded-2xl` (24px) |
| Toast | `rounded-lg` (6px) | `rounded-xl` (16px) |
| Agent avatar | `rounded-xl` (12px) | `rounded-2xl` (24px) |
| Tabs list | `rounded-lg` (6px) | `rounded-xl` (16px) |
| Tab trigger | `rounded-md` (4px) | `rounded-lg` (12px) |
| Command palette | `rounded-xl` | `rounded-2xl` |
| Sidebar logo | `rounded-md` (4px) | `rounded-xl` (16px) |
| Chat bubbles | `rounded-2xl` | unchanged |

---

## 4. Typography Scale — Simplified

### Base: 13px (unchanged — Slack-like density)

### Cleaned scale (6 levels)

| Role | Size | Weight | Replaces |
|---|---|---|---|
| Caption | 10px (`text-[10px]`) | `font-medium` | `text-[9px]`, `text-[10px]`, `text-[11px]` |
| Detail | 11px (`text-[11px]`) | `font-medium` / `font-semibold` | `text-[11px]`, `text-[12px]`, `text-xs` |
| Body | 13px (base) | `font-normal` | `text-[13px]`, `text-sm` at 13px |
| Subtitle | 15px (`text-[15px]`) | `font-semibold` | `text-sm font-semibold`, `text-base` |
| Title | 18px (`text-lg`) | `font-bold` | `text-xl`, `text-lg` |
| Display | 24px (`text-2xl`) | `font-bold tracking-tight` | `text-2xl` |

### Rules
- `text-[9px]` is eliminated — minimum is 10px
- Weight contrast compensates for small sizes (Slack pattern)

---

## 5. Gradient System

### 3 gradient types

**Ambient** — Near-invisible color wash on backgrounds:
```css
radial-gradient(ellipse at top right, hsl(var(--glow) / 0.03), transparent 60%)
```
Applied to: main `<main>` area, sidebar (bottom region). In dark mode: 4-5% opacity.

**Surface** — Directional tint on elevated cards:
```css
linear-gradient(135deg, hsl(var(--card)) 0%, hsl(var(--card)) 80%, hsl(var(--glow) / 0.04) 100%)
```
Applied to: card headers, stat panels that need emphasis.

**Accent** — For CTAs, avatars, brand elements:
```css
bg-gradient-to-b from-primary to-primary/90          /* buttons */
bg-gradient-to-br from-primary to-accent              /* avatars */
from-primary to-[hsl(var(--accent-secondary))]        /* login logo */
```

### NOT gradient
- Chat user bubbles (solid `bg-primary`)
- Inputs (solid for clarity)
- Text (no gradient text in dashboard)
- Badges/pills (solid for legibility)

---

## 6. Micro-interactions

### 6.1 Card hover — Lift
```
hover:shadow-elevation-2 hover:-translate-y-0.5 transition-all duration-200 ease-spring
```

### 6.2 Button press — Haptic
Add to `button.tsx` base: `active:scale-[0.97] transition-transform duration-100`

### 6.3 Message send — Pop
User messages: `animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-300`

### 6.4 Card list entrance — Stagger
```tsx
style={{ animationDelay: `${index * 50}ms` }}
className="animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-backwards"
```
Applied to: agent list, session list, cron job list.

### 6.5 Focus glow — Inputs
```
focus-visible:shadow-[0_0_12px_hsl(var(--glow)/0.15)]
```

### 6.6 Sidebar active — Pill indicator
```css
before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2
before:w-[3px] before:h-4 before:rounded-full before:bg-primary
before:transition-all before:duration-200
```
Replace solid `bg-primary text-white` with `bg-primary/15 text-primary font-semibold` + pill.

### Easing curves (add to tailwind.config.js)
```js
transitionTimingFunction: {
  'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  'smooth': 'cubic-bezier(0.4, 0, 0.2, 1)',
}
```

### Duration guide
- 50-100ms: button press, color changes
- 150-200ms: hover effects, focus glow
- 200-300ms: card entrance, slide effects
- 300-500ms: staggered lists, message entrance

---

## 7. Dark Mode — Warm Silos Theme

### Silos dark palette adjustments

| Token | Before | After | Change |
|---|---|---|---|
| `--background` | `240 20% 10%` | `250 18% 9%` | hue 240→250 (warm shift) |
| `--card` | `240 18% 14%` | `248 16% 13%` | warm navy |
| `--muted` | `240 15% 18%` | `248 14% 17%` | warm navy |
| `--border` | `240 15% 19%` | `248 12% 20%` | warm, lower saturation |
| `--sidebar-bg` | `240 20% 12%` | `250 18% 11%` | match background hue |
| `--sidebar-hover` | `240 15% 18%` | `248 14% 17%` | match muted |
| `--sidebar-border` | `240 15% 16%` | `248 12% 16%` | warm |
| `--foreground` | `220 20% 95%` | `240 10% 95%` | neutral white (remove blue tint) |
| `--muted-foreground` | `220 15% 55%` | `245 10% 58%` | neutral warm grey |

Other themes (Default, Midnight, Sunset, Rose) remain unchanged — they already align with their brand hue.

---

## 8. Component-Level Changes

### Base UI components (`src/components/ui/`)

| Component | Changes |
|---|---|
| `button.tsx` | `rounded-md` → `rounded-lg`, add `active:scale-[0.97]`, default variant gets `bg-gradient-to-b from-primary to-primary/90 shadow-elevation-1 hover:shadow-elevation-2`, add focus glow |
| `card.tsx` | `rounded-lg shadow-sm` → `rounded-xl shadow-elevation-1`, add `hover:shadow-elevation-2 hover:-translate-y-0.5 transition-all duration-200`, border → `border-border/60` |
| `input.tsx` | `rounded-md` → `rounded-lg`, add `shadow-elevation-0`, add focus glow |
| `textarea.tsx` | `ring-indigo-500/50` → `ring-ring`, `border-indigo-500/50` → `border-ring`, add `shadow-elevation-0` |
| `select.tsx` | focus `ring-indigo-500/50` → `ring-ring`, check icon `text-indigo-500` → `text-primary`, content `shadow-xl` → `shadow-elevation-2 rounded-xl` |
| `dialog.tsx` | `rounded-xl shadow-2xl` → `rounded-2xl shadow-elevation-3`, overlay `bg-black/80` → `bg-black/60` |
| `toast.tsx` | `rounded-lg shadow-lg` → `rounded-xl shadow-elevation-2` |
| `tabs.tsx` | list `rounded-lg` → `rounded-xl`, trigger `rounded-md` → `rounded-lg`, active `shadow-sm` → `shadow-elevation-1` |
| `badge.tsx` | `warning: yellow-500/10` → `amber-500/10` (consistency) |

### Layout components (`src/components/layout/`)

| Component | Changes |
|---|---|
| `AppSidebar.tsx` | Remove `border-r`, add `shadow-elevation-1`. Nav active: `bg-primary text-white` → `bg-primary/15 text-primary font-semibold` + pill indicator. Session active: `bg-blue-100 dark:bg-blue-500/20` → `bg-primary/10 text-primary`. Logo: `rounded-md` → `rounded-xl` |
| `CommandPalette.tsx` | Selected: `bg-indigo-500/20` → `bg-primary/15`. Arrow: `text-indigo-600` → `text-primary`. Agent icon: `bg-purple-500/20` → `bg-primary/15`. Container: `rounded-xl` → `rounded-2xl`, `shadow-2xl` → `shadow-elevation-3` |

### View components (`src/components/views/`)

| Component | Changes |
|---|---|
| `ChatView.tsx` | Assistant avatar gradient: hardcoded indigo → `from-primary to-accent`. Shadow: `shadow-indigo-500/25` → `shadow-[hsl(var(--glow)/0.2)]`. Streaming cursor: CSS hardcoded → `var(--streaming-cursor)` + `var(--accent-secondary)`. Wave bars: `bg-purple-400` → `bg-primary/60`. User messages: add entrance animation. |
| `UnifiedDashboard.tsx` | Divider: `via-violet-500/30` → `via-primary/20`. Stat icons: `bg-violet-500/12` → `bg-primary/10`. Chart bar: `#7c3aed` → `hsl(var(--primary))` |
| `SessionDetailView.tsx` | Avatar: `bg-violet-500/10` → `bg-primary/10`. Border: `border-violet-500/25` → `border-primary/20`. Active model: `bg-indigo-500/10` → `bg-primary/10` |
| `AgentsView.tsx` | Empty state: `bg-indigo-500/10 text-indigo-500` → `bg-primary/10 text-primary`. Button: `bg-indigo-600` → `bg-primary` |
| `LoginPage.tsx` | Logo gradient: hardcoded → `from-primary to-[hsl(var(--accent-secondary))]`. Glow: `bg-indigo-600/20` → `bg-[hsl(var(--glow)/0.2)]`. Submit: `bg-indigo-600` → `bg-primary`. Focus: `ring-indigo-500` → `ring-ring` |
| `ConnectPage.tsx` | Same pattern as LoginPage |
| `SettingsPage.tsx` | Focus: `border-teal-500/50` → `border-ring`. Tags: `bg-teal-500/15 text-teal-600` → `bg-primary/15 text-primary` |

### Agent components (`src/components/agents/`)

| Component | Changes |
|---|---|
| `AgentCard.tsx` | Hover border: `border-indigo-500/50` → `border-primary/30`. Shadow: `shadow-indigo-500/5` → theme glow. Avatar gradients: hardcoded set → `from-primary/90 to-accent/90`. Chat button: `bg-indigo-600` → `bg-primary`. Card: `rounded-xl` → `rounded-2xl` |

### Dashboard components (`src/components/dashboard/`)

| Component | Changes |
|---|---|
| `AgentAvatar.tsx` | Placeholder gradient: `from-indigo-500/20 to-purple-500/20` → `from-primary/20 to-accent/20`. Busy glow: `bg-blue-500/20` → `bg-primary/20` |
| `SessionSelector.tsx` | Selected border: `border-indigo-500` → `border-primary`. Icon selected: `bg-indigo-500/20 text-indigo-600` → `bg-primary/20 text-primary`. Gradient: `from-indigo-500/5` → `from-primary/5` |

### Global CSS (`src/index.css`)

| Change | Details |
|---|---|
| Streaming cursor | `#a855f6` → `hsl(var(--streaming-cursor))`, `#d946ef` → `hsl(var(--accent-secondary))` |
| Ambient gradient | Add `body::before` pseudo-element with radial gradient using `--glow` |
| Opacity scale | Standardize to `/5`, `/10`, `/20`, `/40`, `/60`, `/80` |

---

## 9. Opacity Scale (Standardized)

Reduce from 10+ opacity levels to 6 perceptually distinct levels:

| Level | Use |
|---|---|
| `/5` | Ambient background tints, very subtle washes |
| `/10` | Status backgrounds, icon containers, stat cards |
| `/20` | Borders, selected states, hover backgrounds |
| `/40` | Scrollbar hover, secondary borders |
| `/60` | Footer icons, disabled text |
| `/80` | Semi-muted text, secondary foreground |

Eliminate: `/12`, `/15`, `/25`, `/30`, `/50` — replace with nearest standard level.

---

## Files Modified (Summary)

### Config
- `tailwind.config.js` — elevation shadows, easing curves, `--radius` update
- `src/index.css` — new tokens, streaming cursor vars, ambient gradient, opacity cleanup
- `src/lib/themes.ts` — 5 new tokens per theme (light+dark), Silos dark warm shift

### UI Base (10 files)
- `src/components/ui/button.tsx`
- `src/components/ui/card.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/textarea.tsx`
- `src/components/ui/select.tsx`
- `src/components/ui/dialog.tsx`
- `src/components/ui/toast.tsx`
- `src/components/ui/tabs.tsx`
- `src/components/ui/badge.tsx`
- `src/components/ui/tooltip.tsx`

### Layout (2 files)
- `src/components/layout/AppSidebar.tsx`
- `src/components/layout/CommandPalette.tsx`

### Views (6 files)
- `src/components/views/ChatView.tsx`
- `src/components/views/UnifiedDashboard.tsx`
- `src/components/views/SessionDetailView.tsx`
- `src/components/views/AgentsView.tsx`
- `src/components/views/LoginPage.tsx`
- `src/components/views/ConnectPage.tsx`
- `src/components/views/SettingsPage.tsx`

### Components (4 files)
- `src/components/agents/AgentCard.tsx`
- `src/components/agents/shared.tsx`
- `src/components/dashboard/AgentAvatar.tsx`
- `src/components/dashboard/SessionSelector.tsx`

**Total: ~24 files modified, 0 new files created.**
