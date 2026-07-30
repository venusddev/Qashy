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

/**
 * The spacing scale. Every gap, padding, and inset in the app comes from here.
 *
 * Before this existed the codebase used fifteen different gap values — 1, 2, 4,
 * 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22 — typed at the call site, so no two
 * screens breathed the same way and a card's internal rhythm depended on which
 * feature owned it. A 4pt scale (plus a 2pt hairline step for text stacks) is
 * coarse enough that neighbouring values read as deliberate steps rather than as
 * noise.
 */
export const space = {
  /** Between two lines that belong to the same thought (title over subtitle). */
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/**
 * Corner radii. `control` and `card` keep their original values so the app's
 * existing silhouette is preserved; the rest name radii that were previously
 * inlined as bare numbers (7, 13, 14, 15, 22, 99, 999).
 */
export const radius = {
  sm: 8,
  control: 10,
  /** Icon tiles, swatches, and other small filled squares. */
  tile: 12,
  card: 16,
  /** Floating overlays: the update prompt, the reload banner. */
  sheet: 22,
  pill: 999,
} as const;

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

/**
 * Light surfaces.
 *
 * `surfaceElevated` is deliberately identical to `surface`: white is already the
 * top of the light ramp, so there is nowhere further up to go. Light-mode
 * elevation is therefore carried entirely by shadow and by the *absence* of a
 * border (see `shadowRaised` and the Card `hero` variant), never by lightness.
 * Dark mode inverts that — see `darkTokens`.
 *
 * `background` is asserted by the web e2e suite as the address-bar theme color.
 */
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

/**
 * Dark surfaces.
 *
 * The ramp used to span `#0E0F13 → #16171C → #1D1F26 → #23252C`, which put only
 * a few luminance steps between a card and an "elevated" card. Shadows are
 * effectively invisible against a dark page, so with the ramp that tight nothing
 * conveyed depth at all and every surface read as one flat plane. Widening it
 * gives each tier a visible step, which is how elevation has to work here.
 */
export const darkTokens: BaseTokens = {
  background: '#0C0D11',
  surface: '#15161B',
  surfaceElevated: '#1E2027',
  surfaceMuted: '#262931',
  text: '#F2F3F5',
  textMuted: '#9BA1AC',
  border: '#2E323B',
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

export interface ToneColors {
  /** A tinted fill that stays a surface, not a shout. */
  container: string;
  /** A glyph or label color that clears 3:1 against `container`. */
  onContainer: string;
}

/**
 * Turns a user-chosen entity color (category, budget, goal) into a container +
 * on-container pair, the same way the theme derives `accentContainer`.
 *
 * Category colors used to be painted at full saturation across 44pt tiles, so a
 * transaction list with eight categories read as eight competing signal lights
 * and the amount — the thing a ledger is actually for — lost the fight. Tinting
 * the fill toward the surface keeps every category distinguishable at a glance
 * while leaving the strongest contrast in the row for the number.
 *
 * `surface` and `text` must be real hex. Under Android's Material You the theme
 * exposes opaque platform colors with no JS-readable value, which is what
 * `staticSurface`/`staticText` on ThemeTokens are for.
 */
export function toneColors(seed: string, surface: string, text: string, dark: boolean): ToneColors {
  const container = mixHex(seed, surface, dark ? 0.78 : 0.86);
  return { container, onContainer: ensureContrast(seed, container, text, 3) };
}
