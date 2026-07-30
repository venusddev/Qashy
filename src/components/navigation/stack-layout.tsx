import { Stack } from 'expo-router/stack';
import { Platform } from 'react-native';

import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';

const IS_WEB = process.env.EXPO_OS === 'web';

/**
 * Shared stack for the four tab sections.
 *
 * Native gets a real navigation header. It used to run `headerShown: false` with
 * the sections drawing their own headings, which meant Transactions, Plan, and
 * More had no visible title at all on iOS and Android — `PageHeading` returns
 * null off web — and Overview compensated with a hand-rolled duplicate of it.
 * The platform header brings back the title, and with it large-title collapse,
 * the standard back affordance, and the system's own scroll-edge treatment.
 *
 * Web keeps `headerShown: false`. The shell's persistent rail already names the
 * section, and the in-page `PageHeading` is what carries the `h1` a document
 * needs; a second bar above it would be chrome duplicating chrome.
 *
 * `title` is registered either way: the root layout mirrors the focused screen's
 * `title` into `document.title` on web.
 */
export function TabStackLayout({ title, largeTitle = true }: { title: string; largeTitle?: boolean }) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  return (
    <Stack
      screenOptions={{
        headerShown: !IS_WEB,
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.background },
        headerTintColor: theme.staticAccent,
        headerTitleStyle: { color: theme.staticText, fontWeight: '600' },
        contentStyle: { backgroundColor: theme.background },
      }}>
      <Stack.Screen
        name="index"
        options={{
          title: t(title),
          // iOS only, and only honoured when the screen's scrollable sets
          // `contentInsetAdjustmentBehavior="automatic"` — which the section
          // screens do. Opted out where a pinned toolbar sits between the header
          // and the scroll view, since the title then has nothing to collapse
          // against and would just eat a permanent 52pt of a phone screen.
          headerLargeTitleEnabled: Platform.OS === 'ios' && largeTitle,
          headerLargeTitleShadowVisible: false,
          headerLargeStyle: { backgroundColor: theme.background },
          headerLargeTitleStyle: { color: theme.staticText },
        }}
      />
    </Stack>
  );
}
