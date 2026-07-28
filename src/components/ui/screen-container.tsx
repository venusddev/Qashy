import { type ViewProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenTransition } from '@/components/ui/motion';
import { useScreenMetrics, type ScreenMetrics } from '@/theme/layout';

const IS_WEB = process.env.EXPO_OS === 'web';

export interface ScreenInsets {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

// Shared metrics so list screens that cannot nest inside ScreenContainer
// (e.g. SectionList content) still match its width and padding.
//
// Everything here is derived from `metrics.contentWidth`, the room the shell
// actually leaves the screen, rather than the window. `metrics.windowWidth`
// stays available for the one decision that really is about the viewport:
// whether the web bottom bar is floating over the end of the content.
//
// `insets` accepts a bare bottom inset for backwards compatibility, or the full
// edge insets. On web the top/right insets are honoured because `+html.tsx`
// opts into `viewport-fit=cover`, so an installed iOS PWA draws under the status
// bar and the rounded display corners. Native tab screens get their top inset
// from the SafeAreaView in `(tabs)/_layout.tsx`, so it is not added twice here.
export function screenContentMetrics(metrics: ScreenMetrics, insets: number | ScreenInsets = 0): ViewStyle {
  const edges = typeof insets === 'number' ? { bottom: insets } : insets;
  const bottomInset = edges.bottom ?? 0;
  const topInset = IS_WEB ? edges.top ?? 0 : 0;
  // The rail already pads itself by the left inset, so adding it again here
  // would double-count the notch in landscape on an installed iOS PWA.
  const leftInset = IS_WEB && !metrics.hasNavigationRail ? edges.left ?? 0 : 0;
  const rightInset = IS_WEB ? edges.right ?? 0 : 0;
  const horizontal = metrics.contentWidth < 600 ? 16 : 28;
  return {
    width: '100%',
    // Deliberately the window and not the content width. This cap is about how
    // much display there is, and it is the one place where the rail should not
    // be subtracted: keying it off the content width would hold the column at
    // 920 until a 1444px window, wasting most of a 1366px laptop. The step it
    // makes at 1200 is the sidebar expanding, which is a reflow the user asked
    // for by resizing.
    maxWidth: metrics.windowWidth >= 1200 ? 1180 : 920,
    alignSelf: 'center',
    paddingLeft: horizontal + leftInset,
    paddingRight: horizontal + rightInset,
    paddingTop: (IS_WEB ? 24 : 12) + topInset,
    paddingBottom: metrics.hasBottomNavigation ? 104 + bottomInset : 32,
  };
}

export function ScreenContainer({ style, ...props }: ViewProps) {
  const metrics = useScreenMetrics();
  const insets = useSafeAreaInsets();
  return (
    <ScreenTransition
      {...props}
      style={[screenContentMetrics(metrics, insets), { gap: 20 }, style]}
    />
  );
}
