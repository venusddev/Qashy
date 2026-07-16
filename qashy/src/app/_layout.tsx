import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router/stack';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';

import { FinanceProvider, useFinanceState } from '@/providers/finance-provider';
import { PwaUpdatePrompt } from '@/components/pwa-update-prompt';
import { QashyThemeProvider, useQashyTheme } from '@/theme/theme';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const theme = useQashyTheme();
  const { settings } = useFinanceState();

  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <>
      <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, freezeOnBlur: false, contentStyle: { backgroundColor: theme.background } }}>
        <Stack.Screen name="index" />
        <Stack.Protected guard={!settings.onboardingComplete}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>
        <Stack.Protected guard={settings.onboardingComplete}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="transaction"
            options={{
              headerShown: true,
              title: 'Transaction',
              presentation: 'formSheet',
              sheetGrabberVisible: true,
              sheetAllowedDetents: [0.72, 1],
              contentStyle: { backgroundColor: 'transparent' },
            }}
          />
          <Stack.Screen name="budget" options={{ headerShown: true, title: 'Budget', presentation: 'formSheet', sheetGrabberVisible: true }} />
          <Stack.Screen name="goal" options={{ headerShown: true, title: 'Goal', presentation: 'formSheet', sheetGrabberVisible: true }} />
          <Stack.Screen name="account" options={{ headerShown: true, title: 'Account', presentation: 'formSheet', sheetGrabberVisible: true }} />
          <Stack.Screen name="category" options={{ headerShown: true, title: 'Category', presentation: 'formSheet', sheetGrabberVisible: true }} />
          <Stack.Screen name="recurring" options={{ headerShown: true, title: 'Recurring transaction', presentation: 'formSheet', sheetGrabberVisible: true }} />
          <Stack.Screen name="exchange-rate" options={{ headerShown: true, title: 'Exchange rate', presentation: 'formSheet', sheetGrabberVisible: true }} />
          <Stack.Screen name="appearance" options={{ headerShown: true, title: 'Appearance' }} />
          <Stack.Screen name="csv" options={{ headerShown: true, title: 'Import & export' }} />
        </Stack.Protected>
      </Stack>
      <PwaUpdatePrompt />
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <FinanceProvider>
        <QashyThemeProvider>
          <RootNavigator />
        </QashyThemeProvider>
      </FinanceProvider>
    </GestureHandlerRootView>
  );
}
