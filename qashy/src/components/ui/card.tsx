import { View, type ViewProps } from 'react-native';

import { useQashyTheme } from '@/theme/theme';
import { radius } from '@/theme/tokens';

export function Card({ style, ...props }: ViewProps) {
  const theme = useQashyTheme();
  return (
    <View
      {...props}
      style={[
        {
          backgroundColor: theme.surface,
          borderRadius: radius.card,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.border,
          padding: 18,
          boxShadow: theme.mode === 'dark' ? '0 2px 12px rgba(0,0,0,0.16)' : '0 2px 10px rgba(25,27,32,0.05)',
        },
        style,
      ]}
    />
  );
}
