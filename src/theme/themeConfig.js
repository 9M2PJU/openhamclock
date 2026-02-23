export const THEME_COLOR_CONFIG = {
  '--bg-primary': { label: 'Primary Background', alpha: false, hueRestrict: null },
  '--bg-secondary': { label: 'Secondary Background', alpha: false, hueRestrict: null },
  '--bg-tertiary': { label: 'Tertiary Background', alpha: false, hueRestrict: null },
  '--bg-panel': { label: 'Panel Background', alpha: false, hueRestrict: null },
  '--border-color': { label: 'Border Color', alpha: true, hueRestrict: null },
  '--text-primary': { label: 'Primary Text', alpha: false, hueRestrict: null },
  '--text-secondary': { label: 'Secondary Text', alpha: false, hueRestrict: null },
  '--text-muted': { label: 'Muted Text', alpha: false, hueRestrict: null },
  '--map-ocean': { label: 'Map Ocean', alpha: false, hueRestrict: null },
  '--accent-amber': { label: 'Amber Accent', alpha: false, hueRestrict: 45 },
  '--accent-amber-dim': { label: 'Amber Accent (dim)', alpha: false, hueRestrict: 45 },
  '--accent-green': { label: 'Green Accent', alpha: false, hueRestrict: 120 },
  '--accent-green-dim': { label: 'Green Accent (dim)', alpha: false, hueRestrict: 120 },
  '--accent-red': { label: 'Red Accent', alpha: false, hueRestrict: 0 },
  '--accent-blue': { label: 'Blue Accent', alpha: false, hueRestrict: 240 },
  '--accent-cyan': { label: 'Cyan Accent', alpha: false, hueRestrict: 180 },
  '--accent-purple': { label: 'Purple Accent', alpha: false, hueRestrict: 277 },
};

export const PREBUILT_THEMES = {
  dark: { label: 'Dark', icon: '🌙' },
  light: { label: 'Light', icon: '☀️' },
  legacy: { label: 'Legacy', icon: '💻' },
  retro: { label: 'Retro', icon: '🪟' },
  custom: { label: 'Custom', icon: '🎨' },
};

export const THEME_VARS = Object.keys(THEME_COLOR_CONFIG);
