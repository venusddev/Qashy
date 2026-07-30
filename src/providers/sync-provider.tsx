/**
 * Sync's one long-lived object, and the only place the app decides when it runs.
 *
 * Deliberately a sibling of `FinanceProvider` rather than part of it. The two have different
 * failure modes and different audiences: a finance snapshot failing to load means no screen
 * can render, whereas a relay being unreachable means one settings row shows a different
 * subtitle and everything else carries on exactly as before. Merging them would put the
 * second class of failure on the same code path as the first, and the app has already made
 * that split once — `FinanceReloadContext` is separate from `FinanceContext` for the same
 * reason, and says so at its definition.
 *
 * Three responsibilities, and nothing else belongs here:
 *
 * 1. **Owning the `SyncRuntime`** for the life of the app, so a WebRTC data channel survives
 *    navigation. Rebuilding it per screen would mean re-establishing a connection every time
 *    someone opened the sync screen to check whether the connection was working.
 * 2. **Arming change capture.** `SyncingStorageAdapter` is installed unarmed at the
 *    repository singleton; this is what hands it a device id once a vault is readable, and
 *    takes it away again when one is not.
 * 3. **Running a pass on the foreground seam** — the same `AppState` / `visibilitychange`
 *    seam the finance reconcile already uses. There are no timers anywhere in the sync stack,
 *    and this file is where that stays true: a relay contacted on a schedule is itself a
 *    traffic pattern, which is the thing §1.8 of the design exists to avoid.
 *
 * **Sync failures never unmount anything.** They land in `error` and the UI reports them in
 * place. A device that cannot reach its peers is still a perfectly good budget app, and
 * taking the tree down — with whatever half-filled form is in it — over a failed upload
 * would be a far worse bug than the one being reported.
 */

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { financeRepository, syncingStorage } from '@/data/local-finance-repository';
import { createPlatformKeystore } from '@/sync/keystore/platform';
import type { SyncKeystore } from '@/sync/keystore';
import { SyncRuntime, type SyncPass } from '@/sync/runtime';
import {
  readSyncStatus,
  type SyncSetupDeps,
  type SyncStatus,
} from '@/sync/setup';
import type { RelayHealth } from '@/sync/transport/relay-health';

export interface SyncContextValue {
  /** Null until the first read completes. Screens render a spinner rather than empty state. */
  readonly status: SyncStatus | null;
  /** The last pass's outcome, or null if none has run this session. */
  readonly pass: SyncPass | null;
  /** True while a pass is in flight, so the hero can show progress. */
  readonly syncing: boolean;
  /**
   * The last failure, in plain language. Advisory — nothing is blocked by it.
   *
   * Cleared by the next successful pass, so a transient failure heals itself rather than
   * leaving a banner that has to be dismissed by hand.
   */
  readonly error: string | null;
  /** Re-reads everything from storage. Call after any mutation the setup layer performed. */
  readonly refresh: () => Promise<void>;
  /** Runs a pass now. Backs the pull-to-refresh and the "Sync now" button. */
  readonly reconcile: () => Promise<void>;
  /** Measures the relay now, without a full pass. Backs "Check now". */
  readonly checkRelay: () => Promise<RelayHealth>;
  /** For flows that need to mutate vault state — pairing, revoking, endpoints. */
  readonly setup: SyncSetupDeps;
  readonly runtime: SyncRuntime;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/** Overridable so tests can drive the whole provider without a keystore or a network. */
export interface SyncProviderProps {
  readonly children: ReactNode;
  readonly keystore?: SyncKeystore;
  readonly runtime?: SyncRuntime;
}

export function SyncProvider({ children, keystore, runtime }: SyncProviderProps) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [pass, setPass] = useState<SyncPass | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Built once and kept. `useState`'s initializer rather than `useMemo`, because `useMemo`
  // is explicitly allowed to discard and recompute its value — which for a keystore handle
  // and a live transport graph would silently drop connections mid-session.
  const [deps] = useState<SyncSetupDeps>(() => ({
    storage: syncingStorage,
    keystore: keystore ?? createPlatformKeystore(),
  }));

  const [engine] = useState(
    () =>
      runtime ??
      new SyncRuntime({
        storage: deps.storage,
        repository: financeRepository,
        keystore: deps.keystore,
        // Reported rather than thrown: this fires from inside a pass, several frames away
        // from anything that could handle it, and the alternative to reporting it is a
        // device that stops syncing without ever saying so.
        onError: (reason: unknown) => setError(describe(reason)),
      }),
  );

  /**
   * Guards against two passes overlapping.
   *
   * A ref rather than the `syncing` state, because a foreground event and a button press can
   * both arrive before React has re-rendered — and two concurrent passes would have both
   * sessions allocating from the same op chain.
   */
  const running = useRef(false);

  const apply = useCallback((next: SyncStatus) => {
    setStatus(next);
    // Arming is driven by what is actually readable, not by what the last flow intended. A
    // keystore that has become locked or unavailable since the last read must stop capture:
    // ops signed under a key this device can no longer produce are ops no peer will ever
    // accept, and they would sit in the outbox forever.
    syncingStorage.setDeviceId(
      next.enabled && next.keystore === 'unlocked' && next.deviceId ? next.deviceId : null,
    );
  }, []);

  // `.then` rather than `async`/`await`, and the difference is not stylistic: this is called
  // from an effect, and React's lint rule reads a bare `await` before a `setState` as a
  // synchronous update in the effect body. `FinanceProvider.initialize` has the same shape
  // for the same reason.
  const refresh = useCallback(
    () =>
      readSyncStatus(deps).then(apply, (reason: unknown) => {
        setError(describe(reason));
      }),
    [deps, apply],
  );

  const reconcile = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setSyncing(true);
    try {
      const result = await engine.reconcile();
      setPass(result);
      // Only a pass that actually ran clears the banner. A pass that returned `disabled` or
      // `unpaired` did no work, so it is no evidence that whatever failed last time is fixed.
      if (result.reason === 'ok') setError(null);
    } catch (reason: unknown) {
      setError(describe(reason));
    } finally {
      running.current = false;
      setSyncing(false);
      // Always, including after a failure: a partial pass still moves peers, activity, and
      // the relay verdict, and leaving the screen showing pre-failure state would misreport
      // what happened.
      await refresh();
    }
  }, [engine, refresh]);

  const checkRelay = useCallback(async () => {
    const health = await engine.checkRelay();
    await refresh();
    return health;
  }, [engine, refresh]);

  // First read, and teardown. `close()` on unmount matters on web, where a hot reload would
  // otherwise leave the previous runtime's data channel and socket open alongside the new one.
  useEffect(() => {
    void refresh();
    return () => {
      syncingStorage.setDeviceId(null);
      void engine.close();
    };
  }, [engine, refresh]);

  // The lifecycle seam, mirroring `FinanceProvider.reconcile` exactly. Same events, same
  // ordering, deliberately duplicated rather than shared: the finance reload must run even
  // when sync is off, and coupling them would make a sync failure able to delay a refresh
  // every screen depends on.
  useEffect(() => {
    const onResume = () => void reconcile();
    if (typeof document !== 'undefined') {
      const onVisibilityChange = () => {
        if (document.visibilityState === 'visible') onResume();
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      globalThis.addEventListener('focus', onResume);
      globalThis.addEventListener('pageshow', onResume);
      return () => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        globalThis.removeEventListener('focus', onResume);
        globalThis.removeEventListener('pageshow', onResume);
      };
    }
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (previous !== 'active' && next === 'active') onResume();
      previous = next;
    });
    return () => subscription.remove();
  }, [reconcile]);

  const value = useMemo<SyncContextValue>(
    () => ({
      status,
      pass,
      syncing,
      error,
      refresh,
      reconcile,
      checkRelay,
      setup: deps,
      runtime: engine,
    }),
    [status, pass, syncing, error, refresh, reconcile, checkRelay, deps, engine],
  );

  return <SyncContext value={value}>{children}</SyncContext>;
}

/**
 * Sync state, or null outside the provider.
 *
 * Null rather than a throw, unlike `useFinanceState`. The More screen renders a sync row and
 * must keep rendering in a test or a storybook that mounts it without this provider — a hard
 * requirement there would make sync's presence a precondition for a screen that is mostly
 * about other things.
 */
export function useSyncState() {
  return use(SyncContext);
}

/** For the sync screens themselves, which genuinely cannot work without it. */
export function useSync(): SyncContextValue {
  const context = use(SyncContext);
  if (!context) throw new Error('useSync must be used inside SyncProvider.');
  return context;
}

const describe = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'Sync could not complete.';
