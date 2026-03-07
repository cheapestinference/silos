import { useState, useEffect, useMemo, useCallback } from 'react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import {
  BookOpen,
  FileText,
  FolderOpen,
  Search,
  RefreshCw,
  Check,
  Brain,
  ChevronRight,
  ChevronDown,
  Plus,
  Eye,
  X,
  AlertTriangle,
  HardDrive,
  ArrowLeft,
} from 'lucide-react';

interface KnowledgeBrowserProps {
  agentId: string;
}

type FileEntry = { path: string; size: number; mtime: number; type: 'file' | 'directory' };
type BrowseItem = { name: string; path: string; type: 'file' | 'directory' };

export function KnowledgeBrowser({ agentId }: KnowledgeBrowserProps) {
  const { t } = useTranslation();
  const {
    workspaceFiles, workspaceLoading, workspaceContent,
    listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile,
    renameWorkspaceFile, mkdirWorkspace,
    gatewayConfig, patchGatewayConfig,
    browseFilesystem,
  } = useDashboardStore();

  const [search, setSearch] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['memory']));
  const [creating, setCreating] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [saving, setSaving] = useState(false);

  // Filesystem browser state
  const [browsing, setBrowsing] = useState(false);
  const [browsePath, setBrowsePath] = useState('/');
  const [browseItems, setBrowseItems] = useState<BrowseItem[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  useEffect(() => {
    if (agentId) listWorkspaceFiles(agentId);
  }, [agentId, listWorkspaceFiles]);

  // Extract extraPaths from gateway config for this agent
  const { extraPaths } = useMemo(() => {
    const config = gatewayConfig?.config as Record<string, unknown> | undefined;
    const agents = config?.agents as { defaults?: Record<string, unknown>; list?: Array<Record<string, unknown>> } | undefined;
    const agentEntry = agents?.list?.find((a: Record<string, unknown>) => a.id === agentId);
    const agentMs = agentEntry?.memorySearch as { extraPaths?: string[] } | undefined;
    const defaultMs = agents?.defaults?.memorySearch as { extraPaths?: string[] } | undefined;
    const extra = [...(defaultMs?.extraPaths || []), ...(agentMs?.extraPaths || [])];
    return { extraPaths: extra };
  }, [gatewayConfig, agentId]);

  // Filter only .md files, hiding system files shown in other tabs
  const HIDDEN_SYSTEM_FILES = new Set(['USER.md', 'HEARTBEAT.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'BOOTSTRAP.md', 'AGENTS.md']);
  const mdFiles = useMemo(() => {
    return workspaceFiles.filter(f => f.type === 'file' && f.path.endsWith('.md') && !HIDDEN_SYSTEM_FILES.has(f.path));
  }, [workspaceFiles]);

  // Determine indexing status for each file
  const getIndexStatus = (filePath: string): 'memory' | 'extra' | 'none' => {
    if (filePath === 'MEMORY.md' || filePath === 'memory.md' || filePath.startsWith('memory/')) {
      return 'memory';
    }
    const dir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '.';
    for (const ep of extraPaths) {
      const normalized = ep.replace(/^\.\//, '').replace(/\/+$/, '');
      if (filePath === normalized || filePath.startsWith(normalized + '/') || dir === normalized) {
        return 'extra';
      }
    }
    return 'none';
  };

  // Toggle a path in extraPaths
  const toggleExtraPath = async (targetPath: string) => {
    setSaving(true);
    try {
      const config = gatewayConfig?.config as Record<string, unknown> | undefined;
      const agents = config?.agents as { defaults?: Record<string, unknown>; list?: Array<Record<string, unknown>> } | undefined;
      const agentEntry = agents?.list?.find((a: Record<string, unknown>) => a.id === agentId);
      const currentMs = (agentEntry?.memorySearch || {}) as Record<string, unknown>;
      const currentExtra = (currentMs.extraPaths || []) as string[];

      let newExtra: string[];
      if (currentExtra.includes(targetPath)) {
        newExtra = currentExtra.filter(p => p !== targetPath);
      } else {
        newExtra = [...currentExtra, targetPath];
      }

      const currentList: Array<Record<string, unknown>> = (agents?.list || []).map(a => ({ ...a }));
      const existingIdx = currentList.findIndex(a => a.id === agentId);
      const updatedMs = { ...currentMs, extraPaths: newExtra };

      if (existingIdx >= 0) {
        currentList[existingIdx] = { ...currentList[existingIdx], memorySearch: updatedMs };
      } else {
        currentList.push({ id: agentId, memorySearch: updatedMs });
      }

      await patchGatewayConfig({ agents: { list: currentList } });
    } catch (error) {
      console.error('[Knowledge] Error toggling extraPath:', error);
    } finally {
      setSaving(false);
    }
  };

  // Move file to/from memory/ directory
  const toggleMemoryDir = async (filePath: string) => {
    setSaving(true);
    try {
      const fileName = filePath.split('/').pop() || filePath;
      const isInMemory = filePath.startsWith('memory/');
      const newPath = isInMemory ? fileName : `memory/${fileName}`;

      if (!isInMemory) {
        await mkdirWorkspace(agentId, 'memory');
      }

      const ok = await renameWorkspaceFile(agentId, filePath, newPath);
      if (ok) {
        await listWorkspaceFiles(agentId);
        if (previewPath === filePath) setPreviewPath(newPath);
      }
    } catch (error) {
      console.error('[Knowledge] Error moving file:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!newFileName.trim()) return;
    const name = newFileName.trim().endsWith('.md') ? newFileName.trim() : newFileName.trim() + '.md';
    const fullPath = `memory/${name}`;
    setSaving(true);
    try {
      await mkdirWorkspace(agentId, 'memory');
      const ok = await writeWorkspaceFile(agentId, fullPath, `# ${name.replace('.md', '')}\n\n`);
      if (ok) {
        await listWorkspaceFiles(agentId);
        setPreviewPath(fullPath);
      }
    } finally {
      setSaving(false);
      setCreating(false);
      setNewFileName('');
    }
  };

  // Filesystem browser
  const loadBrowsePath = useCallback(async (dirPath: string) => {
    setBrowseLoading(true);
    const result = await browseFilesystem(dirPath);
    if (result) {
      setBrowsePath(result.path);
      setBrowseItems(result.items);
    }
    setBrowseLoading(false);
  }, [browseFilesystem]);

  const openBrowser = () => {
    setBrowsing(true);
    loadBrowsePath('/');
  };

  const addExternalPath = async (absPath: string) => {
    await toggleExtraPath(absPath);
    setBrowsing(false);
  };

  // Filter by search
  const filteredFiles = useMemo(() => {
    if (!search.trim()) return mdFiles;
    const q = search.toLowerCase();
    return mdFiles.filter(f => f.path.toLowerCase().includes(q));
  }, [mdFiles, search]);

  // Group files by directory
  const grouped = useMemo(() => {
    const groups = new Map<string, FileEntry[]>();
    for (const f of filteredFiles) {
      const parts = f.path.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(f);
    }
    const sorted = Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === 'memory' || a.startsWith('memory/')) return -1;
      if (b === 'memory' || b.startsWith('memory/')) return 1;
      if (a === '.') return -1;
      if (b === '.') return 1;
      return a.localeCompare(b);
    });
    return sorted;
  }, [filteredFiles]);

  // Load preview content
  useEffect(() => {
    if (previewPath) readWorkspaceFile(agentId, previewPath);
  }, [previewPath, agentId, readWorkspaceFile]);

  const toggleDir = (dir: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir); else next.add(dir);
      return next;
    });
  };

  // Filesystem browser overlay
  if (browsing) {
    const parentPath = browsePath === '/' ? null : browsePath.split('/').slice(0, -1).join('/') || '/';
    return (
      <div className="h-full flex flex-col animate-in fade-in duration-300">
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-blue-500" />
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">{t('agentDetail.knowledge.browseTitle')}</h3>
            </div>
            <button onClick={() => setBrowsing(false)} className="p-1 hover:bg-muted rounded transition-colors">
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted rounded-lg px-3 py-1.5 font-mono">
            <FolderOpen className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{browsePath}</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {browseLoading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : (
            <>
              {parentPath !== null && (
                <button
                  onClick={() => loadBrowsePath(parentPath)}
                  className="w-full flex items-center gap-2 px-4 py-2 hover:bg-muted transition-colors border-b border-border/30"
                >
                  <ArrowLeft className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">..</span>
                </button>
              )}
              {browseItems.map((item) => {
                const isInExtra = extraPaths.includes(item.path);
                return (
                  <div
                    key={item.path}
                    className="flex items-center gap-2 px-4 py-2 hover:bg-muted transition-colors group cursor-pointer"
                    onClick={() => {
                      if (item.type === 'directory') loadBrowsePath(item.path);
                    }}
                  >
                    {item.type === 'directory' ? (
                      <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    ) : (
                      <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="text-xs text-foreground flex-1 truncate">{item.name}</span>
                    {isInExtra && (
                      <span className="px-1.5 py-0.5 text-[9px] font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 rounded">indexed</span>
                    )}
                    {item.type === 'directory' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); addExternalPath(item.path); }}
                        className={cn(
                          "px-2 py-0.5 text-[9px] font-medium rounded border transition-colors opacity-0 group-hover:opacity-100",
                          isInExtra
                            ? "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-500/20"
                            : "border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10"
                        )}
                      >
                        {isInExtra ? t('agentDetail.knowledge.removeIndex') : t('agentDetail.knowledge.addIndex')}
                      </button>
                    )}
                    {item.type === 'directory' && (
                      <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                    )}
                  </div>
                );
              })}
              {browseItems.length === 0 && (
                <div className="text-center py-8 text-xs text-muted-foreground">{t('agentDetail.knowledge.emptyDir')}</div>
              )}
            </>
          )}
        </div>

        {/* Current extraPaths summary */}
        {extraPaths.length > 0 && (
          <div className="p-3 border-t border-border">
            <p className="text-[10px] font-bold text-muted-foreground uppercase mb-1">{t('agentDetail.knowledge.indexedPaths')}</p>
            <div className="space-y-1 max-h-24 overflow-y-auto">
              {extraPaths.map(ep => (
                <div key={ep} className="flex items-center gap-1.5 text-[10px]">
                  <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                  <span className="text-foreground/70 font-mono truncate flex-1">{ep}</span>
                  <button
                    onClick={() => toggleExtraPath(ep)}
                    className="text-red-500/60 hover:text-red-500 transition-colors shrink-0"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* File list */}
      <div className="w-96 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-emerald-500" />
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">{t('agentDetail.knowledge.title')}</h3>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => { setCreating(true); setNewFileName(''); }} className="p-1 hover:bg-muted rounded transition-colors" title={t('agentDetail.knowledge.newFile')}>
                <Plus className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
              <button onClick={openBrowser} className="p-1 hover:bg-muted rounded transition-colors" title={t('agentDetail.knowledge.browseServer')}>
                <HardDrive className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
              <button onClick={() => listWorkspaceFiles(agentId)} className="p-1 hover:bg-muted rounded transition-colors" title={t('common.loading')}>
                <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", workspaceLoading && "animate-spin")} />
              </button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('agentDetail.knowledge.searchPlaceholder')}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
            />
          </div>
          <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> memory/</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> extraPath</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/30" /> {t('agentDetail.knowledge.notIndexed')}</span>
          </div>
        </div>

        {/* Educational warning */}
        <div className="mx-3 mt-3 p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">{t('agentDetail.knowledge.warningTitle')}</p>
              <p className="text-[10px] text-amber-600/80 dark:text-amber-400/70 leading-relaxed mt-0.5">
                {t('agentDetail.knowledge.warningText')}
              </p>
            </div>
          </div>
        </div>

        {/* Create new .md */}
        {creating && (
          <div className="p-2 border-b border-border bg-muted/50">
            <div className="flex items-center gap-1.5">
              <Brain className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <input
                autoFocus
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
                placeholder="filename.md"
                className="flex-1 text-xs bg-card border border-border rounded px-2 py-1 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
              />
              <button onClick={handleCreate} className="p-1 hover:bg-muted rounded"><Check className="w-3.5 h-3.5 text-emerald-500" /></button>
              <button onClick={() => setCreating(false)} className="p-1 hover:bg-muted rounded"><X className="w-3.5 h-3.5 text-muted-foreground" /></button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 ml-5">{t('agentDetail.knowledge.createsInMemory')}</p>
          </div>
        )}

        {/* ExtraPaths summary */}
        {extraPaths.length > 0 && (
          <div className="px-3 py-2 border-b border-border/50">
            <p className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase mb-1">{t('agentDetail.knowledge.externalSources')}</p>
            {extraPaths.map(ep => (
              <div key={ep} className="flex items-center gap-1.5 py-0.5">
                <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                <span className="text-[10px] text-foreground/70 font-mono truncate flex-1">{ep}</span>
                <button onClick={() => toggleExtraPath(ep)} className="text-red-500/50 hover:text-red-500 shrink-0">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* File groups */}
        <div className="flex-1 overflow-y-auto">
          {workspaceLoading && mdFiles.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : grouped.length === 0 ? (
            <div className="text-center py-8 text-xs text-muted-foreground">
              <BookOpen className="w-8 h-8 mx-auto mb-2 text-muted-foreground/20" />
              {t('agentDetail.knowledge.noFiles')}
            </div>
          ) : (
            grouped.map(([dir, files]) => {
              const isExpanded = expandedDirs.has(dir);
              const dirLabel = dir === '.' ? 'Root' : dir;
              const isMemoryDir = dir === 'memory' || dir.startsWith('memory/');
              const isDirInExtra = extraPaths.some(ep => {
                const normalized = ep.replace(/^\.\//, '').replace(/\/+$/, '');
                return dir === normalized || dir.startsWith(normalized + '/');
              });

              return (
                <div key={dir}>
                  <button
                    onClick={() => toggleDir(dir)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted transition-colors border-b border-border/50"
                  >
                    {isExpanded ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                    <FolderOpen className={cn("w-3.5 h-3.5", isMemoryDir ? "text-emerald-500" : isDirInExtra ? "text-blue-500" : "text-amber-500")} />
                    <span className="text-xs font-semibold text-foreground flex-1">{dirLabel}</span>
                    <span className="text-[10px] text-muted-foreground">{files.length}</span>
                    {isMemoryDir && <span className="px-1.5 py-0.5 text-[9px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 rounded">{t('agentDetail.knowledge.autoIndexed')}</span>}
                    {isDirInExtra && !isMemoryDir && <span className="px-1.5 py-0.5 text-[9px] font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 rounded">extra</span>}
                    {!isMemoryDir && dir !== '.' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleExtraPath(dir); }}
                        className={cn(
                          "w-5 h-5 rounded flex items-center justify-center border transition-colors",
                          isDirInExtra
                            ? "bg-blue-500 border-blue-500 text-white"
                            : "border-border hover:border-primary/50"
                        )}
                        title={isDirInExtra ? t('agentDetail.knowledge.removeFromKb') : t('agentDetail.knowledge.addToKb')}
                      >
                        {isDirInExtra && <Check className="w-3 h-3" />}
                      </button>
                    )}
                  </button>

                  {isExpanded && files.map((file) => {
                    const status = getIndexStatus(file.path);
                    const fileName = file.path.split('/').pop() || file.path;
                    const isSelected = previewPath === file.path;

                    return (
                      <div
                        key={file.path}
                        className={cn(
                          "flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors group",
                          isSelected ? "bg-primary/10" : "hover:bg-muted"
                        )}
                        onClick={() => setPreviewPath(file.path)}
                      >
                        <span className={cn(
                          "w-2 h-2 rounded-full shrink-0",
                          status === 'memory' ? "bg-emerald-500" : status === 'extra' ? "bg-blue-500" : "bg-muted-foreground/30"
                        )} />
                        <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span className="text-xs text-foreground flex-1 truncate">{fileName}</span>
                        <span className="text-[10px] text-muted-foreground">{(file.size / 1024).toFixed(1)}K</span>

                        {status === 'none' && !file.path.includes('/') && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleMemoryDir(file.path); }}
                            className="px-1.5 py-0.5 text-[9px] font-medium rounded border border-border hover:border-emerald-500/50 hover:bg-emerald-500/10 text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors opacity-0 group-hover:opacity-100"
                            title={t('agentDetail.knowledge.moveToMemory')}
                          >
                            Index
                          </button>
                        )}
                        {status === 'memory' && file.path.startsWith('memory/') && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleMemoryDir(file.path); }}
                            className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-red-500/10 hover:text-red-600 hover:border-red-500/20 transition-colors opacity-0 group-hover:opacity-100"
                            title={t('agentDetail.knowledge.moveFromMemory')}
                          >
                            Unindex
                          </button>
                        )}
                        {status === 'none' && file.path.includes('/') && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleExtraPath(file.path); }}
                            className="px-1.5 py-0.5 text-[9px] font-medium rounded border border-border hover:border-blue-500/50 hover:bg-blue-500/10 text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400 transition-colors opacity-0 group-hover:opacity-100"
                            title={t('agentDetail.knowledge.addToExtraPaths')}
                          >
                            Index
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Legend */}
        <div className="p-3 border-t border-border">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            {t('agentDetail.knowledge.legend')}
          </p>
        </div>
      </div>

      {/* Preview Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {previewPath ? (
          <>
            <div className="px-4 py-3 border-b border-border flex items-center gap-2 shrink-0">
              <Eye className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium text-foreground flex-1">{previewPath}</span>
              {saving && <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
              <span className={cn(
                "px-2 py-0.5 text-[10px] font-medium rounded",
                getIndexStatus(previewPath) === 'memory' ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" :
                getIndexStatus(previewPath) === 'extra' ? "bg-blue-500/15 text-blue-600 dark:text-blue-400" :
                "bg-muted text-muted-foreground"
              )}>
                {getIndexStatus(previewPath) === 'memory' ? t('agentDetail.knowledge.indexedMemory') :
                 getIndexStatus(previewPath) === 'extra' ? t('agentDetail.knowledge.indexedExtra') :
                 t('agentDetail.knowledge.notIndexed')}
              </span>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {workspaceLoading ? (
                <div className="flex items-center justify-center h-full">
                  <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
                </div>
              ) : (
                <pre className="text-sm text-foreground font-mono whitespace-pre-wrap leading-relaxed">{workspaceContent}</pre>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <BookOpen className="w-12 h-12 mx-auto mb-3 text-muted-foreground/20" />
              <p className="text-sm">{t('agentDetail.knowledge.selectFile')}</p>
              <p className="text-xs mt-1">{t('agentDetail.knowledge.toggleHint')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
