import { Host } from '@expo/ui';
import { Color, DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router';
import { createContext, use, useEffect, useMemo, type ReactNode } from 'react';
import {
  Appearance,
  Platform,
  type ColorValue,
  useColorScheme,
} from 'react-native';

import { QASHY_ACCENT } from '@/domain/defaults';
import { useLocalization } from '@/localization/localization';
import { useFinanceState } from '@/providers/finance-provider';
import {
  accessibleAccentColor,
  darkTokens,
  ensureContrast,
  lightTokens,
  mixHex,
  readableTextColor,
} from '@/theme/tokens';

export interface ThemeTokens {
  mode: 'light' | 'dark';
  accent: ColorValue;
  onAccent: ColorValue;
  accentContainer: ColorValue;
  onAccentContainer: ColorValue;
  background: ColorValue;
  surface: ColorValue;
  surfaceElevated: ColorValue;
  surfaceMuted: ColorValue;
  text: ColorValue;
  textMuted: ColorValue;
  border: ColorValue;
  positive: ColorValue;
  onPositive: ColorValue;
  negative: ColorValue;
  onNegative: ColorValue;
  warning: ColorValue;
  onWarning: ColorValue;
  glassTint: 'light' | 'dark' | 'systemMaterial';
  staticAccent: string;
}

const ThemeContext = createContext<ThemeTokens | null>(null);

// Hand-tuned neutral surfaces with a single accent family. The user's accent
// only drives accent/accentContainer colors; surfaces stay neutral so the app
// keeps a conventional, high-contrast look in both modes.
function accentTokens(seed: string, dark: boolean): ThemeTokens {
  const base = dark ? darkTokens : lightTokens;
  const accent = accessibleAccentColor(seed, base.surface, base.text);
  const accentContainer = mixHex(accent, base.surface, dark ? 0.78 : 0.86);
  return {
    mode: dark ? 'dark' : 'light',
    accent,
    onAccent: readableTextColor(accent),
    accentContainer,
    onAccentContainer: ensureContrast(accent, accentContainer, base.text),
    background: base.background,
    surface: base.surface,
    surfaceElevated: base.surfaceElevated,
    surfaceMuted: base.surfaceMuted,
    text: base.text,
    textMuted: base.textMuted,
    border: base.border,
    positive: base.positive,
    onPositive: readableTextColor(base.positive),
    negative: base.negative,
    onNegative: readableTextColor(base.negative),
    warning: base.warning,
    onWarning: readableTextColor(base.warning),
    glassTint: dark ? 'dark' : 'light',
    staticAccent: accent,
  };
}

// Material You stays available as an explicit opt-in on Android only; every
// other platform uses the default indigo on the hand-tuned neutral surfaces.
function systemTokens(dark: boolean): ThemeTokens {
  const fallback = accentTokens(QASHY_ACCENT, dark);
  if (Platform.OS !== 'android') return fallback;
  return {
    ...fallback,
    accent: Color.android.dynamic.primary,
    onAccent: Color.android.dynamic.onPrimary,
    accentContainer: Color.android.dynamic.primaryContainer,
    onAccentContainer: Color.android.dynamic.onPrimaryContainer,
    background: Color.android.dynamic.surface,
    surface: Color.android.dynamic.surfaceContainerLow,
    surfaceElevated: Color.android.dynamic.surfaceContainer,
    surfaceMuted: Color.android.dynamic.surfaceContainerHigh,
    text: Color.android.dynamic.onSurface,
    textMuted: Color.android.dynamic.onSurfaceVariant,
    border: Color.android.dynamic.outlineVariant,
  };
}

export function QashyThemeProvider({ children }: { children: ReactNode }) {
  const { settings } = useFinanceState();
  const { isRtl } = useLocalization();
  const systemScheme = useColorScheme();
  const mode = settings.themeMode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : settings.themeMode;
  const usesSystemAccent = settings.accentSource === 'system';
  const seed = usesSystemAccent ? QASHY_ACCENT : settings.accentHex;
  const tokens = useMemo(
    () => (usesSystemAccent ? systemTokens(mode === 'dark') : accentTokens(seed, mode === 'dark')),
    [mode, seed, usesSystemAccent],
  );

  useEffect(() => {
    if (process.env.EXPO_OS !== 'web' && typeof Appearance.setColorScheme === 'function') {
      Appearance.setColorScheme(settings.themeMode === 'system' ? 'unspecified' : settings.themeMode);
    }
  }, [settings.themeMode]);

  const baseNavigation = mode === 'dark' ? DarkTheme : DefaultTheme;
  const navigationTheme = {
    ...baseNavigation,
    colors: {
      ...baseNavigation.colors,
      primary: tokens.staticAccent,
      background: typeof tokens.background === 'string' ? tokens.background : baseNavigation.colors.background,
      card: typeof tokens.surface === 'string' ? tokens.surface : baseNavigation.colors.card,
      text: typeof tokens.text === 'string' ? tokens.text : baseNavigation.colors.text,
      border: typeof tokens.border === 'string' ? tokens.border : baseNavigation.colors.border,
    },
  };

  return (
    <ThemeContext value={tokens}>
      <Host
        style={{ flex: 1, direction: isRtl ? 'rtl' : 'ltr' }}
        colorScheme={mode}
        seedColor={usesSystemAccent && Platform.OS === 'android' ? undefined : tokens.staticAccent}>
        <NavigationThemeProvider value={navigationTheme}>{children}</NavigationThemeProvider>
      </Host>
    </ThemeContext>
  );
}

export function useQashyTheme() {
  useColorScheme();
  const theme = use(ThemeContext);
  if (!theme) throw new Error('useQashyTheme must be used inside QashyThemeProvider.');
  return theme;
}
