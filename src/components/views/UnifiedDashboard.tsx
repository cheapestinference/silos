import { useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, Brush } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { useDashboardStore } from '../../store/dashboard-store';
import {
  ExternalLink,
  BookOpen,
  ChevronRight,
  Bot,
  MessageSquare,
  Zap,
  Activity,
  CalendarClock,
} from 'lucide-react';
import useTranslation from '../../i18n';

// ─── OpenClaw Lobster Logo ───────────────────────────────────────────────────
function OpenClawLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="oc-dash" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ff4d4d" />
          <stop offset="100%" stopColor="#991b1b" />
        </linearGradient>
      </defs>
      <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#oc-dash)" />
      <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#oc-dash)" />
      <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#oc-dash)" />
      <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      <circle cx="45" cy="35" r="6" fill="#050810" />
      <circle cx="75" cy="35" r="6" fill="#050810" />
      <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
      <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
    </svg>
  );
}

// ─── WhatsApp Icon ────────────────────────────────────────────────────────────
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="#25D366" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function getDateLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Stat Card ────────────────────────────────────────────────────────────────
function DashStatCard({ icon, value, label, color }: {
  icon: React.ReactNode;
  value: string | number;
  label: string;
  color: string;
}) {
  const colorMap: Record<string, { icon: string }> = {
    violet: {
      icon: 'bg-primary/10 text-primary',
    },
    blue: {
      icon: 'bg-blue-500/10 text-blue-500 dark:text-blue-400',
    },
    amber: {
      icon: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    },
    cyan: {
      icon: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
    },
    emerald: {
      icon: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    },
  };
  const c = colorMap[color] || colorMap.violet;
  return (
    <div className="rounded-xl bg-card border border-border p-4 flex flex-col gap-2 shadow-elevation-1">
      <div className={`w-8 h-8 rounded-lg ${c.icon} flex items-center justify-center`}>
        {icon}
      </div>
      <p className="text-2xl font-bold tracking-tight text-foreground tabular-nums" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>{value}</p>
      <p className="text-[11px] font-medium text-muted-foreground leading-tight">{label}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
export function UnifiedDashboard() {
  const {
    connected,
    loadAll,
    channels,
    gatewayUrl,
    token,
    agents,
    sessions,
    tasks,
    cronJobs,
  } = useDashboardStore();
  const { t } = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    if (connected) {
      loadAll();
    }
  }, [connected, loadAll]);

  // Derive OpenClaw UI URL
  const openClawUiUrl = useMemo(() => {
    if (!gatewayUrl) return null;
    const isLocal = gatewayUrl.includes('localhost') || gatewayUrl.includes('127.0.0.1');
    const isHttps = window.location.protocol === 'https:';
    let base: string;
    if (isLocal && isHttps) {
      base = `${window.location.origin}/openclaw/`;
    } else {
      let httpUrl = gatewayUrl.replace(/^wss?:\/\//, 'http://');
      if (!httpUrl.startsWith('http')) httpUrl = `http://${httpUrl}`;
      base = `${httpUrl}/openclaw/`;
    }
    return token ? `${base}#token=${encodeURIComponent(token)}` : base;
  }, [gatewayUrl, token]);

  // ─── Derived Stats ──────────────────────────────────────────────────────────
  const agentCount = agents?.agents.length || 0;
  const sessionCount = sessions?.sessions.length || 0;
  const runningTasks = tasks.filter(t => t.status === 'running').length;
  const enabledCronJobs = cronJobs.filter(j => j.enabled).length;

  const { totalTokens, activityByDay } = useMemo(() => {
    const allSessions = sessions?.sessions || [];
    let tTotal = 0;

    for (const s of allSessions) {
      tTotal += s.totalTokens || 0;
    }

    // Build histogram from earliest session to today
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    // Find earliest session, but ensure at least 14 days of range
    const minStart = new Date(now);
    minStart.setDate(minStart.getDate() - 13);
    let earliest = minStart;
    for (const s of allSessions) {
      if (s.updatedAt) {
        const d = new Date(s.updatedAt);
        d.setHours(0, 0, 0, 0);
        if (d < earliest) earliest = d;
      }
    }

    const days: { date: Date; dateStr: string; sessions: number; tokens: number; input: number; output: number }[] = [];
    const dayMap = new Map<string, typeof days[number]>();
    const cursor = new Date(earliest);
    while (cursor <= now) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const entry = { date: new Date(cursor), dateStr, sessions: 0, tokens: 0, input: 0, output: 0 };
      days.push(entry);
      dayMap.set(dateStr, entry);
      cursor.setDate(cursor.getDate() + 1);
    }

    for (const s of allSessions) {
      if (!s.updatedAt) continue;
      const sDate = new Date(s.updatedAt).toISOString().slice(0, 10);
      const day = dayMap.get(sDate);
      if (day) {
        day.sessions++;
        day.tokens += s.totalTokens || 0;
        day.input += s.inputTokens || 0;
        day.output += s.outputTokens || 0;
      }
    }

    return { totalTokens: tTotal, activityByDay: days };
  }, [sessions]);

  const hasActivity = activityByDay.some(d => d.tokens > 0);

  // ═══════════════════════════════════════════════════════════════════════════════
  return (
    <div className="flex flex-col h-full bg-background overflow-y-auto">
      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="border-b bg-card/80 backdrop-blur-sm">
        <div className="h-[1px] bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
        <div className="px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
                {t('unifiedDashboard.mainPanel')}
              </h1>
              <p className="text-[13px] text-muted-foreground mt-0.5">{t('unifiedDashboard.manageAI')}</p>
            </div>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${connected ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-500 border border-red-500/20'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-400'}`} />
              {connected ? t('unifiedDashboard.gatewayConnected') : t('unifiedDashboard.gatewayDisconnected')}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-h-0 p-4 gap-3">

        {/* ── Row 1: Stat Cards ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <DashStatCard icon={<Bot className="w-4.5 h-4.5" />} value={agentCount} label={t('unifiedDashboard.agents')} color="violet" />
          <DashStatCard icon={<MessageSquare className="w-4.5 h-4.5" />} value={sessionCount} label={t('unifiedDashboard.sessions')} color="blue" />
          <DashStatCard icon={<Zap className="w-4.5 h-4.5" />} value={formatTokens(totalTokens)} label={t('unifiedDashboard.tokens')} color="amber" />
          <DashStatCard icon={<Activity className="w-4.5 h-4.5" />} value={runningTasks} label={t('unifiedDashboard.activeTasks')} color="cyan" />
          <DashStatCard icon={<CalendarClock className="w-4.5 h-4.5" />} value={`${cronJobs.length}`} label={`${t('unifiedDashboard.cronJobs')} · ${enabledCronJobs} ${t('unifiedDashboard.enabled')}`} color="emerald" />
        </div>

        {/* ── Row 2: Chart ─────────────────────────────────────────────────────── */}
        <div className="rounded-xl border bg-card overflow-hidden shadow-elevation-1">
          {hasActivity ? (
            <div className="px-4 pt-4 pb-2">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={activityByDay} barCategoryGap="20%">
                  <XAxis
                    dataKey="dateStr"
                    tickFormatter={(v: string) => {
                      const d = new Date(v + 'T00:00:00');
                      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                    }}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={(v: number) => formatTokens(v)}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={false}
                    tickLine={false}
                    width={45}
                    label={{ value: 'Tokens', angle: -90, position: 'insideLeft', offset: 0, style: { fontSize: 10, fill: 'hsl(var(--muted-foreground))' } }}
                  />
                  <RechartsTooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="bg-popover text-popover-foreground border border-border rounded-lg shadow-xl px-3 py-2.5 text-[11px] space-y-0.5">
                          <p className="font-bold text-xs">{getDateLabel(new Date(d.dateStr + 'T00:00:00'))}</p>
                          <p className="text-muted-foreground">{formatTokens(d.tokens)} tokens · {d.sessions} {t('unifiedDashboard.sessionsLabel')}</p>
                          <div className="flex gap-3 pt-0.5 border-t border-border mt-1">
                            <span className="text-muted-foreground">{t('unifiedDashboard.inputTokensLabel')}: <span className="text-foreground font-medium">{formatTokens(d.input)}</span></span>
                            <span className="text-muted-foreground">{t('unifiedDashboard.outputTokensLabel')}: <span className="text-foreground font-medium">{formatTokens(d.output)}</span></span>
                          </div>
                        </div>
                      );
                    }}
                    cursor={false}
                  />
                  <Bar dataKey="tokens" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                  {activityByDay.length > 14 && (
                    <Brush
                      dataKey="dateStr"
                      height={24}
                      stroke="hsl(var(--border))"
                      fill="hsl(var(--card))"
                      tickFormatter={(v: string) => {
                        const d = new Date(v + 'T00:00:00');
                        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                      }}
                      startIndex={Math.max(0, activityByDay.length - 14)}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8">
              <Activity className="w-8 h-8 text-muted-foreground/20 mb-3" />
              <p className="text-sm text-muted-foreground">{t('unifiedDashboard.noActivityYet')}</p>
            </div>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground/40 px-1 -mt-1">{t('unifiedDashboard.dataDisclaimer')}</p>

        {/* ── Bottom row: OpenClaw + Channels link ─────────────────────────── */}
        <div className="flex gap-3 items-stretch">

        {/* ── OpenClaw Control UI ──────────────────────────────────────────────── */}
        <div className="relative rounded-xl overflow-hidden border border-red-500/20 dark:border-red-800/40 max-w-md">
          <div className="absolute inset-0 bg-gradient-to-br from-red-50 via-orange-50/30 to-rose-50 dark:from-red-950/30 dark:via-orange-950/10 dark:to-rose-950/20" />
          <div className="relative p-5">
            <div className="flex items-start gap-4">
              <div className="shrink-0 w-12 h-12 rounded-2xl bg-gradient-to-br from-red-500/20 to-orange-500/10 border border-red-500/20 flex items-center justify-center">
                <OpenClawLogo className="w-8 h-8" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-bold text-foreground">{t('unifiedDashboard.openClawControlUI')}</h3>
                <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
                  {t('unifiedDashboard.openClawControlUIDesc')}
                </p>
                <div className="flex items-center gap-4 mt-3">
                  <button
                    disabled={!openClawUiUrl}
                    onClick={() => openClawUiUrl && window.open(openClawUiUrl, '_blank')}
                    className="group inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-b from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white font-semibold text-xs disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
                  >
                    <OpenClawLogo className="w-4 h-4 [&_path]:fill-white [&_circle]:fill-white [&_path[stroke]]:stroke-white" />
                    {t('unifiedDashboard.openControlUI')}
                    <ExternalLink className="w-3 h-3 opacity-60 group-hover:opacity-100 transition-opacity" />
                  </button>
                  <a href="https://openclaw.ai/docs" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors">
                    <BookOpen className="w-4 h-4" />
                    {t('unifiedDashboard.documentation')}
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Channels ──────────────────────────────────────────────────────────── */}
        <button
          onClick={() => navigate('/settings/channels')}
          className="rounded-xl border bg-card p-5 flex flex-col gap-3 min-w-[180px] hover:border-foreground/20 transition-colors justify-center shadow-elevation-1"
        >
          <div className="flex items-center justify-between w-full">
            <p className="text-sm font-semibold text-foreground">{t('unifiedDashboard.connectChannels')}</p>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-2 w-full">
            {(() => {
              const accounts = channels?.channelAccounts || {};
              const isConnected = (ch: string) => accounts[ch]?.some(a => a.connected);
              const channelList = [
                { id: 'whatsapp', label: 'WhatsApp', icon: <WhatsAppIcon className="w-4 h-4" />, color: '#25D366' },
                { id: 'telegram', label: 'Telegram', icon: <svg viewBox="0 0 24 24" fill="#229ED9" className="w-4 h-4"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>, color: '#229ED9' },
                { id: 'discord', label: 'Discord', icon: <svg viewBox="0 0 24 24" fill="#5865F2" className="w-4 h-4"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/></svg>, color: '#5865F2' },
                { id: 'slack', label: 'Slack', icon: <svg viewBox="0 0 24 24" className="w-4 h-4"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" fill="#E01E5A"/><path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" fill="#36C5F0"/><path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.164 0a2.528 2.528 0 0 1 2.521 2.522v6.312z" fill="#2EB67D"/><path d="M15.164 18.956a2.528 2.528 0 0 1 2.521 2.522A2.528 2.528 0 0 1 15.164 24a2.528 2.528 0 0 1-2.521-2.522v-2.522h2.521zm0-1.271a2.528 2.528 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.314A2.528 2.528 0 0 1 24 15.164a2.528 2.528 0 0 1-2.522 2.521h-6.314z" fill="#ECB22E"/></svg>, color: '#E01E5A' },
              ];
              return channelList.map(ch => {
                const connected = isConnected(ch.id);
                return (
                  <div key={ch.id} className="flex items-center gap-2.5">
                    <div className={`${connected ? '' : 'opacity-30 grayscale'}`}>{ch.icon}</div>
                    <span className={`text-[12px] ${connected ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>{ch.label}</span>
                    {connected && <span className="w-1.5 h-1.5 rounded-full bg-green-500 ml-auto" />}
                  </div>
                );
              });
            })()}
          </div>
        </button>

        </div>

      </div>

      {/* ── Powered by — pinned to bottom ────────────────────────────────────── */}
      <a
        href="https://cheapestinference.com"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-auto flex items-center justify-center gap-3 py-4 border-t border-border"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="w-6 h-6 flex-shrink-0">
          <defs>
            <linearGradient id="ci-logo" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#818CF8" />
              <stop offset="50%" stopColor="#6366F1" />
              <stop offset="100%" stopColor="#22D3EE" />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="8" fill="url(#ci-logo)" />
          <path d="M19.5 8L12.5 24" stroke="white" strokeWidth="2.8" strokeLinecap="round" />
          <path d="M11 12L7.5 16L11 20" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity=".7" />
          <path d="M21 12L24.5 16L21 20" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity=".7" />
        </svg>
        <span className="text-[13px] text-muted-foreground">{t('unifiedDashboard.poweredBy')} <span className="font-semibold">cheapestinference.com</span></span>
      </a>
    </div>
  );
}
