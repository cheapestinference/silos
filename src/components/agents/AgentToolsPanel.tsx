import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Wrench, RefreshCw, CheckCircle2, AlertTriangle, Edit3, FileText, Info } from 'lucide-react';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import { useDashboardStore } from '../../store/dashboard-store';

const AGENT_TOOL_GROUPS = [
  { id: 'group:fs', nameKey: 'settings.toolsConfig.groups.files', icon: '📁', descKey: 'settings.toolsConfig.groups.filesDesc' },
  { id: 'group:runtime', nameKey: 'settings.toolsConfig.groups.shell', icon: '💻', descKey: 'settings.toolsConfig.groups.shellDesc' },
  { id: 'group:web', nameKey: 'settings.toolsConfig.groups.web', icon: '🌐', descKey: 'settings.toolsConfig.groups.webDesc' },
  { id: 'group:ui', nameKey: 'settings.toolsConfig.groups.browser', icon: '🖥️', descKey: 'settings.toolsConfig.groups.browserDesc' },
  { id: 'group:sessions', nameKey: 'settings.toolsConfig.groups.sessions', icon: '🔗', descKey: 'settings.toolsConfig.groups.sessionsDesc' },
  { id: 'group:memory', nameKey: 'settings.toolsConfig.groups.memory', icon: '🧠', descKey: 'settings.toolsConfig.groups.memoryDesc' },
  { id: 'group:automation', nameKey: 'settings.toolsConfig.groups.automation', icon: '⏰', descKey: 'settings.toolsConfig.groups.automationDesc' },
  { id: 'group:messaging', nameKey: 'settings.toolsConfig.groups.messaging', icon: '💬', descKey: 'settings.toolsConfig.groups.messagingDesc' },
  { id: 'group:nodes', nameKey: 'settings.toolsConfig.groups.devices', icon: '📱', descKey: 'settings.toolsConfig.groups.devicesDesc' },
];

export function AgentToolsPanel({ agentId: agentIdProp }: { agentId?: string } = {}) {
  const { id: routeAgentId } = useParams<{ id: string }>();
  const agentId = agentIdProp || routeAgentId;
  const { t } = useTranslation();
  const {
    gatewayConfig, patchGatewayConfig,
    memoryContent, memoryLoading, readMemoryFile, writeMemoryFile,
  } = useDashboardStore();
  const [saving, setSaving] = useState(false);

  // TOOLS.md editor state
  const [toolsContent, setToolsContent] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef('');

  // Load TOOLS.md on mount
  useEffect(() => {
    if (agentId) readMemoryFile(agentId, 'TOOLS.md');
  }, [agentId, readMemoryFile]);

  // Sync loaded content
  useEffect(() => {
    setToolsContent(memoryContent);
    lastSavedRef.current = memoryContent;
  }, [memoryContent]);

  // Cleanup timeout
  useEffect(() => {
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, []);

  if (!agentId) return null;

  // --- Tool toggles logic ---
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
  const isGroupEnabled = (groupId: string) => !effectiveDeny.includes(groupId);
  const lobsterEnabled = effectiveAlsoAllow.includes('lobster');

  const patchAgentTools = async (toolsPatch: Record<string, unknown>) => {
    setSaving(true);
    const currentAgentTools = agentTools || { deny: [...globalDeny], alsoAllow: [...globalAlsoAllow] };
    const newTools = { ...currentAgentTools, ...toolsPatch };
    const currentList = (agentsCfg?.list || []) as Array<Record<string, unknown>>;
    const exists = currentList.some(a => a.id === agentId);
    const updatedList = exists
      ? currentList.map(a => a.id === agentId ? { ...a, tools: newTools } : a)
      : [...currentList, { id: agentId, tools: newTools }];
    await patchGatewayConfig({ agents: { ...config?.agents as object, list: updatedList } });
    setSaving(false);
  };

  const toggleGroup = (groupId: string) => {
    const deny = agentDeny ?? [...globalDeny];
    const newDeny = isGroupEnabled(groupId) ? [...deny, groupId] : deny.filter(d => d !== groupId);
    patchAgentTools({ deny: newDeny });
  };

  const toggleLobster = () => {
    const allow = agentAlsoAllow ?? [...globalAlsoAllow];
    const newAllow = lobsterEnabled ? allow.filter(a => a !== 'lobster') : [...allow, 'lobster'];
    patchAgentTools({ alsoAllow: newAllow });
  };

  // --- TOOLS.md auto-save ---
  const handleContentChange = (value: string) => {
    setToolsContent(value);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      if (value === lastSavedRef.current) return;
      setSaveStatus('saving');
      const ok = await writeMemoryFile(agentId, 'TOOLS.md', value);
      if (ok) {
        lastSavedRef.current = value;
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        setSaveStatus('error');
      }
    }, 1000);
  };

  const enabledCount = AGENT_TOOL_GROUPS.filter(g => isGroupEnabled(g.id)).length + (lobsterEnabled ? 1 : 0);
  const totalCount = AGENT_TOOL_GROUPS.length + 1;

  return (
    <div className="h-full flex animate-in fade-in duration-300">
      {/* Left: TOOLS.md Editor (60%) */}
      <div className="flex-[3] flex flex-col border-r border-border overflow-hidden">
        {/* Editor Header */}
        <div className="px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/20 flex items-center justify-center">
                <FileText className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-foreground" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
                  {t('agentDetail.toolsEditorTitle')}
                </h3>
                <div className="relative group">
                  <Info className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-muted-foreground cursor-help transition-colors" />
                  <div className="absolute left-0 top-full mt-2 w-80 p-3.5 rounded-xl bg-popover border border-border shadow-xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
                    {t('agentDetail.toolsEditorHint').split('\n\n').map((block, i) => {
                      if (i === 0) return <p key={i} className="text-xs text-foreground leading-relaxed mb-2.5">{block}</p>;
                      const lines = block.split('\n');
                      const heading = lines[0]?.replace(/^##\s*/, '');
                      const items = lines.slice(1).filter(l => l.startsWith('- ')).map(l => l.replace(/^-\s*/, ''));
                      return (
                        <div key={i} className="mb-2">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">{heading}</p>
                          {items.map((item, j) => (
                            <p key={j} className="text-xs text-muted-foreground/80 leading-relaxed pl-2">{item}</p>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
            {/* Save status */}
            <div className="flex items-center gap-1.5">
              {saveStatus === 'saving' && <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
              {saveStatus === 'saved' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
              {saveStatus === 'error' && <AlertTriangle className="w-3.5 h-3.5 text-red-500" />}
              {saveStatus === 'idle' && toolsContent !== lastSavedRef.current && toolsContent !== '' && (
                <Edit3 className="w-3.5 h-3.5 text-amber-500" />
              )}
            </div>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-hidden p-4">
          {memoryLoading ? (
            <div className="flex items-center justify-center h-full">
              <RefreshCw className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : (
            <textarea
              value={toolsContent}
              onChange={(e) => handleContentChange(e.target.value)}
              className="w-full h-full p-4 bg-muted border border-border rounded-xl text-sm text-foreground font-mono focus:outline-none focus:border-amber-500/40 focus:ring-1 focus:ring-amber-500/20 resize-none transition-all"
              placeholder="# Tools\n\n### SSH\n- home-server → 192.168.1.100, user: admin\n\n### Cameras\n- living-room → Main area, wide angle\n\n### TTS\n- Preferred voice: Nova"
              spellCheck={false}
            />
          )}
        </div>
      </div>

      {/* Right: Tool Capabilities (40%) */}
      <div className="flex-[2] flex flex-col overflow-hidden">
        {/* Capabilities Header */}
        <div className="px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary/20 to-accent/20 border border-primary/20 flex items-center justify-center">
                <Wrench className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-foreground" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
                  {t('agentDetail.tools')}
                </h3>
                <p className="text-[10px] text-muted-foreground">
                  {enabledCount}/{totalCount}
                </p>
              </div>
            </div>
            {saving && <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
          </div>
        </div>

        {/* Toggles */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {AGENT_TOOL_GROUPS.map((group) => {
            const enabled = isGroupEnabled(group.id);
            return (
              <div key={group.id} className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-base shrink-0">{group.icon}</span>
                  <div className="min-w-0">
                    <h4 className="text-xs font-semibold text-foreground truncate">{t(group.nameKey as any)}</h4>
                    <p className="text-[10px] text-muted-foreground truncate">{t(group.descKey as any)}</p>
                  </div>
                </div>
                <button
                  onClick={() => toggleGroup(group.id)}
                  className={cn(
                    "w-10 h-5 rounded-full transition-colors relative cursor-pointer shrink-0 ml-2",
                    enabled ? "bg-emerald-500/20" : "bg-muted"
                  )}
                >
                  <span className={cn(
                    "absolute top-0.5 w-4 h-4 rounded-full transition-all",
                    enabled ? "right-0.5 bg-emerald-400" : "left-0.5 bg-muted-foreground"
                  )} />
                </button>
              </div>
            );
          })}

          {/* Lobster */}
          <div className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="text-base shrink-0">🦞</span>
              <div className="min-w-0">
                <h4 className="text-xs font-semibold text-foreground truncate">{t('settings.toolsConfig.lobsterName')}</h4>
                <p className="text-[10px] text-muted-foreground truncate">{t('settings.toolsConfig.lobsterDesc')}</p>
              </div>
            </div>
            <button
              onClick={toggleLobster}
              className={cn(
                "w-10 h-5 rounded-full transition-colors relative cursor-pointer shrink-0 ml-2",
                lobsterEnabled ? "bg-emerald-500/20" : "bg-muted"
              )}
            >
              <span className={cn(
                "absolute top-0.5 w-4 h-4 rounded-full transition-all",
                lobsterEnabled ? "right-0.5 bg-emerald-400" : "left-0.5 bg-muted-foreground"
              )} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
