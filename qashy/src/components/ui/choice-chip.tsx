import { View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { MotionPressable } from '@/components/ui/motion';
import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';
import { hapticSelection } from '@/utils/haptics';

export type ChoiceChipMode = 'radio' | 'checkbox' | 'button';

export function ChoiceChip({
  label,
  selected,
  onPress,
  icon,
  disabled = false,
  literal = false,
  mode = 'radio',
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  icon?: string;
  disabled?: boolean;
  /**
   * Set when the chip names a stored entity — an account, category, or tag the
   * user typed. The label is then shown and announced exactly as entered.
   */
  literal?: boolean;
  mode?: ChoiceChipMode;
}) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const selectable = mode !== 'button';
  return (
    <MotionPressable
      accessibilityLabel={literal ? label : t(label)}
      accessibilityRole={mode}
      accessibilityState={selectable ? { checked: selected, disabled } : { disabled }}
      aria-checked={selectable ? selected : undefined}
      active={selected}
      disabled={disabled}
      onPress={() => {
        hapticSelection();
        onPress();
      }}
      pressedScale={0.95}
      hoverScale={1.02}
      style={({ pressed }) => ({
        minWidth: 44,
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
      <AppText
        selectable={false}
        literal={literal}
        variant="label"
        style={{ color: selected ? theme.onAccentContainer : theme.text, fontWeight: selected ? '800' : '600' }}>
        {label}
      </AppText>
      {/* Selection must not rely on the low-contrast accent fill alone. The
          slot is always reserved so choosing a chip never reflows the row. */}
      {selectable ? (
        <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
          {selected ? <AppIcon name="checkmark" color={theme.onAccentContainer} size={15} /> : null}
        </View>
      ) : null}
    </MotionPressable>
  );
}
