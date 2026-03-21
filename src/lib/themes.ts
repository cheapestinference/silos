export interface ThemeColors {
  '--background': string;
  '--foreground': string;
  '--card': string;
  '--card-foreground': string;
  '--popover': string;
  '--popover-foreground': string;
  '--primary': string;
  '--primary-foreground': string;
  '--secondary': string;
  '--secondary-foreground': string;
  '--muted': string;
  '--muted-foreground': string;
  '--accent': string;
  '--accent-foreground': string;
  '--destructive': string;
  '--destructive-foreground': string;
  '--border': string;
  '--input': string;
  '--ring': string;
  '--sidebar-bg': string;
  '--sidebar-fg': string;
  '--sidebar-hover': string;
  '--sidebar-active': string;
  '--sidebar-border': string;
  '--success': string;
  '--success-foreground': string;
  '--warning': string;
  '--warning-foreground': string;
  '--info': string;
  '--info-foreground': string;
  '--accent-secondary': string;
  '--glow': string;
  '--surface-elevated': string;
  '--surface-sunken': string;
}

export interface Theme {
  id: string;
  name: string;
  preview: { bg: string; primary: string; accent: string };
  light: ThemeColors;
  dark: ThemeColors;
}

// Default — matches index.css exactly (blue accent)
const defaultTheme: Theme = {
  id: 'default',
  name: 'Default',
  preview: { bg: '#0f172a', primary: '#0080ff', accent: '#3b82f6' },
  light: {
    '--background': '220 14% 95%',
    '--foreground': '220 13% 18%',
    '--card': '0 0% 100%',
    '--card-foreground': '220 13% 18%',
    '--popover': '0 0% 100%',
    '--popover-foreground': '220 13% 18%',
    '--primary': '211 100% 50%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '220 14% 91%',
    '--secondary-foreground': '220 13% 18%',
    '--muted': '220 14% 91%',
    '--muted-foreground': '220 9% 40%',
    '--accent': '211 100% 50%',
    '--accent-foreground': '0 0% 100%',
    '--destructive': '0 84% 60%',
    '--destructive-foreground': '0 0% 100%',
    '--border': '220 14% 82%',
    '--input': '220 14% 82%',
    '--ring': '211 100% 50%',
    '--sidebar-bg': '220 14% 93%',
    '--sidebar-fg': '220 13% 18%',
    '--sidebar-hover': '220 14% 86%',
    '--sidebar-active': '211 100% 50%',
    '--sidebar-border': '220 14% 82%',
    '--success': '142 71% 45%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '220 13% 18%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--accent-secondary': '210 80% 60%',
    '--glow': '211 100% 50%',
    '--surface-elevated': '0 0% 100%',
    '--surface-sunken': '220 13% 93%',
  },
  dark: {
    '--background': '222 47% 11%',
    '--foreground': '210 40% 98%',
    '--card': '222 47% 14%',
    '--card-foreground': '210 40% 98%',
    '--popover': '222 47% 14%',
    '--popover-foreground': '210 40% 98%',
    '--primary': '211 100% 50%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '217 33% 17%',
    '--secondary-foreground': '210 40% 98%',
    '--muted': '217 33% 17%',
    '--muted-foreground': '215 20% 65%',
    '--accent': '211 100% 50%',
    '--accent-foreground': '0 0% 100%',
    '--destructive': '0 63% 31%',
    '--destructive-foreground': '210 40% 98%',
    '--border': '217 33% 17%',
    '--input': '217 33% 17%',
    '--ring': '211 100% 50%',
    '--sidebar-bg': '222 47% 14%',
    '--sidebar-fg': '210 40% 98%',
    '--sidebar-hover': '217 33% 17%',
    '--sidebar-active': '211 100% 50%',
    '--sidebar-border': '217 33% 17%',
    '--success': '142 71% 45%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '222 47% 11%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--accent-secondary': '210 80% 60%',
    '--glow': '211 100% 50%',
    '--surface-elevated': '222 47% 16%',
    '--surface-sunken': '222 47% 9%',
  },
};

// Midnight — rich purple, deep violet backgrounds
const midnightTheme: Theme = {
  id: 'midnight',
  name: 'Midnight',
  preview: { bg: '#1e1033', primary: '#a855f7', accent: '#c084fc' },
  light: {
    '--background': '270 20% 95%',
    '--foreground': '265 30% 15%',
    '--card': '275 35% 99%',
    '--card-foreground': '265 30% 15%',
    '--popover': '275 35% 99%',
    '--popover-foreground': '265 30% 15%',
    '--primary': '271 91% 60%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '270 20% 91%',
    '--secondary-foreground': '265 30% 15%',
    '--muted': '270 20% 91%',
    '--muted-foreground': '265 15% 40%',
    '--accent': '280 85% 58%',
    '--accent-foreground': '0 0% 100%',
    '--destructive': '0 84% 60%',
    '--destructive-foreground': '0 0% 100%',
    '--border': '270 18% 82%',
    '--input': '270 18% 82%',
    '--ring': '271 91% 60%',
    '--sidebar-bg': '272 20% 93%',
    '--sidebar-fg': '265 30% 15%',
    '--sidebar-hover': '270 20% 86%',
    '--sidebar-active': '271 91% 60%',
    '--sidebar-border': '270 18% 82%',
    '--success': '142 71% 45%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '265 30% 15%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--accent-secondary': '300 70% 65%',
    '--glow': '271 91% 65%',
    '--surface-elevated': '275 35% 99%',
    '--surface-sunken': '270 30% 91%',
  },
  dark: {
    '--background': '268 55% 8%',
    '--foreground': '270 30% 95%',
    '--card': '270 50% 12%',
    '--card-foreground': '270 30% 95%',
    '--popover': '270 50% 12%',
    '--popover-foreground': '270 30% 95%',
    '--primary': '271 91% 65%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '268 45% 16%',
    '--secondary-foreground': '270 30% 95%',
    '--muted': '268 45% 16%',
    '--muted-foreground': '270 25% 55%',
    '--accent': '280 80% 70%',
    '--accent-foreground': '0 0% 100%',
    '--destructive': '0 63% 31%',
    '--destructive-foreground': '270 30% 95%',
    '--border': '268 40% 18%',
    '--input': '268 40% 18%',
    '--ring': '271 91% 65%',
    '--sidebar-bg': '270 50% 10%',
    '--sidebar-fg': '270 30% 95%',
    '--sidebar-hover': '268 45% 16%',
    '--sidebar-active': '271 91% 65%',
    '--sidebar-border': '268 40% 14%',
    '--success': '142 71% 45%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '268 55% 8%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--accent-secondary': '300 70% 65%',
    '--glow': '271 91% 65%',
    '--surface-elevated': '270 50% 14%',
    '--surface-sunken': '268 55% 6%',
  },
};

// Silos — inspired by silosplatform.com: orange #FF6B35 accent, navy dark, clean surfaces
const silosTheme: Theme = {
  id: 'silos',
  name: 'Silos',
  preview: { bg: '#1a1a2e', primary: '#FF6B35', accent: '#FF8C5A' },
  light: {
    '--background': '220 12% 95%',
    '--foreground': '240 10% 10%',
    '--card': '0 0% 100%',
    '--card-foreground': '240 10% 10%',
    '--popover': '0 0% 100%',
    '--popover-foreground': '240 10% 10%',
    '--primary': '16 100% 60%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '220 12% 91%',
    '--secondary-foreground': '240 10% 10%',
    '--muted': '220 12% 91%',
    '--muted-foreground': '220 10% 40%',
    '--accent': '16 100% 60%',
    '--accent-foreground': '0 0% 100%',
    '--destructive': '0 84% 60%',
    '--destructive-foreground': '0 0% 100%',
    '--border': '220 12% 82%',
    '--input': '220 12% 82%',
    '--ring': '16 100% 60%',
    '--sidebar-bg': '220 12% 93%',
    '--sidebar-fg': '240 10% 10%',
    '--sidebar-hover': '220 12% 86%',
    '--sidebar-active': '16 100% 60%',
    '--sidebar-border': '220 12% 82%',
    '--success': '160 84% 39%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '240 10% 10%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--accent-secondary': '30 90% 55%',
    '--glow': '16 100% 60%',
    '--surface-elevated': '0 0% 100%',
    '--surface-sunken': '220 15% 93%',
  },
  dark: {
    '--background': '250 18% 9%',
    '--foreground': '240 10% 95%',
    '--card': '248 16% 13%',
    '--card-foreground': '240 10% 95%',
    '--popover': '248 16% 13%',
    '--popover-foreground': '240 10% 95%',
    '--primary': '16 100% 60%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '248 14% 17%',
    '--secondary-foreground': '240 10% 95%',
    '--muted': '248 14% 17%',
    '--muted-foreground': '245 10% 58%',
    '--accent': '20 95% 65%',
    '--accent-foreground': '0 0% 100%',
    '--destructive': '0 63% 31%',
    '--destructive-foreground': '240 10% 95%',
    '--border': '248 12% 20%',
    '--input': '248 12% 20%',
    '--ring': '16 100% 60%',
    '--sidebar-bg': '250 18% 11%',
    '--sidebar-fg': '240 10% 95%',
    '--sidebar-hover': '248 14% 17%',
    '--sidebar-active': '16 100% 60%',
    '--sidebar-border': '248 12% 16%',
    '--success': '160 84% 39%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '250 18% 9%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--accent-secondary': '30 90% 55%',
    '--glow': '16 100% 60%',
    '--surface-elevated': '248 16% 16%',
    '--surface-sunken': '250 18% 7%',
  },
};

// Sunset — warm amber/orange, cozy feel
const sunsetTheme: Theme = {
  id: 'sunset',
  name: 'Sunset',
  preview: { bg: '#1c1208', primary: '#f59e0b', accent: '#fb923c' },
  light: {
    '--background': '35 20% 95%',
    '--foreground': '25 35% 12%',
    '--card': '35 35% 99%',
    '--card-foreground': '25 35% 12%',
    '--popover': '35 35% 99%',
    '--popover-foreground': '25 35% 12%',
    '--primary': '38 92% 50%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '35 22% 91%',
    '--secondary-foreground': '25 35% 12%',
    '--muted': '35 22% 91%',
    '--muted-foreground': '28 15% 38%',
    '--accent': '25 95% 53%',
    '--accent-foreground': '0 0% 100%',
    '--destructive': '0 84% 60%',
    '--destructive-foreground': '0 0% 100%',
    '--border': '35 20% 82%',
    '--input': '35 20% 82%',
    '--ring': '38 92% 50%',
    '--sidebar-bg': '36 18% 93%',
    '--sidebar-fg': '25 35% 12%',
    '--sidebar-hover': '35 20% 86%',
    '--sidebar-active': '38 92% 50%',
    '--sidebar-border': '35 20% 82%',
    '--success': '142 71% 45%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '25 35% 12%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--accent-secondary': '25 95% 53%',
    '--glow': '38 92% 50%',
    '--surface-elevated': '35 35% 99%',
    '--surface-sunken': '35 35% 90%',
  },
  dark: {
    '--background': '25 50% 6%',
    '--foreground': '35 30% 93%',
    '--card': '28 45% 10%',
    '--card-foreground': '35 30% 93%',
    '--popover': '28 45% 10%',
    '--popover-foreground': '35 30% 93%',
    '--primary': '38 92% 50%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '25 40% 14%',
    '--secondary-foreground': '35 30% 93%',
    '--muted': '25 40% 14%',
    '--muted-foreground': '30 20% 48%',
    '--accent': '25 95% 53%',
    '--accent-foreground': '0 0% 100%',
    '--destructive': '0 63% 31%',
    '--destructive-foreground': '35 30% 93%',
    '--border': '25 35% 16%',
    '--input': '25 35% 16%',
    '--ring': '38 92% 50%',
    '--sidebar-bg': '25 48% 8%',
    '--sidebar-fg': '35 30% 93%',
    '--sidebar-hover': '25 40% 14%',
    '--sidebar-active': '38 92% 50%',
    '--sidebar-border': '25 35% 12%',
    '--success': '142 71% 45%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '25 50% 6%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--accent-secondary': '25 95% 53%',
    '--glow': '38 92% 50%',
    '--surface-elevated': '28 45% 13%',
    '--surface-sunken': '25 50% 5%',
  },
};

// Rose — pink/fuchsia, vibrant feel
const roseTheme: Theme = {
  id: 'rose',
  name: 'Rose',
  preview: { bg: '#1c0a14', primary: '#ec4899', accent: '#f472b6' },
  light: {
    '--background': '340 16% 95%',
    '--foreground': '335 30% 12%',
    '--card': '345 30% 99%',
    '--card-foreground': '335 30% 12%',
    '--popover': '345 30% 99%',
    '--popover-foreground': '335 30% 12%',
    '--primary': '330 81% 60%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '340 18% 91%',
    '--secondary-foreground': '335 30% 12%',
    '--muted': '340 18% 91%',
    '--muted-foreground': '335 15% 38%',
    '--accent': '338 76% 55%',
    '--accent-foreground': '0 0% 100%',
    '--destructive': '0 84% 60%',
    '--destructive-foreground': '0 0% 100%',
    '--border': '340 16% 82%',
    '--input': '340 16% 82%',
    '--ring': '330 81% 60%',
    '--sidebar-bg': '342 14% 93%',
    '--sidebar-fg': '335 30% 12%',
    '--sidebar-hover': '340 16% 86%',
    '--sidebar-active': '330 81% 60%',
    '--sidebar-border': '340 16% 82%',
    '--success': '142 71% 45%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '335 30% 12%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--accent-secondary': '350 80% 65%',
    '--glow': '330 81% 60%',
    '--surface-elevated': '345 30% 99%',
    '--surface-sunken': '340 30% 91%',
  },
  dark: {
    '--background': '338 45% 7%',
    '--foreground': '340 25% 93%',
    '--card': '340 40% 11%',
    '--card-foreground': '340 25% 93%',
    '--popover': '340 40% 11%',
    '--popover-foreground': '340 25% 93%',
    '--primary': '330 81% 60%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '338 35% 15%',
    '--secondary-foreground': '340 25% 93%',
    '--muted': '338 35% 15%',
    '--muted-foreground': '340 20% 48%',
    '--accent': '330 70% 62%',
    '--accent-foreground': '0 0% 100%',
    '--destructive': '0 63% 31%',
    '--destructive-foreground': '340 25% 93%',
    '--border': '338 30% 17%',
    '--input': '338 30% 17%',
    '--ring': '330 81% 60%',
    '--sidebar-bg': '340 42% 9%',
    '--sidebar-fg': '340 25% 93%',
    '--sidebar-hover': '338 35% 15%',
    '--sidebar-active': '330 81% 60%',
    '--sidebar-border': '338 30% 13%',
    '--success': '142 71% 45%',
    '--success-foreground': '0 0% 100%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '338 45% 7%',
    '--info': '199 89% 48%',
    '--info-foreground': '0 0% 100%',
    '--accent-secondary': '350 80% 65%',
    '--glow': '330 81% 60%',
    '--surface-elevated': '340 40% 13%',
    '--surface-sunken': '338 45% 6%',
  },
};

export const themes: Theme[] = [
  defaultTheme,
  midnightTheme,
  silosTheme,
  sunsetTheme,
  roseTheme,
];

export function getTheme(id: string): Theme {
  return themes.find(t => t.id === id) || defaultTheme;
}

export function applyTheme(themeId: string, isDark: boolean) {
  const theme = getTheme(themeId);
  const colors = isDark ? theme.dark : theme.light;
  const root = document.documentElement.style;

  // Default theme uses index.css values — clear overrides
  if (themeId === 'default') {
    for (const key of Object.keys(colors)) {
      root.removeProperty(key);
    }
    return;
  }

  for (const [key, value] of Object.entries(colors)) {
    root.setProperty(key, value);
  }
}
