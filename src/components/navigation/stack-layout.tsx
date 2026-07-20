import { Stack } from 'expo-router/stack';

import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';

/**
 * Shared stack for the four tab sections.
 *
 * `headerShown` stays false — the sections draw their own headings and rely on
 * the tabs layout for the top safe-area inset. The screen `title` is still
 * registered: the root layout mirrors the focused screen's `title` option into
 * `document.title` on web, so each section keeps a distinct page title without
 * a native header.
 */
export function TabStackLayout({ title }: { title: string }) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.background },
      }}>
      <Stack.Screen name="index" options={{ title: t(title) }} />
    </Stack>
  );
}
