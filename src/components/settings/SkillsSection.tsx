import { useState, useRef, useMemo, useEffect } from 'react';
import { Search, Download, ExternalLink, Package, Check, RefreshCw, ChevronDown, Info, AlertTriangle } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import { formatDistanceToNow } from 'date-fns';

function formatDate(ts: number): string {
  try { return formatDistanceToNow(new Date(ts), { addSuffix: true }); } catch { return ''; }
}

export interface InstalledSkill {
  slug: string;
  name: string;
  description: string;
  installedAt: number;
}

export interface ClawHubResult {
  score: number;
  slug: string;
  displayName: string;
  summary: string;
  version: string | null;
  updatedAt: number;
}

export interface ClawHubDetail {
  skill: {
    slug: string;
    displayName: string;
    summary: string;
    stats: { downloads: number; installsAllTime: number; stars: number; versions: number };
    createdAt: number;
    updatedAt: number;
  };
  latestVersion: { version: string; createdAt: number; changelog: string } | null;
  owner: { handle: string; displayName: string; image: string } | null;
}

export function SkillsSection() {
  const { t } = useTranslation();
  const { token } = useDashboardStore();
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ClawHubResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClawHubDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const authHeaders = useMemo(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);

  const loadInstalled = async () => {
    try {
      const res = await fetch('/api/skills/list', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setInstalled(data.skills || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { loadInstalled(); }, []);

  // Load detail when a skill is selected
  useEffect(() => {
    if (!selectedSlug) { setDetail(null); return; }
    let cancelled = false;
    setLoadingDetail(true);
    fetch(`/api/clawhub/skill?slug=${encodeURIComponent(selectedSlug)}`, { headers: authHeaders })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) setDetail(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [selectedSlug, authHeaders]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    setSelectedSlug(null);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!query.trim()) { setSearchResults([]); return; }
    searchTimeoutRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/clawhub/search?q=${encodeURIComponent(query)}&limit=20`, { headers: authHeaders });
        if (res.ok) {
          const data = await res.json();
          setSearchResults(Array.isArray(data) ? data : data.results || []);
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
        headers: authHeaders,
        body: JSON.stringify({ slug }),
      });
    } catch { /* ignore */ }
    // Always reload — skill may install despite non-200 exit code
    await loadInstalled();
    setInstalling(null);
  };

  const handleUninstall = async (slug: string) => {
    setUninstalling(slug);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (res.ok) {
        setInstalled(prev => prev.filter(s => s.slug !== slug));
      }
    } catch { /* ignore */ }
    setUninstalling(null);
  };

  const installedSlugs = new Set(installed.map(s => s.slug));

  return (
    <div className="space-y-6">
      {/* Info box at top */}
      <div className="p-4 rounded-xl bg-muted/40 border">
        <p className="text-xs text-muted-foreground">
          <Info className="w-4 h-4 inline mr-1" />
          {t('settings.skillsConfig.infoText')}
        </p>
      </div>

      {/* ClawHub Marketplace — search stays at top */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">ClawHub Marketplace</h3>

        {/* Category quick-search tags */}
        <div className="flex flex-wrap gap-2 mb-3">
          {[
            { label: 'Explore', q: 'agent', icon: '\u{1F50E}' },
            { label: 'Calendar', q: 'calendar', icon: '\u{1F4C5}' },
            { label: 'Email', q: 'email', icon: '\u{1F4E7}' },
            { label: 'Git', q: 'git', icon: '\u{1F500}' },
            { label: 'Database', q: 'database', icon: '\u{1F5C4}\uFE0F' },
            { label: 'DevOps', q: 'devops deploy', icon: '\u{1F680}' },
            { label: 'Writing', q: 'writing', icon: '\u270D\uFE0F' },
            { label: 'API', q: 'api rest', icon: '\u{1F50C}' },
            { label: 'Testing', q: 'test', icon: '\u{1F9EA}' },
          ].map(cat => (
            <button
              key={cat.q}
              onClick={() => handleSearch(cat.q)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors flex items-center gap-1.5",
                searchQuery === cat.q
                  ? "bg-primary/15 text-primary border-primary/20"
                  : "bg-card text-muted-foreground hover:text-foreground hover:bg-muted border-border"
              )}
            >
              <span>{cat.icon}</span>{cat.label}
            </button>
          ))}
        </div>

        <div className="relative mb-3">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={t('settings.skillsConfig.searchPlaceholder')}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border bg-card text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {searching && <RefreshCw className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin" />}
        </div>

        {searchResults.length > 0 && (
          <div className="space-y-2">
            {searchResults.map(result => {
              const isInstalled = installedSlugs.has(result.slug);
              const isSelected = selectedSlug === result.slug;
              return (
                <div key={result.slug}>
                  {/* Result row */}
                  <button
                    onClick={() => setSelectedSlug(isSelected ? null : result.slug)}
                    className={cn(
                      "w-full text-left p-4 rounded-xl border transition-colors",
                      isSelected ? "bg-card border-primary/20 ring-1 ring-primary/20" : "bg-card hover:bg-muted/40"
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <Package className="w-5 h-5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="font-semibold text-foreground truncate">{result.displayName || result.slug}</h4>
                            {result.version && (
                              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">v{result.version}</span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{result.summary}</p>
                        </div>
                      </div>
                      <div className="shrink-0">
                        {isInstalled && (
                          <span className="px-2 py-1 text-[10px] font-medium rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                            <Check className="w-3 h-3 inline mr-0.5" />Installed
                          </span>
                        )}
                        <ChevronDown className={cn("w-4 h-4 text-muted-foreground inline ml-2 transition-transform", isSelected && "rotate-180")} />
                      </div>
                    </div>
                  </button>

                  {/* Expanded detail panel */}
                  {isSelected && (
                    <div className="mt-1 p-5 rounded-xl bg-muted/20 border border-border space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                      {loadingDetail ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
                          <RefreshCw className="w-4 h-4 animate-spin" /> Loading details...
                        </div>
                      ) : detail ? (
                        <>
                          {/* Header with author */}
                          <div>
                            <h3 className="text-base font-bold text-foreground">{detail.skill.displayName}</h3>
                            <p className="text-sm text-muted-foreground mt-1">{detail.skill.summary}</p>
                            {detail.owner && (
                              <div className="flex items-center gap-2 mt-2">
                                {detail.owner.image && <img src={detail.owner.image} alt="" className="w-5 h-5 rounded-full" />}
                                <span className="text-xs text-muted-foreground">by <span className="text-foreground font-medium">{detail.owner.displayName || detail.owner.handle}</span></span>
                              </div>
                            )}
                          </div>

                          {/* Stats */}
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            {detail.skill.stats?.downloads > 0 && (
                              <span><Download className="w-3 h-3 inline mr-1" />{detail.skill.stats.downloads.toLocaleString()} downloads</span>
                            )}
                            {detail.skill.stats?.stars > 0 && (
                              <span>&#9733; {detail.skill.stats.stars} stars</span>
                            )}
                            {detail.latestVersion && (
                              <span>v{detail.latestVersion.version}</span>
                            )}
                            <span>Updated {formatDate(detail.skill.updatedAt)}</span>
                          </div>

                          {/* Changelog */}
                          {detail.latestVersion?.changelog && (
                            <div className="text-xs text-muted-foreground bg-background/40 rounded-lg p-3 border">
                              <p className="font-medium text-foreground mb-1">Changelog</p>
                              <p className="whitespace-pre-wrap">{detail.latestVersion.changelog}</p>
                            </div>
                          )}

                          {/* Security warning + actions */}
                          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                            <p className="text-xs text-amber-700 dark:text-amber-300">
                              <AlertTriangle className="w-4 h-4 inline mr-1" />
                              Community-made skill. Review the security report before installing.
                            </p>
                            <a
                              href={`https://clawhub.ai/${result.slug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-amber-700 dark:text-amber-300 hover:underline"
                            >
                              <ExternalLink className="w-3 h-3" /> View on ClawHub (security scan, source code, reviews)
                            </a>
                          </div>

                          {/* Install/Installed button */}
                          <div className="flex items-center gap-3">
                            {isInstalled ? (
                              <span className="px-4 py-2 text-sm font-medium rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                <Check className="w-4 h-4 inline mr-1.5" />Already installed
                              </span>
                            ) : (
                              <button
                                onClick={() => handleInstall(result.slug)}
                                disabled={installing === result.slug}
                                className="px-4 py-2 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                              >
                                {installing === result.slug ? (
                                  <><RefreshCw className="w-4 h-4 inline mr-1.5 animate-spin" />Installing...</>
                                ) : (
                                  <><Download className="w-4 h-4 inline mr-1.5" />Install skill</>
                                )}
                              </button>
                            )}
                          </div>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground text-center py-2">Could not load skill details</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {searchQuery && !searching && searchResults.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">No skills found for &ldquo;{searchQuery}&rdquo;</p>
        )}
      </div>

      {/* Installed Skills */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('settings.skillsConfig.installed')} ({installed.length})</h3>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : installed.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4 bg-muted/40 rounded-xl border">{t('settings.skillsConfig.noSkills')}</p>
        ) : (
          <div className="space-y-2">
            {installed.map(skill => (
              <div key={skill.slug} className="flex items-center justify-between p-4 rounded-xl bg-card border">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <Package className="w-5 h-5 text-primary shrink-0" />
                  <div className="min-w-0">
                    <h4 className="font-semibold text-foreground">{skill.name}</h4>
                    <p className="text-xs text-muted-foreground truncate">{skill.description || skill.slug}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {skill.slug} &middot; installed {formatDate(skill.installedAt)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <a
                    href={`https://clawhub.ai/${skill.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    title={t('settings.skillsConfig.viewOnClawHub')}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <button
                    onClick={() => handleUninstall(skill.slug)}
                    disabled={uninstalling === skill.slug}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/20"
                  >
                    {uninstalling === skill.slug ? <RefreshCw className="w-3 h-3 animate-spin" /> : t('settings.skillsConfig.uninstall')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
