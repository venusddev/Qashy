import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { useQashyTheme } from '@/theme/theme';

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const theme = useQashyTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <AppText variant="headline">{title}</AppText>
      {action ? (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={8}>
          <AppText variant="label" style={{ color: theme.accent }}>{action}</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}
