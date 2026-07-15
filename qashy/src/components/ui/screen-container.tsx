import { View, useWindowDimensions, type ViewProps, type ViewStyle } from 'react-native';

// Shared metrics so list screens that cannot nest inside ScreenContainer
// (e.g. SectionList content) still match its width and padding.
export function screenContentMetrics(width: number): ViewStyle {
  return {
    width: '100%',
    maxWidth: width >= 1200 ? 1180 : 920,
    alignSelf: 'center',
    paddingHorizontal: width < 600 ? 16 : 28,
    paddingTop: process.env.EXPO_OS === 'web' ? 24 : 12,
    paddingBottom: process.env.EXPO_OS === 'web' && width < 768 ? 104 : 32,
  };
}

export function ScreenContainer({ style, ...props }: ViewProps) {
  const { width } = useWindowDimensions();
  return <View {...props} style={[screenContentMetrics(width), { gap: 20 }, style]} />;
}
