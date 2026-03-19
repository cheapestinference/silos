import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import de from './locales/de.json';

export type Locale = 'en' | 'es' | 'fr' | 'de';

export const locales: Record<Locale, { label: string; flag: string }> = {
  en: { label: 'English', flag: '🇺🇸' },
  es: { label: 'Español', flag: '🇪🇸' },
  fr: { label: 'Français', flag: '🇫🇷' },
  de: { label: 'Deutsch', flag: '🇩🇪' },
};

const translations: Record<Locale, typeof en> = {
  en,
  es,
  fr,
  de,
};

// Read locale from silos-locale cookie (set by server from provisioning env)
function getCookieLocale(): Locale | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)silos-locale=([a-z]{2})/);
  if (match && match[1] in locales) return match[1] as Locale;
  return null;
}

// Detect locale: cookie > browser language > 'en'
function detectLocale(): Locale {
  return getCookieLocale() || detectBrowserLocale();
}

function detectBrowserLocale(): Locale {
  if (typeof navigator !== 'undefined') {
    const browserLang = navigator.language.split('-')[0];
    if (browserLang in locales) return browserLang as Locale;
  }
  return 'en';
}

// Type-safe path accessor for nested objects
type PathsToStringProps<T> = T extends string
  ? []
  : {
      [K in Extract<keyof T, string>]: [K, ...PathsToStringProps<T[K]>];
    }[Extract<keyof T, string>];

type Join<T extends string[], D extends string> = T extends []
  ? never
  : T extends [infer F]
  ? F
  : T extends [infer F, ...infer R]
  ? F extends string
    ? `${F}${D}${Join<Extract<R, string[]>, D>}`
    : never
  : string;

export type TranslationKey = Join<PathsToStringProps<typeof en>, '.'>;

// Get nested value from object by path
function getNestedValue(obj: Record<string, unknown>, path: string): string {
  const keys = path.split('.');
  let value: unknown = obj;

  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = (value as Record<string, unknown>)[key];
    } else {
      return path; // Return path if not found
    }
  }

  return typeof value === 'string' ? value : path;
}

// i18n Store
interface I18nStore {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useI18nStore = create<I18nStore>()(
  persist(
    (set) => ({
      locale: detectLocale(),
      setLocale: (locale) => set({ locale }),
    }),
    {
      name: 'silos-i18n-v2',
      // localStorage (user's explicit choice) wins over cookie.
      // Cookie from landing page (.silosplatform.com) is only used as initial seed
      // when no localStorage preference exists yet.
      merge: (persisted, current) => {
        const stored = (persisted as Partial<I18nStore>)?.locale;
        if (stored && stored in locales) return { ...current, locale: stored };
        const cookie = getCookieLocale();
        if (cookie) return { ...current, locale: cookie };
        return current;
      },
    }
  )
);


// Main translation hook
export function useTranslation() {
  const { locale, setLocale } = useI18nStore();

  const t = (key: TranslationKey, params?: Record<string, string | number>): string => {
    let translation = getNestedValue(translations[locale] as Record<string, unknown>, key);

    // Replace parameters like {count} with actual values
    if (params) {
      Object.entries(params).forEach(([paramKey, paramValue]) => {
        translation = translation.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
      });
    }

    return translation;
  };

  return {
    t,
    locale,
    setLocale,
    locales,
  };
}

// Direct translation function for use outside React components
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const locale = useI18nStore.getState().locale;
  let translation = getNestedValue(translations[locale] as Record<string, unknown>, key);

  if (params) {
    Object.entries(params).forEach(([paramKey, paramValue]) => {
      translation = translation.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
    });
  }

  return translation;
}

export default useTranslation;
