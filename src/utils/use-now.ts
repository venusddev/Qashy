/**
 * The current time, as a value a component is allowed to read.
 *
 * `Date.now()` called during render makes a component non-idempotent — two renders of the same
 * props produce different output — which is exactly what `react-hooks/purity` exists to catch,
 * and it is not a pedantic objection: under `StrictMode`'s double render and under Suspense
 * replays, two halves of one screen can end up rendered against clocks a few milliseconds
 * apart, so "just now" and "1 minute ago" appear side by side describing the same event.
 *
 * So the clock becomes an external store instead. It is read outside render, quantized to the
 * minute, and shared: every component that calls this in one commit sees the identical value,
 * and relative times across the whole screen agree with each other by construction.
 *
 * **Why the minute.** Every consumer renders text at minute resolution or coarser ("just now",
 * "4 minutes ago", "2 days ago"). Quantizing means a millisecond that ticks between two renders
 * is not a state change at all, so the store notifies at most once a minute rather than on
 * every frame — and the value is stable enough for `getSnapshot`, which React may call several
 * times per render and requires to be consistent.
 *
 * Note that this is for *display*. Anything that has to be correct rather than merely current —
 * a pairing deadline, an HLC, an `updatedAt` — reads the clock directly at the point of use.
 */

import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

const MINUTE = 60_000;

const floorToMinute = (value: number) => value - (value % MINUTE);

// Read at module load, not in a render. This is the seed for the very first render, which is
// why it matters that it is a real time rather than a zero — a `0` here would render "56 years
// ago" for one frame on every cold start.
let snapshot = floorToMinute(Date.now());

const listeners = new Set<() => void>();

/**
 * Re-reads the clock and notifies, if the minute actually changed.
 *
 * The equality check is what keeps this from being a render loop: called from a timer, a
 * foreground event, and potentially several subscribers at once, it does nothing at all unless
 * the displayed value would differ.
 */
function tick() {
  const next = floorToMinute(Date.now());
  if (next === snapshot) return;
  snapshot = next;
  // Copied, because a listener is free to unsubscribe during notification.
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  // Half a minute, so the visible minute is never more than 30 seconds behind the real one.
  const timer = setInterval(tick, MINUTE / 2);

  // Timers are throttled or suspended while the app is backgrounded, so a device picked up
  // after an hour would otherwise show an hour-old "just now" until the next interval fired.
  // Same seam the finance and sync providers reconcile on, for the same reason.
  const detach = attachForegroundListener(tick);

  return () => {
    listeners.delete(listener);
    clearInterval(timer);
    detach();
  };
}

const getSnapshot = () => snapshot;

/** Milliseconds since the epoch, floored to the minute, shared across every caller. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function attachForegroundListener(onForeground: () => void) {
  if (typeof document !== 'undefined') {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') onForeground();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    globalThis.addEventListener('focus', onForeground);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      globalThis.removeEventListener('focus', onForeground);
    };
  }
  let previous = AppState.currentState;
  const subscription = AppState.addEventListener('change', (next) => {
    if (previous !== 'active' && next === 'active') onForeground();
    previous = next;
  });
  return () => subscription.remove();
}
