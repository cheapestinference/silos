import { useState, useEffect } from 'react';
import { Moon, Sun, Zap } from 'lucide-react';
import { useDashboardStore } from '../../store/dashboard-store';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import type { Locale } from '../../i18n';
import { themes } from '../../lib/themes';

export function AppearanceSection() {
  const { darkMode, setDarkMode, theme, setTheme, gatewayConfig } = useDashboardStore();
  const { t, locale, setLocale, locales: availableLocales } = useTranslation();
  const [silosVersion, setSilosVersion] = useState<string | null>(null);
  const [openclawVersion, setOpenclawVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        if (data.version) setSilosVersion(data.version);
        if (data.openclawVersion) setOpenclawVersion(data.openclawVersion);
      })
      .catch(() => {});
  }, []);

  // Fallback: try to get OpenClaw version from gateway config if /api/config didn't provide it
  const rawConfig = gatewayConfig?.config as Record<string, unknown> | undefined;
  const gatewayVersion = rawConfig?.version as string | undefined;
  const displayOpenclawVersion = openclawVersion || gatewayVersion || null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('settings.subtitle')}</p>

      {/* Theme picker */}
      <div className="p-4 rounded-xl bg-card border space-y-3">
        <div>
          <p className="font-semibold text-foreground">{t('settings.appearance.theme')}</p>
          <p className="text-xs text-muted-foreground">{t('settings.appearanceConfig.themeDesc')}</p>
        </div>
        <div className="grid grid-cols-5 gap-2">
          {themes.map((th) => {
            const isActive = theme === th.id;
            const colors = darkMode ? th.preview : th.preview;
            return (
              <button
                key={th.id}
                onClick={() => setTheme(th.id)}
                className={cn(
                  "flex flex-col items-center gap-1.5 p-2.5 rounded-lg border-2 transition-all",
                  isActive
                    ? "border-primary ring-2 ring-primary/20 bg-primary/5"
                    : "border-transparent hover:border-border hover:bg-muted/40"
                )}
              >
                {/* Color preview */}
                <div className="w-full aspect-[4/3] rounded-md overflow-hidden border border-border/40 relative" style={{ backgroundColor: darkMode ? '#111' : '#f5f5f5' }}>
                  <div className="absolute inset-x-0 top-0 h-2" style={{ backgroundColor: colors.primary }} />
                  <div className="absolute left-1 top-3 right-1 bottom-1 rounded-sm" style={{ backgroundColor: colors.bg }} />
                  <div className="absolute left-2 top-4 w-3 h-1 rounded-full" style={{ backgroundColor: colors.primary }} />
                  <div className="absolute left-2 top-6 right-2 h-0.5 rounded-full" style={{ backgroundColor: colors.accent, opacity: 0.5 }} />
                  <div className="absolute left-2 top-7.5 right-4 h-0.5 rounded-full" style={{ backgroundColor: colors.accent, opacity: 0.3 }} />
                </div>
                <span className={cn("text-[10px] font-medium", isActive ? "text-primary" : "text-muted-foreground")}>{th.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Light/Dark toggle */}
      <div className="flex items-center justify-between p-4 rounded-xl bg-card border">
        <div>
          <p className="font-semibold text-foreground">Mode</p>
          <p className="text-xs text-muted-foreground">Light or dark appearance</p>
        </div>
        <div className="flex items-center gap-1 p-1 rounded-lg bg-muted">
          <button
            onClick={() => setDarkMode(false)}
            className={cn("flex items-center gap-2 px-3 py-1.5 text-sm rounded-md", !darkMode ? "bg-amber-500/20 text-amber-600 dark:text-amber-300" : "text-muted-foreground")}
          >
            <Sun className="w-4 h-4" /> {t('settings.appearance.lightMode')}
          </button>
          <button
            onClick={() => setDarkMode(true)}
            className={cn("flex items-center gap-2 px-3 py-1.5 text-sm rounded-md", darkMode ? "bg-primary/20 text-primary" : "text-muted-foreground")}
          >
            <Moon className="w-4 h-4" /> {t('settings.appearance.darkMode')}
          </button>
        </div>
      </div>

      {/* Language */}
      <div className="p-4 rounded-xl bg-card border space-y-3">
        <div>
          <p className="font-semibold text-foreground">{t('settings.appearance.language')}</p>
          <p className="text-xs text-muted-foreground">{t('settings.appearance.languageDesc')}</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {(Object.keys(availableLocales) as Locale[]).map((loc) => (
            <button
              key={loc}
              onClick={() => setLocale(loc)}
              className={cn(
                "flex items-center justify-between px-3 py-2.5 rounded-lg border-2 transition-all text-left",
                locale === loc
                  ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                  : "border-transparent bg-muted/40 hover:border-border hover:bg-muted/60"
              )}
            >
              <div className="flex flex-col">
                <span className={cn("text-sm font-medium", locale === loc ? "text-primary" : "text-foreground")}>{availableLocales[loc].nativeName}</span>
                <span className="text-[10px] text-muted-foreground">{availableLocales[loc].label}</span>
              </div>
              <span className={cn("text-[10px] font-mono uppercase", locale === loc ? "text-primary/60" : "text-muted-foreground/50")}>{loc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* About */}
      <div className="p-4 rounded-xl bg-card border space-y-3">
        <div className="flex items-center gap-3">
          <Zap className="w-6 h-6 text-primary" />
          <p className="font-semibold text-foreground">{t('settings.aboutConfig.silosDashboard')}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/40">
            <span className="text-xs text-muted-foreground">{t('settings.aboutConfig.dashboardVersion')}</span>
            <span className="text-xs font-mono text-primary">{silosVersion ? `v${silosVersion}` : '\u2014'}</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/40">
            <span className="text-xs text-muted-foreground">{t('settings.aboutConfig.openclawVersion')}</span>
            <span className="text-xs font-mono text-primary">{displayOpenclawVersion ? `v${displayOpenclawVersion}` : '\u2014'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
