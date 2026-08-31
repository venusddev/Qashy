import { AppIcon } from '@/components/ui/app-icon';
import { MotionPressable, MotionView } from '@/components/ui/motion';
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
    <MotionPressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      active={selected}
      onPress={onPress}
      pressedScale={0.9}
      hoverScale={1.06}
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
      {selected ? (
        <MotionView variant="zoom" exit>
          <AppIcon name="checkmark" color={readableTextColor(color)} size={20} />
        </MotionView>
      ) : null}
    </MotionPressable>
  );
}
