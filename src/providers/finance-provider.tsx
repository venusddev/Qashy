import { createContext, startTransition, use, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
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

interface FinanceReloadValue {
  /** Set when a resume-time reconcile failed. The snapshot on screen is stale. */
  error: string | null;
  retry: () => void;
  dismiss: () => void;
}

// Separate from FinanceContext so a failed background reload re-renders only the
// banner that reports it, not every screen subscribed to the finance snapshot.
const FinanceReloadContext = createContext<FinanceReloadValue | null>(null);

export function FinanceProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  // This component renders above QashyThemeProvider, so it themes its own
  // loading and error states from the static token sets.
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? darkTokens : lightTokens;
  // Re-render the tree as a transition so a mutation (e.g. saving a budget)
  // doesn't block the UI while every mounted screen recomputes its projections.
  const subscribe = useCallback(
    (listener: () => void) => financeRepository.subscribe(() => startTransition(listener)),
    [],
  );
  const state = useSyncExternalStore(
    subscribe,
    financeRepository.getSnapshot,
    financeRepository.getSnapshot,
  );
  const contextValue = useMemo(() => ({ repository: financeRepository, state }), [state]);

  useEffect(() => {
    financeRepository.initialize().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Qashy could not open its local database.');
    });
  }, []);

  const reconcile = useCallback(() => {
    if (!financeRepository.getSnapshot().ready) return;
    financeRepository.refresh()
      .then(() => financeRepository.generateRecurring())
      .then(() => setReloadError(null))
      .catch((reason: unknown) => {
        // Storage can become unusable while the app is backgrounded — an evicted
        // native handle, or IndexedDB hitting its quota. Discarding this left the app
        // showing stale figures with no sign anything had failed. Reporting it as a
        // startup error was the opposite mistake: a *background* refresh would then
        // unmount the whole tree and take any half-filled form down with it, and a
        // rule that throws during generation would repeat that on every resume.
        // Report it in place so the user can retry, or keep working and ignore it.
        setReloadError(reason instanceof Error ? reason.message : 'Qashy could not reload its local database.');
      });
  }, []);

  useEffect(() => {
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
  }, [reconcile]);

  const reloadValue = useMemo(() => ({
    error: reloadError,
    retry: () => {
      setReloadError(null);
      reconcile();
    },
    dismiss: () => setReloadError(null),
  }), [reloadError, reconcile]);

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

  return (
    <FinanceContext value={contextValue}>
      <FinanceReloadContext value={reloadValue}>{children}</FinanceReloadContext>
    </FinanceContext>
  );
}

/**
 * Reports a failed resume-time reload. Returns null outside the provider so the
 * banner can be rendered from the root navigator without asserting ordering.
 */
export function useFinanceReload() {
  return use(FinanceReloadContext);
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
