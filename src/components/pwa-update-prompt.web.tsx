import { useEffect, useRef, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/app-text';
import { GlassSurface } from '@/components/ui/glass-surface';
import { MotionView } from '@/components/ui/motion';
import { TextButton } from '@/components/ui/text-button';
import { useQashyTheme } from '@/theme/theme';

declare global {
  interface Window {
    __qashyWaitingWorker?: ServiceWorker;
  }
}

export function PwaUpdatePrompt() {
  const [visible, setVisible] = useState(false);
  const controllerChanged = useRef(false);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const theme = useQashyTheme();
  const compact = width < 768;
  useEffect(() => {
    const canRegister =
      'serviceWorker' in navigator &&
      (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
    if (!canRegister) return;
    // `clientsClaim` means the worker another tab activates claims this one too, and
    // that `controllerchange` fires exactly once. Listening only from inside the
    // Reload handler missed it, so the second tab's Reload then waited forever on a
    // transition that had already happened and stayed on the old bundle. Watch from
    // mount and just record it; reloading uninvited would discard whatever the user
    // is in the middle of typing.
    const onControllerChange = () => {
      controllerChanged.current = true;
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      const announce = (worker: ServiceWorker) => {
        window.__qashyWaitingWorker = worker;
        setVisible(true);
      };
      if (registration.waiting) announce(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) announce(worker);
        });
      });
    }).catch(() => undefined);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  }, []);
  if (!visible) return null;
  return (
    <MotionView
      accessibilityLabel="App update available"
      accessibilityLiveRegion="polite"
      exit
      role="status"
      style={compact
        ? {
          // On a phone this is a normal layout row below the navigator. A floating
          // snackbar sits directly over form actions and bottom navigation, so a
          // waiting worker could make the control beneath it impossible to press
          // until the notice was dismissed.
          width: '100%',
          paddingTop: 8,
          paddingRight: 12 + insets.right,
          paddingBottom: Math.max(8, insets.bottom),
          paddingLeft: 12 + insets.left,
          zIndex: 1000,
        }
        : {
          position: 'absolute',
          right: 12 + insets.right,
          bottom: 20 + insets.bottom,
          maxWidth: 380,
          zIndex: 1000,
        }}>
      <GlassSurface style={{ borderRadius: 22, borderCurve: 'continuous', borderWidth: 1, borderColor: theme.border, padding: 16 }}>
        <View style={{ gap: 10 }}>
          <AppText variant="label">A fresh version is ready</AppText>
          <AppText variant="caption" muted>Reload when you’re ready. Your finance data stays in IndexedDB.</AppText>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
            <TextButton title="Later" tone="muted" onPress={() => setVisible(false)} />
            <TextButton title="Reload" onPress={() => {
              const worker = window.__qashyWaitingWorker;
              // Nothing waiting, or another tab already promoted it: the new worker
              // is live, so a plain reload picks it up. Waiting on `controllerchange`
              // here would hang, because that event has already been and gone.
              if (!worker || controllerChanged.current || worker.state === 'activated') {
                window.location.reload();
                return;
              }
              navigator.serviceWorker.addEventListener(
                'controllerchange',
                () => window.location.reload(),
                { once: true },
              );
              worker.postMessage({ type: 'SKIP_WAITING' });
            }} />
          </View>
        </View>
      </GlassSurface>
    </MotionView>
  );
}
