import { useEffect, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/app-text';
import { GlassSurface } from '@/components/ui/glass-surface';
import { TextButton } from '@/components/ui/text-button';
import { useQashyTheme } from '@/theme/theme';

declare global {
  interface Window {
    __qashyWaitingWorker?: ServiceWorker;
  }
}

export function PwaUpdatePrompt() {
  const [visible, setVisible] = useState(false);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const theme = useQashyTheme();
  useEffect(() => {
    const show = () => setVisible(true);
    window.addEventListener('qashy-sw-update', show);
    const canRegister =
      'serviceWorker' in navigator &&
      (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
    if (canRegister) {
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
    }
    return () => window.removeEventListener('qashy-sw-update', show);
  }, []);
  if (!visible) return null;
  return (
    <View
      accessibilityLabel="App update available"
      accessibilityLiveRegion="polite"
      role="status"
      style={{
        position: 'absolute',
        left: width < 440 ? 12 + insets.left : undefined,
        right: 12 + insets.right,
        bottom: width < 768 ? 76 + Math.max(6, insets.bottom) : 20 + insets.bottom,
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
              window.__qashyWaitingWorker?.postMessage({ type: 'SKIP_WAITING' });
              window.location.reload();
            }} />
          </View>
        </View>
      </GlassSurface>
    </View>
  );
}
