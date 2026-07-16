import * as Haptics from 'expo-haptics';
import { type PressableProps } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { MotionPressable, MotionView } from '@/components/ui/motion';
import { useQashyTheme } from '@/theme/theme';

export function ActionButton({
  title,
  icon,
  variant = 'primary',
  onPress,
  style,
  disabled = false,
  accessibilityState,
  busy = false,
  ...props
}: PressableProps & {
  title: string;
  icon?: string;
  variant?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
}) {
  const theme = useQashyTheme();
  const isDisabled = Boolean(disabled);
  const backgroundColor = variant === 'primary' ? theme.accent : variant === 'danger' ? theme.negative : theme.surfaceMuted;
  const foreground = variant === 'primary' ? theme.onAccent : variant === 'danger' ? theme.onNegative : theme.text;
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityState={{ ...accessibilityState, busy, disabled: isDisabled }}
      {...props}
      disabled={isDisabled}
      onPress={(event) => {
        if (isDisabled) return;
        if (process.env.EXPO_OS === 'ios') Haptics.selectionAsync();
        onPress?.(event);
      }}
      style={(pressableState) => [
        {
          minHeight: 48,
          paddingHorizontal: 18,
          borderRadius: 999,
          backgroundColor,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 8,
          opacity: isDisabled ? 0.45 : pressableState.pressed ? 0.76 : 1,
        },
        typeof style === 'function' ? style(pressableState) : style,
      ]}>
      <MotionView
        key={`${title}-${icon ?? ''}`}
        variant="fade"
        animateLayout
        style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }}>
        {icon ? <AppIcon name={icon} color={foreground} size={18} /> : null}
        <AppText selectable={false} variant="label" style={{ color: foreground }}>{title}</AppText>
      </MotionView>
    </MotionPressable>
  );
}
