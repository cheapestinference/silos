import { useState } from 'react';
import { cn } from '../../lib/utils';
import { SectionLabel } from './shared';

export type ChannelFieldDef = {
  key: string;
  label: string;
  type: 'select' | 'text' | 'phone-list' | 'toggle';
  options?: Array<{ value: string; label: string; description?: string }>;
  defaultValue?: unknown;
  placeholder?: string;
  description?: string;
};

interface ChannelFieldRendererProps {
  fields: ChannelFieldDef[];
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

export function ChannelFieldRenderer({ fields, config, onChange }: ChannelFieldRendererProps) {
  const [phoneInput, setPhoneInput] = useState('');

  return (
    <>
      {fields.map((field) => (
        <div key={field.key}>
          <SectionLabel className="mb-1">
            {field.label}
          </SectionLabel>
          {field.description && (
            <p className="text-[10px] text-muted-foreground mb-1">{field.description}</p>
          )}

          {field.type === 'select' && (
            <div className="flex flex-wrap gap-2">
              {field.options?.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    const updated = { ...config, [field.key]: opt.value };
                    if (field.key === 'dmPolicy' && opt.value === 'open') {
                      updated.allowFrom = ['*'];
                    }
                    onChange(updated);
                  }}
                  className={cn(
                    "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                    config[field.key] === opt.value
                      ? "bg-primary/20 text-primary border-primary/40"
                      : "bg-muted text-muted-foreground border hover:border-foreground/20"
                  )}
                >
                  <span className="font-medium">{opt.label}</span>
                  {opt.description && <span className="text-muted-foreground ml-1">— {opt.description}</span>}
                </button>
              ))}
            </div>
          )}

          {field.type === 'text' && (
            <input
              type={field.key.toLowerCase().includes('token') || field.key.toLowerCase().includes('key') ? 'password' : 'text'}
              placeholder={field.placeholder}
              value={(config[field.key] as string) || ''}
              onChange={(e) => onChange({ ...config, [field.key]: e.target.value })}
              className="w-full px-3 py-2 rounded-lg bg-muted border text-foreground text-sm font-mono focus:outline-none focus:border-ring"
            />
          )}

          {field.type === 'phone-list' && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {((config[field.key] as string[]) || []).map((phone, i) => (
                  <span key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/15 text-primary text-xs font-mono">
                    {phone}
                    <button
                      onClick={() => {
                        const list = [...((config[field.key] as string[]) || [])];
                        list.splice(i, 1);
                        onChange({ ...config, [field.key]: list });
                      }}
                      className="ml-0.5 text-primary hover:text-red-600 dark:text-red-400"
                    >×</button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder={field.placeholder}
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && phoneInput.trim()) {
                      const list = [...((config[field.key] as string[]) || []), phoneInput.trim()];
                      onChange({ ...config, [field.key]: list });
                      setPhoneInput('');
                    }
                  }}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-muted border text-foreground text-sm font-mono focus:outline-none focus:border-ring"
                />
                <button
                  onClick={() => {
                    if (phoneInput.trim()) {
                      const list = [...((config[field.key] as string[]) || []), phoneInput.trim()];
                      onChange({ ...config, [field.key]: list });
                      setPhoneInput('');
                    }
                  }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-muted text-muted-foreground hover:bg-muted"
                >
                  Add
                </button>
              </div>
            </div>
          )}

          {field.type === 'toggle' && (
            <button
              onClick={() => onChange({ ...config, [field.key]: !config[field.key] })}
              className={cn(
                "w-10 h-5 rounded-full transition-colors relative",
                config[field.key] ? "bg-primary/40" : "bg-muted"
              )}
            >
              <span className={cn(
                "absolute top-0.5 w-4 h-4 rounded-full transition-all",
                config[field.key] ? "right-0.5 bg-primary" : "left-0.5 bg-muted-foreground"
              )} />
            </button>
          )}
        </div>
      ))}
    </>
  );
}
