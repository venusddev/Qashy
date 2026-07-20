import { type PressableProps } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { MotionPressable } from '@/components/ui/motion';
import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';

export function TextButton({
  title,
  icon,
  tone = 'accent',
  onPress,
  disabled = false,
  style,
  accessibilityState,
  ...props
}: Omit<PressableProps, 'children'> & {
  title: string;
  icon?: string;
  tone?: 'accent' | 'muted' | 'danger';
}) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const isDisabled = Boolean(disabled);
  const color = tone === 'danger' ? theme.negative : tone === 'muted' ? theme.textMuted : theme.accent;
  return (
    <MotionPressable
      accessibilityLabel={t(title)}
      accessibilityRole="button"
      accessibilityState={{ ...accessibilityState, disabled: isDisabled }}
      {...props}
      disabled={isDisabled}
      onPress={onPress}
      style={(state) => [
        {
          minWidth: 44,
          minHeight: 44,
          paddingHorizontal: 6,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 6,
          opacity: isDisabled ? 0.4 : state.pressed ? 0.62 : 1,
        },
        typeof style === 'function' ? style(state) : style,
      ]}>
      {icon ? <AppIcon name={icon} color={color} size={16} /> : null}
      <AppText selectable={false} variant="label" style={{ color }}>{title}</AppText>
    </MotionPressable>
  );
}
