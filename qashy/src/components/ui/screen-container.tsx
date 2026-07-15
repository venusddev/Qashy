import { View, useWindowDimensions, type ViewProps } from 'react-native';

export function ScreenContainer({ style, ...props }: ViewProps) {
  const { width } = useWindowDimensions();
  return (
    <View
      {...props}
      style={[
        {
          width: '100%',
          maxWidth: width >= 1200 ? 1180 : 920,
          alignSelf: 'center',
          paddingHorizontal: width < 600 ? 16 : 28,
          paddingTop: process.env.EXPO_OS === 'web' ? 92 : 12,
          paddingBottom: process.env.EXPO_OS === 'web' && width < 768 ? 104 : 32,
          gap: 20,
        },
        style,
      ]}
    />
  );
}
