// Runtime config injected by server.js into window.__RUNTIME_CONFIG__.
// Falls back to Vite build-time values (import.meta.env).

declare global {
  interface Window {
    __RUNTIME_CONFIG__?: Record<string, string>;
  }
}

function env(key: string): string {
  return window.__RUNTIME_CONFIG__?.[key]
    || (import.meta.env[key] as string)
    || '';
}

export const PRESET_MODELS = [
  { key: 'basic', labelKey: 'modelSelector.basic', model: env('VITE_PRESET_BASICA') || 'Qwen/Qwen3.5-35B-A3B' },
  { key: 'high', labelKey: 'modelSelector.high', model: env('VITE_PRESET_ALTA') || 'Qwen/Qwen3.5-122B-A10B' },
  { key: 'excellent', labelKey: 'modelSelector.excellent', model: env('VITE_PRESET_EXCELENTE') || 'moonshotai/Kimi-K2.5' },
] as const;
