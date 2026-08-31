import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { TextButton } from '@/components/ui/text-button';
import { space } from '@/theme/tokens';

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const headingLevelProps = process.env.EXPO_OS === 'web' ? ({ 'aria-level': 2 } as object) : {};

  return (
    // The action's 44pt tap target is taller than the heading it sits beside, so
    // it is pulled back vertically. Without that the header owns more vertical
    // space than the rows it introduces and the rhythm of a stacked page breaks.
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.lg, minHeight: 28 }}>
      <AppText {...headingLevelProps} accessibilityRole="header" variant="headline">{title}</AppText>
      {action ? (
        <TextButton title={action} onPress={onAction} style={{ marginVertical: -space.sm, marginEnd: -space.xs }} />
      ) : null}
    </View>
  );
}
