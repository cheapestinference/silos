# Main Panel Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the basic UnifiedDashboard with a data-rich analytics panel showing stats, activity histogram, compact WhatsApp status, and a featured OpenClaw Control UI card.

**Architecture:** Single component rewrite of `UnifiedDashboard.tsx`. All data comes from the existing Zustand store (no new API calls). Activity histogram uses CSS-only bars derived from session `updatedAt` timestamps. WhatsApp QR flow logic is preserved but collapsed into a compact initial state.

**Tech Stack:** React, TypeScript, Zustand store, Tailwind CSS, lucide-react icons

---

### Task 1: Add i18n Keys

**Files:**
- Modify: `src/i18n/locales/en.json` (unifiedDashboard section, line ~882)
- Modify: `src/i18n/locales/es.json` (unifiedDashboard section, line ~882)
- Modify: `src/i18n/locales/fr.json` (unifiedDashboard section, line ~882)
- Modify: `src/i18n/locales/de.json` (unifiedDashboard section, line ~882)

**Step 1: Add new keys to en.json**

Add inside the `"unifiedDashboard"` object:

```json
"manageAI": "Manage your AI agents",
"gatewayConnected": "Connected",
"gatewayDisconnected": "Disconnected",
"agents": "Agents",
"sessions": "Sessions",
"tokens": "Tokens",
"activeTasks": "Active",
"cronJobs": "Cron Jobs",
"activityLast7Days": "Activity — Last 7 Days",
"sessionsLabel": "sessions",
"tokensLabel": "tokens",
"inputTokensLabel": "Input",
"outputTokensLabel": "Output",
"noActivityYet": "No activity yet",
"openClawControlUI": "OpenClaw Control UI",
"openClawControlUIDesc": "The official control panel with all advanced options: agents, channels, models, sessions, logs, and full configuration.",
"openControlUI": "Open Control UI",
"moreChannels": "More channels",
"enabled": "enabled"
```

Note: `manageAI` replaces the existing key (was singular, now plural).

**Step 2: Update es.json**

```json
"manageAI": "Gestiona tus agentes IA",
"gatewayConnected": "Conectado",
"gatewayDisconnected": "Desconectado",
"agents": "Agentes",
"sessions": "Sesiones",
"tokens": "Tokens",
"activeTasks": "Activas",
"cronJobs": "Cron Jobs",
"activityLast7Days": "Actividad — Últimos 7 días",
"sessionsLabel": "sesiones",
"tokensLabel": "tokens",
"inputTokensLabel": "Entrada",
"outputTokensLabel": "Salida",
"noActivityYet": "Sin actividad todavía",
"openClawControlUI": "OpenClaw Control UI",
"openClawControlUIDesc": "El panel de control oficial con todas las opciones avanzadas: agentes, canales, modelos, sesiones, logs y configuración completa.",
"openControlUI": "Abrir Control UI",
"moreChannels": "Más canales",
"enabled": "activos"
```

**Step 3: Update fr.json**

```json
"manageAI": "Gérez vos agents IA",
"gatewayConnected": "Connecté",
"gatewayDisconnected": "Déconnecté",
"agents": "Agents",
"sessions": "Sessions",
"tokens": "Tokens",
"activeTasks": "Actives",
"cronJobs": "Cron Jobs",
"activityLast7Days": "Activité — 7 derniers jours",
"sessionsLabel": "sessions",
"tokensLabel": "tokens",
"inputTokensLabel": "Entrée",
"outputTokensLabel": "Sortie",
"noActivityYet": "Pas encore d'activité",
"openClawControlUI": "OpenClaw Control UI",
"openClawControlUIDesc": "Le panneau de contrôle officiel avec toutes les options avancées : agents, canaux, modèles, sessions, logs et configuration complète.",
"openControlUI": "Ouvrir Control UI",
"moreChannels": "Plus de canaux",
"enabled": "actifs"
```

**Step 4: Update de.json**

```json
"manageAI": "Verwalten Sie Ihre KI-Agenten",
"gatewayConnected": "Verbunden",
"gatewayDisconnected": "Getrennt",
"agents": "Agenten",
"sessions": "Sitzungen",
"tokens": "Tokens",
"activeTasks": "Aktiv",
"cronJobs": "Cron Jobs",
"activityLast7Days": "Aktivität — Letzte 7 Tage",
"sessionsLabel": "Sitzungen",
"tokensLabel": "Tokens",
"inputTokensLabel": "Eingabe",
"outputTokensLabel": "Ausgabe",
"noActivityYet": "Noch keine Aktivität",
"openClawControlUI": "OpenClaw Control UI",
"openClawControlUIDesc": "Das offizielle Kontrollpanel mit allen erweiterten Optionen: Agenten, Kanäle, Modelle, Sitzungen, Logs und vollständige Konfiguration.",
"openControlUI": "Control UI öffnen",
"moreChannels": "Weitere Kanäle",
"enabled": "aktiv"
```

**Step 5: Commit**

```bash
git add src/i18n/locales/*.json
git commit -m "feat: add i18n keys for main panel redesign"
```

---

### Task 2: Rewrite UnifiedDashboard — Header + Stat Cards + Histogram

**Files:**
- Modify: `src/components/views/UnifiedDashboard.tsx` (complete rewrite of render section)

This is the main task. The component keeps all existing WhatsApp QR logic but the render output changes completely.

**Step 1: Add new imports and data derivation**

At the top, add to the store destructuring: `agents`, `sessions`, `tasks`, `cronJobs`.

Add a `useMemo` that derives:
- `totalTokens` — sum of `totalTokens` from all sessions
- `totalInput` — sum of `inputTokens`
- `totalOutput` — sum of `outputTokens`
- `runningTasks` — tasks with status `'running'`
- `enabledCronJobs` — cronJobs with `enabled === true`
- `activityByDay` — group sessions by day (from `updatedAt`), last 7 days. Each day: `{ date: string, sessions: number, tokens: number, input: number, output: number }`. Days with no sessions get zeros.

Helper for formatting tokens: `formatTokens(n: number)` → "0", "1.2K", "3.4M" etc.

**Step 2: Rewrite the return JSX**

Structure:

```tsx
<div className="flex flex-col h-full bg-background overflow-y-auto">
  {/* Header */}
  <div className="px-6 py-5 border-b bg-card shadow-sm">
    <div className="flex items-center justify-between">
      <div>
        <h1>Panel Principal</h1>
        <p>Gestiona tus agentes IA</p>
      </div>
      {/* Gateway status indicator */}
      <div className="flex items-center gap-2">
        <span className={connected dot green/red} />
        <span>{connected ? t('gatewayConnected') : t('gatewayDisconnected')}</span>
      </div>
    </div>
  </div>

  <div className="p-6 space-y-6 max-w-5xl">
    {/* Stat Cards Row */}
    <div className="grid grid-cols-5 gap-3">
      {/* Each card: icon + value + label */}
      StatCard: Bot icon, agents count, "Agents"
      StatCard: MessageSquare icon, sessions count, "Sessions"
      StatCard: Zap icon, formatted total tokens, "Tokens"
      StatCard: Activity icon, running tasks count, "Active"
      StatCard: CalendarClock icon, cronJobs count + badge, "Cron Jobs"
    </div>

    {/* Activity Histogram */}
    <div className="rounded-xl border bg-card p-5">
      <h3>Activity — Last 7 Days</h3>
      <div className="flex items-end gap-1.5 h-32 mt-4">
        {activityByDay.map(day => (
          <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
            <div /* bar */ style={{ height: `${percentage}%` }}
                 className="w-full rounded-t bg-violet-500/80 min-h-[2px] relative group">
              {/* Tooltip on hover */}
              <div className="tooltip hidden group-hover:block">
                date, sessions, tokens
              </div>
            </div>
            <span /* day label */ className="text-[10px]">Mon</span>
          </div>
        ))}
      </div>
      {/* Summary row */}
      <div className="flex gap-6 mt-4 pt-3 border-t text-xs text-muted-foreground">
        <span>42 sessions</span>
        <span>Input: 1.2M</span>
        <span>Output: 340K</span>
      </div>
    </div>

    {/* WhatsApp Compact */}
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <WhatsAppIcon />
          <status dot + label>
          <account name if connected>
        </div>
        <div className="flex items-center gap-2">
          {!waConnected && <Button onClick={handleWaConnect}>Connect</Button>}
          <button onClick={() => navigate('/settings/channels')}>More channels</button>
        </div>
      </div>
      {/* QR flow — same existing JSX, shown when active */}
      {(askingPhone || qrDataUrl || qrMessage || qrError) && (
        <div className="mt-4 pt-4 border-t">
          ... existing QR flow JSX ...
        </div>
      )}
    </div>

    {/* OpenClaw Control UI — Featured Card */}
    <div className="rounded-xl border-2 border-red-200 dark:border-red-900/40
                    bg-gradient-to-r from-red-50 to-orange-50
                    dark:from-red-950/20 dark:to-orange-950/20 p-6">
      <div className="flex items-center gap-5">
        <OpenClawLogo className="w-16 h-16 shrink-0" />
        <div className="flex-1">
          <h3 className="font-bold text-lg">OpenClaw Control UI</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {t('openClawControlUIDesc')}
          </p>
          <div className="flex items-center gap-3 mt-4">
            <button /* primary red button */ onClick={open openClawUiUrl}>
              Open Control UI →
            </button>
            <a href="https://openclaw.ai/docs" /* secondary link */>
              Documentation
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
```

**Step 3: Verify build**

```bash
cd /home/ubuntu/silos && npx tsc --noEmit
```

Expected: no errors.

**Step 4: Verify visual in browser**

Open `http://195.201.110.94:3001/` and confirm:
1. Header shows plural subtitle + gateway status
2. 5 stat cards with real data
3. Histogram renders with bars (even if some days empty)
4. WhatsApp is compact
5. OpenClaw card is prominent with branding

**Step 5: Commit**

```bash
git add src/components/views/UnifiedDashboard.tsx
git commit -m "feat: redesign main panel with stats, histogram, and featured OpenClaw card"
```

---

### Task 3: Polish and Responsive

**Files:**
- Modify: `src/components/views/UnifiedDashboard.tsx`

**Step 1: Handle edge cases**

- Empty state: no sessions → histogram shows "No activity yet" message
- No agents → stat card shows 0
- Gateway disconnected → stat cards show "--" or last known values
- Stat cards grid: on small screens, use `grid-cols-3` + `grid-cols-2` breakpoints

**Step 2: Ensure dark mode works**

Check all gradient backgrounds, borders, and text colors have dark: variants.

**Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add src/components/views/UnifiedDashboard.tsx
git commit -m "fix: main panel edge cases and responsive layout"
```

---

## Execution Notes

- The WhatsApp QR flow logic (~150 lines of state + handlers) stays untouched. Only the JSX wrapping it changes from full-width card to compact collapsible.
- `OpenClawLogo` and `WhatsAppIcon` SVG components at the top of the file stay as-is.
- The `openClawUiUrl` useMemo stays as-is.
- No new dependencies needed.
