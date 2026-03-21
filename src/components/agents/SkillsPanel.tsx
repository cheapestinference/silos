import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Trash2,
  X as XIcon,
  RefreshCw,
  ExternalLink,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Download,
  Package,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import { useDashboardStore } from '../../store/dashboard-store';

// ClawHub marketplace types
interface ClawHubSearchResult {
  score: number;
  slug: string;
  displayName: string;
  summary: string;
  version: string | null;
  updatedAt: number;
}

interface ClawHubSkillDetail {
  skill: {
    slug: string;
    displayName: string;
    summary: string;
    stats: { comments: number; downloads: number; installsAllTime: number; installsCurrent: number; stars: number; versions: number };
    createdAt: number;
    updatedAt: number;
  };
  latestVersion: { version: string; createdAt: number; changelog: string };
  owner: { handle: string; displayName: string; image: string };
}

// Built-in OpenClaw skills catalog — toolGroup maps to tools.deny entries
const BUILTIN_SKILLS = [
  { id: 'read', name: 'File Read', category: 'Core', description: 'Read file contents from the filesystem', icon: '📄', toolGroup: 'group:fs' },
  { id: 'write', name: 'File Write', category: 'Core', description: 'Write and create files', icon: '✏️', toolGroup: 'group:fs' },
  { id: 'edit', name: 'File Edit', category: 'Core', description: 'Edit files with structured patches', icon: '🔧', toolGroup: 'group:fs' },
  { id: 'exec', name: 'Shell', category: 'Core', description: 'Execute shell commands', icon: '⚡', toolGroup: 'group:runtime' },
  { id: 'process', name: 'Processes', category: 'Core', description: 'Manage background shell sessions', icon: '📟', toolGroup: 'group:runtime' },
  { id: 'sessions_spawn', name: 'Spawn Agent', category: 'Core', description: 'Launch sub-agents for parallel tasks', icon: '🤖', toolGroup: 'group:sessions' },
  { id: 'memory', name: 'Memory', category: 'Core', description: 'Persistent memory across sessions', icon: '🧠', toolGroup: 'group:memory' },
  { id: 'web_search', name: 'Web Search', category: 'Web', description: 'Search the web (requires API key)', icon: '🔍', toolGroup: 'group:web' },
  { id: 'web_fetch', name: 'Web Fetch', category: 'Web', description: 'Fetch and read web page contents', icon: '🌐', toolGroup: 'group:web' },
  { id: 'browser', name: 'Browser', category: 'Web', description: 'Control a headless browser', icon: '🖥️', toolGroup: 'group:ui' },
  { id: 'cron', name: 'Cron Jobs', category: 'Automation', description: 'Schedule recurring tasks', icon: '⏰', toolGroup: 'group:automation' },
  { id: 'lobster', name: 'Workflows', category: 'Automation', description: 'Deterministic pipelines with approvals', icon: '🦞', toolGroup: 'lobster' },
  { id: 'whatsapp', name: 'WhatsApp', category: 'Communication', description: 'Send and receive WhatsApp messages', icon: '💬', toolGroup: 'group:messaging' },
  { id: 'telegram', name: 'Telegram', category: 'Communication', description: 'Telegram bot integration', icon: '📨', toolGroup: 'group:messaging' },
  { id: 'discord', name: 'Discord', category: 'Communication', description: 'Discord bot integration', icon: '🎮', toolGroup: 'group:messaging' },
  { id: 'slack', name: 'Slack', category: 'Communication', description: 'Slack workspace integration', icon: '💼', toolGroup: 'group:messaging' },
  { id: 'email', name: 'Email', category: 'Communication', description: 'Read and send emails', icon: '📧', toolGroup: 'group:messaging' },
  { id: 'nodes', name: 'Devices', category: 'Nodes', description: 'Connected companion devices', icon: '📱', toolGroup: 'group:nodes' },
  { id: 'image', name: 'Image Analysis', category: 'Media', description: 'Analyze images with AI vision', icon: '🖼️', toolGroup: 'group:web' },
  { id: 'tts', name: 'Text-to-Speech', category: 'Media', description: 'Convert text to spoken audio', icon: '🎤', toolGroup: 'group:web' },
];

const BUILTIN_CATEGORIES = ['Core', 'Web', 'Automation', 'Communication', 'Nodes', 'Media'];

export function SkillsPanel() {
  const { id: agentId } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { token, gatewayConfig, patchGatewayConfig } = useDashboardStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ClawHubSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installed, setInstalled] = useState<Array<{ slug: string; name: string; description: string; installedAt: number }>>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClawHubSkillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [togglingSkill, setTogglingSkill] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const authHeaders = useMemo(() => {
    const h: Record<string, string> = {};
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);

  // ─── Per-agent tool deny/alsoAllow (same logic as AgentToolsPanel) ────
  const config = gatewayConfig?.config as Record<string, unknown> | undefined;
  const globalTools = (config?.tools || {}) as Record<string, unknown>;
  const globalDeny = (globalTools.deny || []) as string[];
  const globalAlsoAllow = (globalTools.alsoAllow || []) as string[];
  const agentsCfg = config?.agents as { list?: Array<Record<string, unknown>> } | undefined;
  const agentEntry = agentsCfg?.list?.find((a: Record<string, unknown>) => a.id === agentId);
  const agentTools = (agentEntry?.tools || null) as Record<string, unknown> | null;
  const agentDeny = agentTools ? (agentTools.deny || []) as string[] : null;
  const agentAlsoAllow = agentTools ? (agentTools.alsoAllow || []) as string[] : null;
  const effectiveDeny = agentDeny ?? globalDeny;
  const effectiveAlsoAllow = agentAlsoAllow ?? globalAlsoAllow;

  const isSkillEnabled = (skill: typeof BUILTIN_SKILLS[0]) => {
    if (skill.toolGroup === 'lobster') return effectiveAlsoAllow.includes('lobster');
    return !effectiveDeny.includes(skill.toolGroup);
  };

  const toggleSkill = async (skill: typeof BUILTIN_SKILLS[0]) => {
    setTogglingSkill(true);
    const currentAgentTools = agentTools || { deny: [...globalDeny], alsoAllow: [...globalAlsoAllow] };

    if (skill.toolGroup === 'lobster') {
      const allow = (currentAgentTools.alsoAllow || []) as string[];
      const newAllow = effectiveAlsoAllow.includes('lobster')
        ? allow.filter((a: string) => a !== 'lobster')
        : [...allow, 'lobster'];
      await patchAgentToolsConfig({ ...currentAgentTools, alsoAllow: newAllow });
    } else {
      const deny = (currentAgentTools.deny || []) as string[];
      const enabled = !effectiveDeny.includes(skill.toolGroup);
      const newDeny = enabled ? [...deny, skill.toolGroup] : deny.filter((d: string) => d !== skill.toolGroup);
      // Deduplicate
      await patchAgentToolsConfig({ ...currentAgentTools, deny: [...new Set(newDeny)] });
    }
    setTogglingSkill(false);
  };

  const patchAgentToolsConfig = async (newTools: Record<string, unknown>) => {
    const currentList = (agentsCfg?.list || []) as Array<Record<string, unknown>>;
    const exists = currentList.some(a => a.id === agentId);
    const updatedList = exists
      ? currentList.map(a => a.id === agentId ? { ...a, tools: newTools } : a)
      : [...currentList, { id: agentId, tools: newTools }];
    await patchGatewayConfig({ agents: { ...config?.agents as object, list: updatedList } });
  };

  const loadInstalled = useCallback(async () => {
    try {
      const res = await fetch('/api/skills/list', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setInstalled(data.skills || []);
      }
    } catch { /* ignore */ }
    setLoadingInstalled(false);
  }, [authHeaders]);

  useEffect(() => { loadInstalled(); }, [loadInstalled]);

  // Load ClawHub detail for installed skills
  useEffect(() => {
    if (!selectedId || selectedId.startsWith('builtin:')) { setDetail(null); return; }
    let cancelled = false;
    setLoadingDetail(true);
    fetch(`/api/clawhub/skill?slug=${encodeURIComponent(selectedId)}`, { headers: authHeaders })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) setDetail(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [selectedId, authHeaders]);

  if (!agentId) return null;

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    setCategoryFilter(null);
    setSelectedId(null);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!query.trim()) { setSearchResults([]); return; }
    searchTimeoutRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/clawhub/search?q=${encodeURIComponent(query)}&limit=20`, { headers: authHeaders });
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data.results || (Array.isArray(data) ? data : []));
        }
      } catch { /* ignore */ }
      setSearching(false);
    }, 400);
  };

  const handleInstall = async (slug: string) => {
    setInstalling(slug);
    try {
      await fetch('/api/clawhub/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ slug }),
      });
    } catch { /* ignore */ }
    await loadInstalled();
    setInstalling(null);
  };

  const handleUninstall = async (slug: string) => {
    setUninstalling(slug);
    try {
      await fetch(`/api/skills/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: authHeaders });
    } catch { /* ignore */ }
    await loadInstalled();
    setUninstalling(null);
  };

  const installedSlugs = new Set(installed.map(s => s.slug));

  // Filter built-in by category
  const filteredBuiltin = categoryFilter
    ? BUILTIN_SKILLS.filter(s => s.category === categoryFilter)
    : BUILTIN_SKILLS;

  // Selected built-in skill
  const selectedBuiltin = selectedId?.startsWith('builtin:')
    ? BUILTIN_SKILLS.find(s => s.id === selectedId.replace('builtin:', ''))
    : null;

  // Selected installed skill
  const selectedInstalled = selectedId && !selectedId.startsWith('builtin:')
    ? installed.find(s => s.slug === selectedId)
    : null;

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* Left: Skills list */}
      <div className="flex-1 flex flex-col border-r border-border overflow-hidden">
        <div className="p-4 border-b border-border space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">{t('agentDetail.skillsTitle')}</h3>
            </div>
            <span className="text-[10px] px-2 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary font-semibold">
              {BUILTIN_SKILLS.length} {t('agentDetail.skillsBuiltinCount')} · {installed.length} {t('agentDetail.skillsAddedCount')}
            </span>
          </div>
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder={t('agentDetail.skillsSearchPlaceholder')}
              className={cn("w-full px-3 py-2 pl-9 text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40", searchQuery && "pr-9")}
            />
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">🔍</span>
            {searching && <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground animate-spin" />}
            {searchQuery && !searching && (
              <button
                onClick={() => handleSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <XIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {/* Category filter + back button when searching */}
          <div className="flex flex-wrap gap-1.5">
            {searchQuery ? (
              <>
                <button
                  onClick={() => handleSearch('')}
                  className="px-2 py-1 text-[10px] font-medium rounded-lg border transition-colors bg-primary/15 text-primary border-primary/20"
                >
                  {t('agentDetail.skillsBackToInstalled')}
                </button>
                {['agent', 'automation', 'email', 'git', 'calendar', 'deploy'].map(q => (
                  <button
                    key={q}
                    onClick={() => handleSearch(q)}
                    className={cn(
                      "px-2 py-1 text-[10px] font-medium rounded-lg border transition-colors",
                      searchQuery === q ? "bg-primary/15 text-primary border-primary/20" : "bg-muted text-muted-foreground border-transparent hover:border-border hover:text-foreground"
                    )}
                  >
                    {q}
                  </button>
                ))}
              </>
            ) : (
              <>
                <button
                  onClick={() => setCategoryFilter(null)}
                  className={cn(
                    "px-2 py-1 text-[10px] font-medium rounded-lg border transition-colors",
                    !categoryFilter ? "bg-primary/15 text-primary border-primary/20" : "bg-muted text-muted-foreground border-transparent hover:border-border hover:text-foreground"
                  )}
                >
                  All
                </button>
                {BUILTIN_CATEGORIES.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
                    className={cn(
                      "px-2 py-1 text-[10px] font-medium rounded-lg border transition-colors",
                      categoryFilter === cat ? "bg-primary/15 text-primary border-primary/20" : "bg-muted text-muted-foreground border-transparent hover:border-border hover:text-foreground"
                    )}
                  >
                    {cat}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {/* Default view: built-in + installed */}
          {!searchQuery && (
            <>
              {/* Built-in skills */}
              {filteredBuiltin.map(skill => {
                const enabled = isSkillEnabled(skill);
                return (
                  <button
                    key={skill.id}
                    onClick={() => setSelectedId(`builtin:${skill.id}`)}
                    className={cn(
                      "w-full p-2.5 rounded-lg border transition-all text-left",
                      selectedId === `builtin:${skill.id}`
                        ? "bg-primary/10 border-primary/20"
                        : "bg-card border-border hover:border-primary/20",
                      !enabled && "opacity-50"
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={cn("text-base shrink-0", !enabled && "grayscale")}>{skill.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={cn("text-xs font-semibold truncate", enabled ? "text-foreground" : "text-muted-foreground line-through")}>{skill.name}</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 shrink-0">{t('agentDetail.skillsBuiltinTag')}</span>
                          {!enabled && <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 shrink-0">{t('agentDetail.skillsDisabledTag')}</span>}
                        </div>
                        <span className="text-[10px] text-muted-foreground truncate block">{skill.description}</span>
                      </div>
                    </div>
                  </button>
                );
              })}

              {/* Installed ClawHub skills */}
              {!categoryFilter && installed.length > 0 && (
                <>
                  <div className="pt-3 pb-1 px-1">
                    <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider">{t('agentDetail.skillsClawHubInstalled')}</span>
                  </div>
                  {installed.map(skill => (
                    <button
                      key={skill.slug}
                      onClick={() => setSelectedId(skill.slug)}
                      className={cn(
                        "w-full p-2.5 rounded-lg border transition-all text-left",
                        selectedId === skill.slug
                          ? "bg-primary/10 border-primary/20"
                          : "bg-card border-border hover:border-primary/20"
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        <Package className="w-4 h-4 text-primary shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-foreground truncate">{skill.name}</span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 shrink-0">{t('agentDetail.skillsClawHubTag')}</span>
                          </div>
                          <span className="text-[10px] text-muted-foreground truncate block">{skill.description || skill.slug}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </>
              )}

              {loadingInstalled && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground p-3 justify-center">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> {t('agentDetail.skillsLoadingInstalled')}
                </div>
              )}
            </>
          )}

          {/* Search results */}
          {searchQuery && searchResults.length > 0 && searchResults.map(result => {
            const isInstalled = installedSlugs.has(result.slug);
            return (
              <button
                key={result.slug}
                onClick={() => setSelectedId(result.slug)}
                className={cn(
                  "w-full p-2.5 rounded-lg border transition-all text-left",
                  selectedId === result.slug
                    ? "bg-primary/10 border-primary/20"
                    : "bg-card border-border hover:border-primary/20"
                )}
              >
                <div className="flex items-center gap-2.5">
                  <Package className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground truncate">{result.displayName || result.slug}</span>
                      {isInstalled && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">{t('agentDetail.skillsInstalledTag')}</span>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground truncate block">{result.summary}</span>
                  </div>
                </div>
              </button>
            );
          })}

          {searchQuery && !searching && searchResults.length === 0 && (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground">{t('agentDetail.skillsNoResults')} &ldquo;{searchQuery}&rdquo;</p>
            </div>
          )}
        </div>
      </div>

      {/* Right: Detail panel */}
      <div className="w-96 flex flex-col overflow-hidden bg-card">
        {selectedBuiltin ? (
          /* Built-in skill detail with enable/disable toggle */
          <div className="p-5">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className="text-3xl">{selectedBuiltin.icon}</span>
                <div>
                  <h3 className="text-base font-bold text-foreground">{selectedBuiltin.name}</h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">{t('agentDetail.skillsBuiltinTag')}</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">{selectedBuiltin.category}</span>
                  </div>
                </div>
              </div>
              <button onClick={() => setSelectedId(null)} className="p-1.5 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground">
                <XIcon className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{selectedBuiltin.description}</p>

            {/* Enable/Disable toggle for this agent */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-card border mb-4">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {isSkillEnabled(selectedBuiltin) ? t('agentDetail.skillsEnabledForAgent') : t('agentDetail.skillsDisabledForAgent')}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {t('agentDetail.skillsControls')} <span className="font-mono text-[9px] bg-muted px-1 py-0.5 rounded">{selectedBuiltin.toolGroup}</span>
                  {BUILTIN_SKILLS.filter(s => s.toolGroup === selectedBuiltin.toolGroup).length > 1 && (
                    <> — {t('agentDetail.skillsAlsoAffects')} {BUILTIN_SKILLS.filter(s => s.toolGroup === selectedBuiltin.toolGroup && s.id !== selectedBuiltin.id).map(s => s.name).join(', ')}</>
                  )}
                </p>
              </div>
              <button
                onClick={() => toggleSkill(selectedBuiltin)}
                disabled={togglingSkill}
                className={cn(
                  "w-12 h-6 rounded-full transition-colors relative cursor-pointer shrink-0",
                  isSkillEnabled(selectedBuiltin) ? "bg-emerald-500/20" : "bg-muted"
                )}
              >
                <span className={cn(
                  "absolute top-1 w-4 h-4 rounded-full transition-all",
                  isSkillEnabled(selectedBuiltin) ? "right-1 bg-emerald-400" : "left-1 bg-muted-foreground"
                )} />
              </button>
            </div>

            <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded-xl">
              <p className="text-[11px] text-blue-700 dark:text-blue-300">
                <CheckCircle2 className="w-4 h-4 inline mr-1.5" />
                {t('agentDetail.skillsBuiltinInfo')}
              </p>
            </div>
          </div>
        ) : selectedId ? (
          loadingDetail ? (
            <div className="flex-1 flex items-center justify-center">
              <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : detail ? (
            <>
              <div className="p-5 border-b border-border">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    {detail.owner?.image && <img src={detail.owner.image} alt="" className="w-8 h-8 rounded-full" />}
                    <div>
                      <h3 className="text-base font-bold text-foreground">{detail.skill.displayName}</h3>
                      <span className="text-[10px] text-muted-foreground">
                        {detail.owner && <>by <span className="font-medium text-foreground">{detail.owner.displayName || detail.owner.handle}</span> · </>}
                        {detail.latestVersion && <>v{detail.latestVersion.version}</>}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => setSelectedId(null)} className="p-1.5 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground">
                    <XIcon className="w-4 h-4" />
                  </button>
                </div>

                <p className="text-sm text-muted-foreground mb-4">{detail.skill.summary}</p>

                <div className="grid grid-cols-3 gap-2 mb-4">
                  <div className="text-center p-2 bg-background rounded-lg border border-border">
                    <div className="text-sm font-bold text-foreground">{(detail.skill.stats?.downloads || 0).toLocaleString()}</div>
                    <div className="text-[9px] text-muted-foreground">Downloads</div>
                  </div>
                  <div className="text-center p-2 bg-background rounded-lg border border-border">
                    <div className="text-sm font-bold text-foreground">{detail.skill.stats?.stars || 0}</div>
                    <div className="text-[9px] text-muted-foreground">Stars</div>
                  </div>
                  <div className="text-center p-2 bg-background rounded-lg border border-border">
                    <div className="text-sm font-bold text-foreground">{new Date(detail.skill.updatedAt).toLocaleDateString()}</div>
                    <div className="text-[9px] text-muted-foreground">Updated</div>
                  </div>
                </div>

                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl mb-4">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-300 mb-1">{t('agentDetail.skillsReviewBefore')}</p>
                      <a href={`https://clawhub.ai/${detail.skill.slug}`} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 hover:underline">
                        <ExternalLink className="w-3 h-3" /> {t('agentDetail.skillsViewSecurity')}
                      </a>
                    </div>
                  </div>
                </div>

                {installedSlugs.has(selectedId) ? (
                  <button onClick={() => handleUninstall(selectedId)} disabled={uninstalling === selectedId}
                    className="w-full py-2.5 px-4 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/20">
                    {uninstalling === selectedId ? <><RefreshCw className="w-4 h-4 animate-spin" /><span>{t('agentDetail.skillsUninstalling')}</span></> : <><Trash2 className="w-4 h-4" /><span>{t('agentDetail.skillsUninstall')}</span></>}
                  </button>
                ) : (
                  <button onClick={() => handleInstall(selectedId)} disabled={installing === selectedId}
                    className="w-full py-2.5 px-4 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                    {installing === selectedId ? <><RefreshCw className="w-4 h-4 animate-spin" /><span>{t('agentDetail.skillsInstalling')}</span></> : <><Download className="w-4 h-4" /><span>{t('agentDetail.skillsInstall')}</span></>}
                  </button>
                )}
              </div>
              {detail.latestVersion?.changelog && (
                <div className="flex-1 overflow-y-auto p-5">
                  <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Changelog</h4>
                  <pre className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap bg-background border border-border p-3 rounded-lg">{detail.latestVersion.changelog}</pre>
                </div>
              )}
            </>
          ) : selectedInstalled ? (
            <div className="p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <Package className="w-8 h-8 text-primary" />
                  <div>
                    <h3 className="text-base font-bold text-foreground">{selectedInstalled.name}</h3>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">{t('agentDetail.skillsClawHubTag')}</span>
                  </div>
                </div>
                <button onClick={() => setSelectedId(null)} className="p-1.5 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground">
                  <XIcon className="w-4 h-4" />
                </button>
              </div>
              <p className="text-sm text-muted-foreground mb-4">{selectedInstalled.description || ''}</p>
              <a href={`https://clawhub.ai/${selectedInstalled.slug}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline mb-4">
                <ExternalLink className="w-3 h-3" /> {t('agentDetail.skillsViewOnClawHub')}
              </a>
              <button onClick={() => handleUninstall(selectedInstalled.slug)} disabled={uninstalling === selectedInstalled.slug}
                className="w-full py-2.5 px-4 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/20">
                {uninstalling === selectedInstalled.slug ? <><RefreshCw className="w-4 h-4 animate-spin" /><span>{t('agentDetail.skillsUninstalling')}</span></> : <><Trash2 className="w-4 h-4" /><span>{t('agentDetail.skillsUninstall')}</span></>}
              </button>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-5">
              <div className="text-center">
                <p className="text-sm text-muted-foreground">{t('agentDetail.skillsCouldNotLoad')}</p>
              </div>
            </div>
          )
        ) : (
          <div className="flex-1 flex items-center justify-center p-5">
            <div className="text-center">
              <Sparkles className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">{t('agentDetail.skillsSelectToView')}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('agentDetail.skillsSearchHint')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
