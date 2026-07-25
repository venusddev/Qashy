import { router, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { confirmDestructive } from '@/utils/confirm';
import { stableSerialize } from '@/utils/form-state';

export type OwnerRoute = '/overview' | '/transactions' | '/plan' | '/more';

/**
 * Shared behaviour for the create/edit sheets.
 *
 * Two things every one of them needs and only one of them used to do:
 *
 * 1. Closing back to the owning section. `dismissTo` alone leaves the web history
 *    entry pointing at the sheet, so the projection behind it can render against a
 *    stale URL; replacing on the next frame settles it. Only the transaction sheet
 *    carried this, and the other six shared the gap.
 * 2. Guarding unsaved work. Every sheet is a swipe-dismissible `formSheet`, and
 *    nothing asked before throwing a half-typed entry away.
 *
 * `values` is the form's current field state. Its first serialization is the
 * baseline; anything different afterwards counts as dirty. Pass plain,
 * JSON-serializable state, and pass it on every render.
 */
export function useFormSheet({ ownerRoute, values }: { ownerRoute: OwnerRoute; values: unknown }) {
  const navigation = useNavigation();
  const serialized = stableSerialize(values);
  const [baseline] = useState(() => serialized);
  const dirty = baseline !== serialized;

  // Read through a ref inside the listener so it can stay subscribed for the
  // screen's whole life instead of resubscribing on every keystroke.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  // Set once the screen is leaving deliberately — a save, a delete, or a discard
  // the user already confirmed — so the guard does not prompt about its own exit.
  const leaving = useRef(false);

  const closeToOwner = useCallback(() => {
    leaving.current = true;
    router.dismissTo(ownerRoute);
    if (process.env.EXPO_OS === 'web' && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => router.replace(ownerRoute));
    }
  }, [ownerRoute]);

  // Lets a screen leave by a route of its own (the account sheet returns to the
  // transaction sheet that opened it) without tripping the guard.
  const allowLeave = useCallback(() => {
    leaving.current = true;
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (leaving.current || !dirtyRef.current) return;
      event.preventDefault();
      void confirmDestructive({
        title: 'Discard changes?',
        message: 'This form has unsaved changes.',
        confirmLabel: 'Discard',
      }).then((confirmed) => {
        if (!confirmed) return;
        leaving.current = true;
        navigation.dispatch(event.data.action);
      });
    });
    return unsubscribe;
  }, [navigation]);

  return { closeToOwner, allowLeave, dirty };
}
