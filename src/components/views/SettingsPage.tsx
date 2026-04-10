import { useParams, useNavigate } from 'react-router-dom';
import {
  Server,
  Globe,
  Bot,
  Cpu,
  Wrench,
  Settings2,
  Package,
} from 'lucide-react';
import { Header } from '../layout/Header';
import { cn } from '../../lib/utils';
import useTranslation from '../../i18n';
import type { TranslationKey } from '../../i18n';
import {
  ModelsSection,
  ChannelsSection,
  AgentsSection,
  ToolsSection,
  SkillsSection,
  GatewaySection,
  AppearanceSection,
} from '../settings';

type SettingsSection = 'models' | 'channels' | 'agents' | 'tools' | 'skills' | 'gateway' | 'appearance';

const settingsSections: Array<{
  id: SettingsSection;
  labelKey: TranslationKey;
  icon: React.ReactNode;
  descriptionKey: TranslationKey;
}> = [
  { id: 'models', labelKey: 'settings.providers.title', icon: <Cpu className="w-4 h-4" />, descriptionKey: 'settings.providers.description' },
  { id: 'channels', labelKey: 'settings.channelsConfig.title', icon: <Globe className="w-4 h-4" />, descriptionKey: 'settings.channelsConfig.description' },
  { id: 'agents', labelKey: 'settings.agentsConfig.title', icon: <Bot className="w-4 h-4" />, descriptionKey: 'settings.agentsConfig.description' },
  { id: 'tools', labelKey: 'settings.toolsConfig.title', icon: <Wrench className="w-4 h-4" />, descriptionKey: 'settings.toolsConfig.description' },
  { id: 'skills', labelKey: 'settings.skillsConfig.title', icon: <Package className="w-4 h-4" />, descriptionKey: 'settings.skillsConfig.description' },
  { id: 'gateway', labelKey: 'settings.gatewayConfig.title', icon: <Server className="w-4 h-4" />, descriptionKey: 'settings.gatewayConfig.description' },
  { id: 'appearance', labelKey: 'settings.appearanceConfig.title', icon: <Settings2 className="w-4 h-4" />, descriptionKey: 'settings.appearanceConfig.description' },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const valid: SettingsSection[] = ['models', 'channels', 'agents', 'tools', 'skills', 'gateway', 'appearance'];
  const activeSection = valid.includes(tab as SettingsSection) ? (tab as SettingsSection) : 'models';

  const setActiveSection = (section: SettingsSection) => {
    navigate(`/settings/${section}`, { replace: true });
  };

  const renderSection = () => {
    switch (activeSection) {
      case 'models': return <ModelsSection />;
      case 'channels': return <ChannelsSection />;
      case 'agents': return <AgentsSection />;
      case 'tools': return <ToolsSection />;
      case 'skills': return <SkillsSection />;
      case 'gateway': return <GatewaySection />;
      case 'appearance': return <AppearanceSection />;
    }
  };

  const currentSection = settingsSections.find(s => s.id === activeSection);

  return (
    <div className="h-screen flex flex-col bg-background">
      <Header title={t('settings.title')} description={t('settings.subtitle')} />
      <div className="flex flex-1 min-h-0">
        <div className="w-64 border-r border p-4 overflow-y-auto">
          <nav className="space-y-1">
            {settingsSections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors",
                  activeSection === section.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <span className={activeSection === section.id ? "text-primary" : ""}>{section.icon}</span>
                <div>
                  <p className="text-sm font-medium">{t(section.labelKey)}</p>
                  <p className="text-xs text-muted-foreground">{t(section.descriptionKey)}</p>
                </div>
              </button>
            ))}
          </nav>
        </div>
        <div className="flex-1 p-6 max-w-4xl overflow-y-auto">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              {currentSection?.icon}
            </div>
            <div>
              <h2 className="text-lg font-bold text-foreground">{currentSection ? t(currentSection.labelKey) : ''}</h2>
              <p className="text-sm text-muted-foreground">{currentSection ? t(currentSection.descriptionKey) : ''}</p>
            </div>
          </div>
          {renderSection()}
        </div>
      </div>
    </div>
  );
}
