import { createContext, use, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View, useColorScheme } from 'react-native';

import type { FinanceRepository } from '@/data/repository';
import { financeRepository } from '@/data/local-finance-repository';
import { QASHY_ACCENT } from '@/domain/defaults';
import type { FinanceState } from '@/domain/models';
import { darkTokens, lightTokens, readableTextColor } from '@/theme/tokens';

interface FinanceContextValue {
  repository: FinanceRepository;
  state: FinanceState;
}

const FinanceContext = createContext<FinanceContextValue | null>(null);

export function FinanceProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  // This component renders above QashyThemeProvider, so it themes its own
  // loading and error states from the static token sets.
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? darkTokens : lightTokens;
  const state = useSyncExternalStore(
    financeRepository.subscribe,
    financeRepository.getSnapshot,
    financeRepository.getSnapshot,
  );
  const contextValue = useMemo(() => ({ repository: financeRepository, state }), [state]);

  useEffect(() => {
    financeRepository.initialize().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Qashy could not open its local database.');
    });
  }, []);

  useEffect(() => {
    const reconcile = () => {
      if (!financeRepository.getSnapshot().ready) return;
      financeRepository.refresh()
        .then(() => financeRepository.generateRecurring())
        .catch(() => undefined);
    };
    if (typeof document !== 'undefined') {
      const onVisibilityChange = () => {
        if (document.visibilityState === 'visible') reconcile();
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      globalThis.addEventListener('focus', reconcile);
      globalThis.addEventListener('pageshow', reconcile);
      return () => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        globalThis.removeEventListener('focus', reconcile);
        globalThis.removeEventListener('pageshow', reconcile);
      };
    }
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (previousState !== 'active' && nextState === 'active') reconcile();
      previousState = nextState;
    });
    return () => subscription.remove();
  }, []);

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12, backgroundColor: tokens.background }}>
        <Text selectable style={{ fontSize: 20, fontWeight: '700', color: tokens.text }}>Couldn’t open Qashy</Text>
        <Text selectable style={{ textAlign: 'center', color: tokens.textMuted }}>{error}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setError(null);
            financeRepository.initialize().catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : 'Database error'),
            );
          }}
          style={{ backgroundColor: QASHY_ACCENT, borderRadius: 999, paddingHorizontal: 20, paddingVertical: 12 }}>
          <Text style={{ color: readableTextColor(QASHY_ACCENT), fontWeight: '700' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!state.ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.background }}>
        <ActivityIndicator color={QASHY_ACCENT} />
      </View>
    );
  }

  return <FinanceContext value={contextValue}>{children}</FinanceContext>;
}

export function useFinanceRepository() {
  const context = use(FinanceContext);
  if (!context) throw new Error('useFinanceRepository must be used inside FinanceProvider.');
  return context.repository;
}

export function useFinanceState(): FinanceState {
  const context = use(FinanceContext);
  if (!context) throw new Error('useFinanceState must be used inside FinanceProvider.');
  return context.state;
}
