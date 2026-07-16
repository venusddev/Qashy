import { Pressable } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { readableTextColor } from '@/theme/tokens';

export function ColorSwatch({
  color,
  selected,
  label,
  onPress,
}: {
  color: string;
  selected: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        borderRadius: 999,
        backgroundColor: color,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: selected ? 3 : 2,
        borderColor: selected ? readableTextColor(color) : 'transparent',
        opacity: pressed ? 0.68 : 1,
      })}>
      {selected ? <AppIcon name="checkmark" color={readableTextColor(color)} size={20} /> : null}
    </Pressable>
  );
}
