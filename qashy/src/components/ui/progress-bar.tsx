import { View } from 'react-native';

import { useQashyTheme } from '@/theme/theme';

export function ProgressBar({ value, color }: { value: number; color?: string }) {
  const theme = useQashyTheme();
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <View style={{ height: 9, borderRadius: 99, overflow: 'hidden', backgroundColor: theme.surfaceMuted }}>
      <View style={{ height: '100%', width: `${clamped * 100}%`, borderRadius: 99, backgroundColor: color ?? theme.accent }} />
    </View>
  );
}
