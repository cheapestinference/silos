# Theme System — Design Spec

## Goal

Add curated color themes to the Silos dashboard. Each theme defines a full palette for both light and dark modes. The existing light/dark toggle continues to work independently.

## Themes

5 curated themes, each with light + dark variants:

1. **Default** — Current blue accent (backward compatible)
2. **Midnight** — Purple/violet deep tones
3. **Forest** — Emerald green
4. **Sunset** — Warm orange/amber
5. **Rose** — Pink/fuchsia

## Architecture

### Theme definitions: `src/lib/themes.ts`

Each theme is an object with HSL values for every CSS variable used in `index.css`:

```ts
interface ThemeColors {
  '--background': string;
  '--foreground': string;
  '--card': string;
  '--card-foreground': string;
  '--primary': string;
  '--primary-foreground': string;
  '--secondary': string;
  '--secondary-foreground': string;
  '--muted': string;
  '--muted-foreground': string;
  '--accent': string;
  '--accent-foreground': string;
  '--destructive': string;
  '--destructive-foreground': string;
  '--border': string;
  '--input': string;
  '--ring': string;
  '--sidebar-bg': string;
  '--sidebar-fg': string;
  '--sidebar-hover': string;
  '--sidebar-active': string;
  '--sidebar-border': string;
  '--success': string;
  '--warning': string;
  '--info': string;
}

interface Theme {
  id: string;
  name: string;
  light: ThemeColors;
  dark: ThemeColors;
}
```

The "Default" theme's values match the current `index.css` exactly — zero visual change for existing users.

### Application: `src/lib/apply-theme.ts`

A pure function `applyTheme(themeId: string, isDark: boolean)` that:

1. Looks up the theme by id from the themes array
2. Picks the `light` or `dark` variant based on `isDark`
3. Sets each CSS variable on `document.documentElement.style`

Called from:
- `setDarkMode()` action (already toggles dark class — add `applyTheme` call)
- Store initialization (apply persisted theme on load)
- New `setTheme()` action

### Store changes: `dashboard-store.ts`

Add to interface + initial state + persist:
- `theme: string` (default: `'default'`)
- `setTheme: (themeId: string) => void`

The `setTheme` action calls `applyTheme(themeId, get().darkMode)` and persists.
The `setDarkMode` action also calls `applyTheme(get().theme, dark)`.

### UI: `SettingsPage.tsx` AppearanceSection

Replace the current simple light/dark toggle with:

1. **Theme picker** — Grid of theme cards (2-3 per row). Each card shows a small color preview (primary, background, accent as colored rectangles). Selected theme has a ring/border highlight.
2. **Light/Dark toggle** — Same as now, below the theme picker.

### What does NOT change

- `index.css` keeps all current CSS variables as-is (they serve as fallback if no theme is applied)
- `tailwind.config.js` unchanged — still references `hsl(var(--background))` etc.
- All components unchanged — they use semantic classes (`bg-background`, `text-primary`)
- Dark mode toggle mechanism unchanged (class-based)

## File changes

| Action | File | What |
|--------|------|------|
| Create | `src/lib/themes.ts` | Theme definitions (5 themes x 2 modes) |
| Create | `src/lib/apply-theme.ts` | `applyTheme()` function |
| Modify | `src/store/dashboard-store.ts` | Add `theme` state, `setTheme` action, persist, wire `applyTheme` into `setDarkMode` and init |
| Modify | `src/components/views/SettingsPage.tsx` | Theme picker UI in AppearanceSection |

## Edge cases

- **First load**: No theme in localStorage → `'default'` → `index.css` values apply (no JS override needed)
- **Invalid theme in localStorage**: Fall back to `'default'`
- **Theme + dark mode**: They're orthogonal. Changing theme preserves dark/light. Changing dark/light preserves theme.
