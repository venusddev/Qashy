import { Stack } from 'expo-router/stack';

import { useQashyTheme } from '@/theme/theme';

export function TabStackLayout({ title }: { title: string }) {
  const theme = useQashyTheme();
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        headerTintColor: theme.accent,
        contentStyle: { backgroundColor: theme.background },
      }}>
      <Stack.Screen name="index" options={{ title }} />
    </Stack>
  );
}
