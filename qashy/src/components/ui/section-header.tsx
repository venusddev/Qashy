import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { TextButton } from '@/components/ui/text-button';

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const headingLevelProps = process.env.EXPO_OS === 'web' ? ({ 'aria-level': 2 } as object) : {};

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <AppText {...headingLevelProps} accessibilityRole="header" variant="headline">{title}</AppText>
      {action ? (
        <TextButton title={action} onPress={onAction} style={{ marginVertical: -8 }} />
      ) : null}
    </View>
  );
}
