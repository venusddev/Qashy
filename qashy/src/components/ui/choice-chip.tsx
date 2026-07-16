import { Pressable } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { useQashyTheme } from '@/theme/theme';

export type ChoiceChipMode = 'radio' | 'checkbox' | 'button';

export function ChoiceChip({
  label,
  selected,
  onPress,
  icon,
  disabled = false,
  mode = 'radio',
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  icon?: string;
  disabled?: boolean;
  mode?: ChoiceChipMode;
}) {
  const theme = useQashyTheme();
  const selectable = mode !== 'button';
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole={mode}
      accessibilityState={selectable ? { checked: selected, disabled } : { disabled }}
      aria-checked={selectable ? selected : undefined}
      disabled={disabled}
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
        opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
      })}>
      {icon ? <AppIcon name={icon} color={selected ? theme.onAccentContainer : theme.textMuted} size={17} /> : null}
      <AppText selectable={false} variant="label" style={{ color: selected ? theme.onAccentContainer : theme.text }}>{label}</AppText>
    </Pressable>
  );
}
