import { View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui/app-text';
import { GlassSurface } from '@/components/ui/glass-surface';
import { MotionView } from '@/components/ui/motion';
import { TextButton } from '@/components/ui/text-button';
import { useFinanceReload } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';

/**
 * Reports a resume-time reload failure without taking the app down with it.
 *
 * A failed background refresh means the figures on screen are stale, which matters
 * enough to say out loud — but it is not a reason to unmount the tree and discard a
 * half-filled form, which is what routing it through the provider's startup error
 * state did. Rendered alongside `PwaUpdatePrompt` so it sits inside the theme,
 * localization, and safe-area providers.
 */
export function ReloadErrorBanner() {
  const reload = useFinanceReload();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const theme = useQashyTheme();

  if (!reload?.error) return null;

  return (
    <MotionView
      variant="down"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute',
        left: width < 440 ? 12 + insets.left : undefined,
        right: 12 + insets.right,
        // Top, not bottom: `PwaUpdatePrompt` owns the bottom corner, and offsetting
        // above it would leave this floating in dead space whenever it appears on
        // its own — which is the usual case, since the two are unrelated.
        top: 12 + insets.top,
        maxWidth: 380,
        zIndex: 1000,
      }}>
      <GlassSurface style={{ borderRadius: 22, borderCurve: 'continuous', borderWidth: 1, borderColor: theme.negative, padding: 16 }}>
        <View style={{ gap: 10 }}>
          <AppText variant="label">Qashy couldn’t refresh</AppText>
          {/* Not `literal`: the repository's own message has a translation, and an
              unrecognised storage message passes through `translateDynamic` unchanged. */}
          <AppText variant="caption" muted>{reload.error}</AppText>
          <AppText variant="caption" muted>What you see may be out of date. Your saved data is untouched.</AppText>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
            <TextButton title="Dismiss" tone="muted" onPress={reload.dismiss} />
            <TextButton title="Try again" onPress={reload.retry} />
          </View>
        </View>
      </GlassSurface>
    </MotionView>
  );
}
