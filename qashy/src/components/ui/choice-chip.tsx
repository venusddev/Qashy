import { Pressable } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { useQashyTheme } from '@/theme/theme';

export function ChoiceChip({ label, selected, onPress, icon }: { label: string; selected: boolean; onPress: () => void; icon?: string }) {
  const theme = useQashyTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? theme.accent : theme.border,
        backgroundColor: selected ? theme.accentContainer : theme.surface,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        opacity: pressed ? 0.72 : 1,
      })}>
      {icon ? <AppIcon name={icon} color={selected ? theme.accent : theme.textMuted} size={17} /> : null}
      <AppText selectable={false} variant="label" style={{ color: selected ? theme.accent : theme.text }}>{label}</AppText>
    </Pressable>
  );
}
