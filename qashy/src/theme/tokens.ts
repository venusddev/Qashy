export const QASHY_INDIGO = '#5966E9';

export const ACCENT_PRESETS = [
  '#5966E9',
  '#007AFF',
  '#00A58E',
  '#36A852',
  '#E7892C',
  '#E0516B',
  '#A95BCD',
  '#6D7885',
] as const;

export const radius = { card: 16, control: 10 } as const;

export interface BaseTokens {
  background: string;
  surface: string;
  surfaceElevated: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  border: string;
  positive: string;
  negative: string;
  warning: string;
}

export const lightTokens: BaseTokens = {
  background: '#F6F7F9',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  surfaceMuted: '#EEF0F3',
  text: '#191B20',
  textMuted: '#5F6570',
  border: '#E3E5EA',
  positive: '#208653',
  negative: '#C43D4A',
  warning: '#9A6700',
};

export const darkTokens: BaseTokens = {
  background: '#0E0F13',
  surface: '#16171C',
  surfaceElevated: '#1D1F26',
  surfaceMuted: '#23252C',
  text: '#F2F3F5',
  textMuted: '#9BA1AC',
  border: '#2A2D35',
  positive: '#65D99A',
  negative: '#FF8F96',
  warning: '#F0C36A',
};

function channels(hex: string): [number, number, number] {
  let value = hex.replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  const parsed = Number.parseInt(value.slice(0, 6), 16);
  if (!Number.isFinite(parsed)) return [0, 0, 0];
  return [(parsed >> 16) & 0xff, (parsed >> 8) & 0xff, parsed & 0xff];
}

function toHex(rgb: [number, number, number]) {
  return `#${rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('')}`;
}

export function relativeLuminance(hex: string) {
  const [r, g, b] = channels(hex).map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(first: string, second: string) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

export function readableTextColor(hex: string): '#FFFFFF' | '#000000' {
  return contrastRatio('#FFFFFF', hex) >= contrastRatio('#000000', hex) ? '#FFFFFF' : '#000000';
}

export function mixHex(from: string, to: string, weight: number) {
  const a = channels(from);
  const b = channels(to);
  const t = Math.min(1, Math.max(0, weight));
  return toHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

export function ensureContrast(
  foreground: string,
  background: string,
  fallback: string,
  minimum = 4.5,
) {
  if (contrastRatio(foreground, background) >= minimum) return foreground.toUpperCase();
  const safeFallback = contrastRatio(fallback, background) >= minimum
    ? fallback
    : readableTextColor(background);
  let low = 0;
  let high = 1;
  for (let index = 0; index < 18; index += 1) {
    const midpoint = (low + high) / 2;
    if (contrastRatio(mixHex(foreground, safeFallback, midpoint), background) >= minimum) {
      high = midpoint;
    } else {
      low = midpoint;
    }
  }
  return mixHex(foreground, safeFallback, high).toUpperCase();
}

export function accessibleAccentColor(seed: string, surface: string, text: string) {
  return ensureContrast(seed, surface, text, 3);
}
