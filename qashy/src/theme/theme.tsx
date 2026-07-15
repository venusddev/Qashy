import { Host } from '@expo/ui';
import { argbFromHex, hexFromArgb, themeFromSourceColor } from '@material/material-color-utilities';
import { Color, DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router';
import { createContext, use, useEffect, useMemo, type ReactNode } from 'react';
import {
  Appearance,
  Platform,
  type ColorValue,
  useColorScheme,
} from 'react-native';

import { QASHY_ACCENT } from '@/domain/defaults';
import { useFinanceState } from '@/providers/finance-provider';

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
  negative: ColorValue;
  warning: ColorValue;
  glassTint: 'light' | 'dark' | 'systemMaterial';
  staticAccent: string;
}

const ThemeContext = createContext<ThemeTokens | null>(null);

function generatedTokens(seed: string, dark: boolean): ThemeTokens {
  const scheme = dark
    ? themeFromSourceColor(argbFromHex(seed)).schemes.dark
    : themeFromSourceColor(argbFromHex(seed)).schemes.light;
  return {
    mode: dark ? 'dark' : 'light',
    accent: hexFromArgb(scheme.primary),
    onAccent: hexFromArgb(scheme.onPrimary),
    accentContainer: hexFromArgb(scheme.primaryContainer),
    onAccentContainer: hexFromArgb(scheme.onPrimaryContainer),
    background: hexFromArgb(scheme.background),
    surface: hexFromArgb(scheme.surface),
    surfaceElevated: hexFromArgb(scheme.surface),
    surfaceMuted: hexFromArgb(scheme.surfaceVariant),
    text: hexFromArgb(scheme.onSurface),
    textMuted: hexFromArgb(scheme.onSurfaceVariant),
    border: hexFromArgb(scheme.outlineVariant),
    positive: dark ? '#65D99A' : '#208653',
    negative: dark ? '#FF8F96' : '#C43D4A',
    warning: dark ? '#F0C36A' : '#9A6700',
    glassTint: dark ? 'dark' : 'light',
    staticAccent: hexFromArgb(scheme.primary),
  };
}

function systemTokens(dark: boolean): ThemeTokens {
  const fallback = generatedTokens(QASHY_ACCENT, dark);
  if (process.env.EXPO_OS === 'web') return fallback;
  return {
    ...fallback,
    accent: Platform.select({
      ios: Color.ios.systemIndigo,
      android: Color.android.dynamic.primary,
      default: fallback.accent,
    })!,
    onAccent: Platform.select({
      ios: Color.ios.white,
      android: Color.android.dynamic.onPrimary,
      default: fallback.onAccent,
    })!,
    accentContainer: Platform.select({
      ios: Color.ios.tertiarySystemFill,
      android: Color.android.dynamic.primaryContainer,
      default: fallback.accentContainer,
    })!,
    onAccentContainer: Platform.select({
      ios: Color.ios.label,
      android: Color.android.dynamic.onPrimaryContainer,
      default: fallback.onAccentContainer,
    })!,
    background: Platform.select({
      ios: Color.ios.systemGroupedBackground,
      android: Color.android.dynamic.surface,
      default: fallback.background,
    })!,
    surface: Platform.select({
      ios: Color.ios.secondarySystemGroupedBackground,
      android: Color.android.dynamic.surfaceContainerLow,
      default: fallback.surface,
    })!,
    surfaceElevated: Platform.select({
      ios: Color.ios.systemBackground,
      android: Color.android.dynamic.surfaceContainer,
      default: fallback.surfaceElevated,
    })!,
    surfaceMuted: Platform.select({
      ios: Color.ios.tertiarySystemGroupedBackground,
      android: Color.android.dynamic.surfaceContainerHigh,
      default: fallback.surfaceMuted,
    })!,
    text: Platform.select({
      ios: Color.ios.label,
      android: Color.android.dynamic.onSurface,
      default: fallback.text,
    })!,
    textMuted: Platform.select({
      ios: Color.ios.secondaryLabel,
      android: Color.android.dynamic.onSurfaceVariant,
      default: fallback.textMuted,
    })!,
    border: Platform.select({
      ios: Color.ios.separator,
      android: Color.android.dynamic.outlineVariant,
      default: fallback.border,
    })!,
  };
}

export function QashyThemeProvider({ children }: { children: ReactNode }) {
  const { settings } = useFinanceState();
  const systemScheme = useColorScheme();
  const mode = settings.themeMode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : settings.themeMode;
  const usesSystemAccent = settings.accentSource === 'system';
  const seed = usesSystemAccent ? QASHY_ACCENT : settings.accentHex;
  const tokens = useMemo(
    () => (usesSystemAccent ? systemTokens(mode === 'dark') : generatedTokens(seed, mode === 'dark')),
    [mode, seed, usesSystemAccent],
  );

  useEffect(() => {
    if (process.env.EXPO_OS !== 'web' && typeof Appearance.setColorScheme === 'function') {
      (Appearance.setColorScheme as (scheme: 'light' | 'dark' | null) => void)(
        settings.themeMode === 'system' ? null : settings.themeMode,
      );
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
        style={{ flex: 1 }}
        colorScheme={mode}
        seedColor={usesSystemAccent ? undefined : settings.accentHex}>
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
