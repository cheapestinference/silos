import { useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import type { TranslationKey } from '../../i18n';

export const TOOL_GROUPS = [
  { id: 'group:fs', nameKey: 'settings.toolsConfig.groups.files' as TranslationKey, icon: '\u{1F4C1}', descKey: 'settings.toolsConfig.groups.filesDesc' as TranslationKey },
  { id: 'group:runtime', nameKey: 'settings.toolsConfig.groups.shell' as TranslationKey, icon: '\u{1F4BB}', descKey: 'settings.toolsConfig.groups.shellDesc' as TranslationKey },
  { id: 'group:web', nameKey: 'settings.toolsConfig.groups.web' as TranslationKey, icon: '\u{1F310}', descKey: 'settings.toolsConfig.groups.webDesc' as TranslationKey },
  { id: 'group:ui', nameKey: 'settings.toolsConfig.groups.browser' as TranslationKey, icon: '\u{1F5A5}\uFE0F', descKey: 'settings.toolsConfig.groups.browserDesc' as TranslationKey },
  { id: 'group:sessions', nameKey: 'settings.toolsConfig.groups.sessions' as TranslationKey, icon: '\u{1F517}', descKey: 'settings.toolsConfig.groups.sessionsDesc' as TranslationKey },
  { id: 'group:memory', nameKey: 'settings.toolsConfig.groups.memory' as TranslationKey, icon: '\u{1F9E0}', descKey: 'settings.toolsConfig.groups.memoryDesc' as TranslationKey },
  { id: 'group:automation', nameKey: 'settings.toolsConfig.groups.automation' as TranslationKey, icon: '\u23F0', descKey: 'settings.toolsConfig.groups.automationDesc' as TranslationKey },
  { id: 'group:messaging', nameKey: 'settings.toolsConfig.groups.messaging' as TranslationKey, icon: '\u{1F4AC}', descKey: 'settings.toolsConfig.groups.messagingDesc' as TranslationKey },
  { id: 'group:nodes', nameKey: 'settings.toolsConfig.groups.devices' as TranslationKey, icon: '\u{1F4F1}', descKey: 'settings.toolsConfig.groups.devicesDesc' as TranslationKey },
];

export function ToolsSection() {
  const { t } = useTranslation();
  const { gatewayConfig, patchGatewayConfig } = useDashboardStore();
  const [saving, setSaving] = useState(false);

  const config = gatewayConfig?.config as Record<string, unknown> | undefined;
  const toolsConfig = (config?.tools || {}) as Record<string, unknown>;
  const denyList = (toolsConfig.deny || []) as string[];
  const alsoAllowList = (toolsConfig.alsoAllow || []) as string[];
  const loopDetection = (toolsConfig.loopDetection || {}) as Record<string, unknown>;
  const loopEnabled = !!loopDetection.enabled;

  const lobsterEnabled = alsoAllowList.includes('lobster');

  const isGroupEnabled = (groupId: string) => !denyList.includes(groupId);

  const toggleGroup = async (groupId: string) => {
    setSaving(true);
    const newDeny = isGroupEnabled(groupId)
      ? [...denyList, groupId]
      : denyList.filter(d => d !== groupId);
    await patchGatewayConfig({ tools: { ...toolsConfig, deny: newDeny } });
    setSaving(false);
  };

  const toggleLobster = async () => {
    setSaving(true);
    const newAlsoAllow = lobsterEnabled
      ? alsoAllowList.filter(a => a !== 'lobster')
      : [...alsoAllowList, 'lobster'];
    await patchGatewayConfig({ tools: { ...toolsConfig, alsoAllow: newAlsoAllow } });
    setSaving(false);
  };

  const toggleLoopDetection = async () => {
    setSaving(true);
    await patchGatewayConfig({ tools: { ...toolsConfig, loopDetection: { enabled: !loopEnabled } } });
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('settings.toolsConfig.globalHint')}</p>
        {saving && <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" />}
      </div>

      <div className="space-y-2">
        {TOOL_GROUPS.map((group) => {
          const enabled = isGroupEnabled(group.id);
          return (
            <div key={group.id} className="flex items-center justify-between p-4 rounded-xl bg-card border">
              <div className="flex items-center gap-3">
                <span className="text-xl">{group.icon}</span>
                <div>
                  <h3 className="font-semibold text-foreground">{t(group.nameKey)}</h3>
                  <p className="text-xs text-muted-foreground">{t(group.descKey)}</p>
                </div>
              </div>
              <button onClick={() => toggleGroup(group.id)} className={cn("w-12 h-6 rounded-full transition-colors relative cursor-pointer", enabled ? "bg-emerald-500/20" : "bg-muted")}>
                <span className={cn("absolute top-1 w-4 h-4 rounded-full transition-all", enabled ? "right-1 bg-emerald-400" : "left-1 bg-muted-foreground")} />
              </button>
            </div>
          );
        })}

        {/* Lobster plugin */}
        <div className="flex items-center justify-between p-4 rounded-xl bg-card border">
          <div className="flex items-center gap-3">
            <span className="text-xl">{'\u{1F99E}'}</span>
            <div>
              <h3 className="font-semibold text-foreground">{t('settings.toolsConfig.lobsterName')}</h3>
              <p className="text-xs text-muted-foreground">{t('settings.toolsConfig.lobsterDesc')}</p>
            </div>
          </div>
          <button onClick={toggleLobster} className={cn("w-12 h-6 rounded-full transition-colors relative cursor-pointer", lobsterEnabled ? "bg-emerald-500/20" : "bg-muted")}>
            <span className={cn("absolute top-1 w-4 h-4 rounded-full transition-all", lobsterEnabled ? "right-1 bg-emerald-400" : "left-1 bg-muted-foreground")} />
          </button>
        </div>

        {/* Loop Detection */}
        <div className="flex items-center justify-between p-4 rounded-xl bg-card border">
          <div className="flex items-center gap-3">
            <span className="text-xl">{'\u{1F6E1}\uFE0F'}</span>
            <div>
              <h3 className="font-semibold text-foreground">{t('settings.toolsConfig.loopDetectionName')}</h3>
              <p className="text-xs text-muted-foreground">{t('settings.toolsConfig.loopDetectionDesc')}</p>
            </div>
          </div>
          <button onClick={toggleLoopDetection} className={cn("w-12 h-6 rounded-full transition-colors relative cursor-pointer", loopEnabled ? "bg-emerald-500/20" : "bg-muted")}>
            <span className={cn("absolute top-1 w-4 h-4 rounded-full transition-all", loopEnabled ? "right-1 bg-emerald-400" : "left-1 bg-muted-foreground")} />
          </button>
        </div>
      </div>

      <div className="p-4 rounded-xl bg-muted/40 border">
        <p className="text-xs text-muted-foreground">
          <Info className="w-4 h-4 inline mr-1" />
          {t('settings.toolsConfig.configNote')}
        </p>
      </div>
    </div>
  );
}
