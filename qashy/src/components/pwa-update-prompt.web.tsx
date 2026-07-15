import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { GlassSurface } from '@/components/ui/glass-surface';
import { useQashyTheme } from '@/theme/theme';

declare global {
  interface Window {
    __qashyWaitingWorker?: ServiceWorker;
  }
}

export function PwaUpdatePrompt() {
  const [visible, setVisible] = useState(false);
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
    <GlassSurface style={{ position: 'absolute', right: 20, bottom: 20, maxWidth: 380, borderRadius: 22, borderCurve: 'continuous', borderWidth: 1, borderColor: theme.border, padding: 16, zIndex: 1000 }}>
      <View style={{ gap: 10 }}>
        <AppText variant="label">A fresh version is ready</AppText>
        <AppText variant="caption" muted>Reload when you’re ready. Your finance data stays in IndexedDB.</AppText>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12 }}>
          <Pressable onPress={() => setVisible(false)}><AppText variant="label" muted>Later</AppText></Pressable>
          <Pressable onPress={() => { window.__qashyWaitingWorker?.postMessage({ type: 'SKIP_WAITING' }); window.location.reload(); }}><AppText variant="label" style={{ color: theme.accent }}>Reload</AppText></Pressable>
        </View>
      </View>
    </GlassSurface>
  );
}
