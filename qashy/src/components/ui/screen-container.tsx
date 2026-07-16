import { useWindowDimensions, type ViewProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MotionView } from '@/components/ui/motion';

// Shared metrics so list screens that cannot nest inside ScreenContainer
// (e.g. SectionList content) still match its width and padding.
export function screenContentMetrics(width: number, bottomInset = 0): ViewStyle {
  return {
    width: '100%',
    maxWidth: width >= 1200 ? 1180 : 920,
    alignSelf: 'center',
    paddingHorizontal: width < 600 ? 16 : 28,
    paddingTop: process.env.EXPO_OS === 'web' ? 24 : 12,
    paddingBottom: process.env.EXPO_OS === 'web' && width < 768 ? 104 + bottomInset : 32,
  };
}

export function ScreenContainer({ style, ...props }: ViewProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <MotionView
      {...props}
      variant="up"
      style={[screenContentMetrics(width, insets.bottom), { gap: 20 }, style]}
    />
  );
}
