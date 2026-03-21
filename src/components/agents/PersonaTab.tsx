import { Sparkles, HelpCircle } from 'lucide-react';
import { Textarea } from '../ui/textarea';
import { useTranslation } from '../../i18n';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';

interface PersonaTabProps {
  value: string;
  onChange: (value: string) => void;
}

export function PersonaTab({ value, onChange }: PersonaTabProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold">{t('agents.config.systemPrompt')}</h3>
        <Tooltip>
          <TooltipTrigger>
            <HelpCircle className="w-4 h-4 text-muted-foreground cursor-help" />
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs">
            {t('agents.config.systemPromptDesc')}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Description */}
      <p className="text-sm text-muted-foreground">
        {t('agents.config.systemPromptDesc')}
      </p>

      {/* Editor */}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('agents.config.systemPromptPlaceholder')}
        className="min-h-[300px] font-mono text-sm resize-none"
      />

      {/* Tips */}
      <div className="rounded-lg bg-primary/10 border border-primary/20 p-4">
        <h4 className="text-sm font-medium text-primary mb-2">Tips</h4>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
          <li>Define the agent's role and expertise clearly</li>
          <li>Specify the tone and communication style</li>
          <li>Include any constraints or guidelines</li>
          <li>Use markdown for formatting if needed</li>
        </ul>
      </div>

      {/* Character count */}
      <div className="text-xs text-muted-foreground text-right">
        {value.length.toLocaleString()} characters
      </div>
    </div>
  );
}
