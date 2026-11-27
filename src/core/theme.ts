import type { ThemePresetId, ThemeSettings } from './types';

export interface ThemePresetDefinition {
  id: Exclude<ThemePresetId, 'custom'>;
  label: string;
  description: string;
  colors: Omit<ThemeSettings, 'preset'>;
}

export const THEME_PRESETS: ThemePresetDefinition[] = [
  {
    id: 'white',
    label: 'White',
    description: 'Calm light paper workspace',
    colors: {
      bg: '#F7F8F9',
      surface: '#FFFFFF',
      sidebar: '#E8EBEF',
      accent: '#2A3FE0',
    },
  },
  {
    id: 'gray',
    label: 'Gray',
    description: 'Soft neutral charcoal',
    colors: {
      bg: '#21252B',
      surface: '#282C34',
      sidebar: '#1B1F24',
      accent: '#5C7CFA',
    },
  },
  {
    id: 'black',
    label: 'Black',
    description: 'Deep high-contrast dark',
    colors: {
      bg: '#090B0E',
      surface: '#11141A',
      sidebar: '#0D1015',
      accent: '#637BFF',
    },
  },
];

export function createDefaultTheme(): ThemeSettings {
  return {
    preset: 'white',
    ...THEME_PRESETS[0].colors,
  };
}

export function normalizeHexColor(input: string, fallback: string): string {
  const trimmed = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return fallback;
}

function parseHexRgb(hex: string): [number, number, number] {
  const safe = normalizeHexColor(hex, '#F7F8F9');
  const r = Number.parseInt(safe.slice(1, 3), 16);
  const g = Number.parseInt(safe.slice(3, 5), 16);
  const b = Number.parseInt(safe.slice(5, 7), 16);
  return [r, g, b];
}

export function mixHex(hexA: string, hexB: string, weightB: number): string {
  const w = Math.min(1, Math.max(0, weightB));
  const [r1, g1, b1] = parseHexRgb(hexA);
  const [r2, g2, b2] = parseHexRgb(hexB);
  const r = Math.round(r1 * (1 - w) + r2 * w);
  const g = Math.round(g1 * (1 - w) + g2 * w);
  const b = Math.round(b1 * (1 - w) + b2 * w);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

export function getRelativeLuminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function isDarkColor(hex: string): boolean {
  return getRelativeLuminance(hex) < 0.32;
}

export function computeThemeCssVariables(rawTheme?: Partial<ThemeSettings>): {
  mode: 'light' | 'dark';
  codeMode: 'light' | 'dark';
  vars: Record<string, string>;
} {
  const defaults = createDefaultTheme();
  const bg = normalizeHexColor(rawTheme?.bg ?? '', defaults.bg);
  const surface = normalizeHexColor(rawTheme?.surface ?? '', defaults.surface);
  const sidebar = normalizeHexColor(rawTheme?.sidebar ?? '', defaults.sidebar);
  const accent = normalizeHexColor(rawTheme?.accent ?? '', defaults.accent);

  const bgDark = isDarkColor(bg);
  const surfDark = isDarkColor(surface);
  const sideDark = isDarkColor(sidebar);
  const accentDark = isDarkColor(accent);
  const mode: 'light' | 'dark' = bgDark ? 'dark' : 'light';
  const codeMode: 'light' | 'dark' = surfDark ? 'dark' : 'light';

  const panel = mixHex(sidebar, bg, 0.36);
  const panelDark = isDarkColor(panel);
  const line = bgDark ? mixHex(bg, '#FFFFFF', 0.14) : mixHex(bg, '#161B26', 0.14);
  const lineSoft = bgDark ? mixHex(bg, '#FFFFFF', 0.08) : mixHex(bg, '#161B26', 0.07);
  const hover = sideDark ? mixHex(sidebar, '#FFFFFF', 0.1) : mixHex(sidebar, '#161B26', 0.06);
  const hold = sideDark ? mixHex(sidebar, '#FFFFFF', 0.22) : '#C6CCD6';
  const segFree = sideDark ? mixHex(sidebar, '#FFFFFF', 0.08) : '#EAEEF2';

  const ink = bgDark ? '#E8EDF5' : '#161B26';
  const ink2 = bgDark ? '#B3BDCE' : '#444D5C';
  const mute = bgDark ? '#838FA3' : '#778091';

  const surfInk = surfDark ? '#E8EDF5' : '#161B26';
  const surfInk2 = surfDark ? '#B3BDCE' : '#444D5C';
  const surfMute = surfDark ? '#838FA3' : '#778091';
  const surfLine = surfDark ? mixHex(surface, '#FFFFFF', 0.14) : mixHex(surface, '#161B26', 0.16);
  const surfHover = surfDark ? mixHex(surface, '#FFFFFF', 0.08) : '#DDE1E7';

  const sideInk = sideDark ? '#E8EDF5' : '#161B26';
  const sideInk2 = sideDark ? '#B3BDCE' : '#444D5C';
  const sideMute = sideDark ? '#838FA3' : '#778091';

  const panelInk = panelDark ? '#E8EDF5' : '#161B26';
  const panelInk2 = panelDark ? '#B3BDCE' : '#444D5C';
  const panelMute = panelDark ? '#838FA3' : '#778091';
  const panelLine = panelDark ? mixHex(panel, '#FFFFFF', 0.14) : mixHex(panel, '#161B26', 0.14);

  const accentHover = accentDark ? mixHex(accent, '#FFFFFF', 0.14) : mixHex(accent, '#000000', 0.15);
  const accentContrast = accentDark ? '#FFFFFF' : '#111827';
  const activePillBg = sideDark ? '#E8EDF5' : '#161B26';
  const activePillFg = sideDark ? '#11141A' : '#FFFFFF';
  const surfActiveBg = surfDark ? '#E8EDF5' : '#161B26';
  const surfActiveFg = surfDark ? '#11141A' : '#FFFFFF';
  const surfActiveBadgeBg = surfDark ? 'rgba(17, 20, 26, 0.16)' : 'rgba(255, 255, 255, 0.22)';

  // Derive code block surfaces solely from `surface` polarity so mixed custom themes never produce muddy mid-grays
  const codeBg = surfDark ? mixHex(surface, '#000000', 0.22) : mixHex(surface, '#161B26', 0.05);
  const codeHeader = surfDark ? mixHex(surface, '#FFFFFF', 0.06) : mixHex(surface, '#161B26', 0.09);
  const codeBorder = surfLine;
  const codeText = surfDark ? '#E6EDF3' : '#161B26';
  const codeMute = surfDark ? '#9BA7B9' : '#57606A';
  const inlineCodeBg = bgDark ? mixHex(bg, '#FFFFFF', 0.1) : mixHex(bg, '#161B26', 0.07);

  const success = bgDark ? '#4ADE80' : '#1D7A4E';
  const danger = bgDark ? '#F87171' : '#C8232C';
  const warn = bgDark ? '#FBBF24' : '#B45309';

  const successContrast = isDarkColor(success) ? '#FFFFFF' : '#0B1A10';
  const dangerContrast = isDarkColor(danger) ? '#FFFFFF' : '#1F0708';
  const warnContrast = isDarkColor(warn) ? '#FFFFFF' : '#1C1104';

  const vars: Record<string, string> = {
    '--lc-bg': bg,
    '--lc-surface': surface,
    '--lc-side': sidebar,
    '--lc-panel': panel,
    '--lc-accent': accent,
    '--lc-accent-hover': accentHover,
    '--lc-accent-contrast': accentContrast,
    '--lc-ink': ink,
    '--lc-ink2': ink2,
    '--lc-mute': mute,
    '--lc-surf-ink': surfInk,
    '--lc-surf-ink2': surfInk2,
    '--lc-surf-mute': surfMute,
    '--lc-surf-line': surfLine,
    '--lc-surf-hover': surfHover,
    '--lc-surf-active-bg': surfActiveBg,
    '--lc-surf-active-fg': surfActiveFg,
    '--lc-surf-active-badge-bg': surfActiveBadgeBg,
    '--lc-side-ink': sideInk,
    '--lc-side-ink2': sideInk2,
    '--lc-side-mute': sideMute,
    '--lc-panel-ink': panelInk,
    '--lc-panel-ink2': panelInk2,
    '--lc-panel-mute': panelMute,
    '--lc-panel-line': panelLine,
    '--lc-line': line,
    '--lc-line-soft': lineSoft,
    '--lc-hover': hover,
    '--lc-hold': hold,
    '--lc-seg-free': segFree,
    '--lc-seg-core': sideDark ? '#E2E8F0' : '#161B26',
    '--lc-seg-mem': '#8F9CF3',
    '--lc-seg-recent': '#F2D452',
    '--lc-seg-tpl': sideDark ? '#7E8899' : '#AAB2BF',
    '--lc-quote-bar': bgDark ? '#FACC15' : '#D9A700',
    '--lc-active-pill-bg': activePillBg,
    '--lc-active-pill-fg': activePillFg,
    '--lc-code-bg': codeBg,
    '--lc-code-header': codeHeader,
    '--lc-code-border': codeBorder,
    '--lc-code-text': codeText,
    '--lc-code-mute': codeMute,
    '--lc-inline-code-bg': inlineCodeBg,
    '--lc-success': success,
    '--lc-success-contrast': successContrast,
    '--lc-danger': danger,
    '--lc-danger-contrast': dangerContrast,
    '--lc-warn': warn,
    '--lc-warn-contrast': warnContrast,
    '--lc-callout-note': bgDark ? '#7B96FF' : '#2A3FE0',
    '--lc-callout-tip': bgDark ? '#4ADE80' : '#1D7A4E',
    '--lc-callout-important': bgDark ? '#C084FC' : '#6D28D9',
    '--lc-callout-warning': bgDark ? '#FBBF24' : '#B45309',
    '--lc-callout-caution': bgDark ? '#F87171' : '#C8232C',
    '--lc-tps-red': bgDark ? '#F87171' : '#DC2626',
    '--lc-tps-orange': bgDark ? '#FB923C' : '#EA580C',
    '--lc-tps-yellow': bgDark ? '#FACC15' : '#CA8A04',
    '--lc-tps-green': bgDark ? '#4ADE80' : '#16A34A',
    '--lc-contrib-0': surfDark ? mixHex(surface, '#FFFFFF', 0.08) : mixHex(surface, '#161B26', 0.07),
    '--lc-contrib-1': surfDark ? '#0E4429' : '#9BE9A8',
    '--lc-contrib-2': surfDark ? '#006D32' : '#40C463',
    '--lc-contrib-3': surfDark ? '#26A641' : '#30A14E',
    '--lc-contrib-4': surfDark ? '#39D353' : '#216E39',
  };

  return { mode, codeMode, vars };
}

export function getTpsTier(tps: number): 'red' | 'orange' | 'yellow' | 'green' {
  if (tps < 10) return 'red';
  if (tps < 25) return 'orange';
  if (tps < 50) return 'yellow';
  return 'green';
}

export function getTpsColorVar(tps: number): string {
  const tier = getTpsTier(tps);
  return `var(--lc-tps-${tier})`;
}

export function applyThemeToDocument(theme?: Partial<ThemeSettings>): void {
  if (typeof document === 'undefined') return;
  const { mode, codeMode, vars } = computeThemeCssVariables(theme);
  const root = document.documentElement;
  root.dataset.themeMode = mode;
  root.dataset.codeMode = codeMode;
  root.style.colorScheme = mode;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}
