import { View, type ViewProps } from 'react-native';

import { useQashyTheme } from '@/theme/theme';

export function Card({ style, ...props }: ViewProps) {
  const theme = useQashyTheme();
  return (
    <View
      {...props}
      style={[
        {
          backgroundColor: theme.surface,
          borderRadius: 24,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.border,
          padding: 18,
          boxShadow: theme.mode === 'dark' ? '0 10px 32px rgba(0,0,0,0.18)' : '0 10px 30px rgba(49,46,80,0.07)',
        },
        style,
      ]}
    />
  );
}
