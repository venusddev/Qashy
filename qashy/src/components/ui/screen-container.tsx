import { useWindowDimensions, type ViewProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MotionView } from '@/components/ui/motion';

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
// `insets` accepts a bare bottom inset for backwards compatibility, or the full
// edge insets. On web the top/left/right insets are honoured because `+html.tsx`
// opts into `viewport-fit=cover`, so an installed iOS PWA draws under the status
// bar and the rounded display corners. Native tab screens get their top inset
// from the SafeAreaView in `(tabs)/_layout.tsx`, so it is not added twice here.
export function screenContentMetrics(width: number, insets: number | ScreenInsets = 0): ViewStyle {
  const edges = typeof insets === 'number' ? { bottom: insets } : insets;
  const bottomInset = edges.bottom ?? 0;
  const topInset = IS_WEB ? edges.top ?? 0 : 0;
  const leftInset = IS_WEB ? edges.left ?? 0 : 0;
  const rightInset = IS_WEB ? edges.right ?? 0 : 0;
  const horizontal = width < 600 ? 16 : 28;
  return {
    width: '100%',
    maxWidth: width >= 1200 ? 1180 : 920,
    alignSelf: 'center',
    paddingLeft: horizontal + leftInset,
    paddingRight: horizontal + rightInset,
    paddingTop: (IS_WEB ? 24 : 12) + topInset,
    paddingBottom: IS_WEB && width < 768 ? 104 + bottomInset : 32,
  };
}

export function ScreenContainer({ style, ...props }: ViewProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <MotionView
      {...props}
      variant="up"
      style={[screenContentMetrics(width, insets), { gap: 20 }, style]}
    />
  );
}
