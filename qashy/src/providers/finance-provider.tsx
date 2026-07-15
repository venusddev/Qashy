import { createContext, use, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import type { FinanceRepository } from '@/data/repository';
import { financeRepository } from '@/data/local-finance-repository';
import type { FinanceState } from '@/domain/models';

interface FinanceContextValue {
  repository: FinanceRepository;
  state: FinanceState;
}

const FinanceContext = createContext<FinanceContextValue | null>(null);

export function FinanceProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
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

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 }}>
        <Text selectable style={{ fontSize: 20, fontWeight: '700' }}>Couldn’t open Qashy</Text>
        <Text selectable style={{ textAlign: 'center', color: '#6B7280' }}>{error}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setError(null);
            financeRepository.initialize().catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : 'Database error'),
            );
          }}
          style={{ backgroundColor: '#5966E9', borderRadius: 999, paddingHorizontal: 20, paddingVertical: 12 }}>
          <Text style={{ color: 'white', fontWeight: '700' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!state.ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7F7FB' }}>
        <ActivityIndicator color="#5966E9" />
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
