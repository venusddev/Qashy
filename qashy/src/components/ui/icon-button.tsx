import { Pressable, type PressableProps } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { useQashyTheme } from '@/theme/theme';

export function IconButton({
  label,
  icon,
  onPress,
  size = 44,
  iconSize = 19,
  variant = 'plain',
  disabled = false,
  style,
  accessibilityState,
  ...props
}: Omit<PressableProps, 'children'> & {
  label: string;
  icon: string;
  size?: number;
  iconSize?: number;
  variant?: 'plain' | 'surface' | 'accent';
}) {
  const theme = useQashyTheme();
  const isDisabled = Boolean(disabled);
  const backgroundColor = variant === 'accent'
    ? theme.accent
    : variant === 'surface'
      ? theme.surfaceMuted
      : 'transparent';
  const color = variant === 'accent' ? theme.onAccent : theme.textMuted;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ ...accessibilityState, disabled: isDisabled }}
      {...props}
      disabled={isDisabled}
      onPress={onPress}
      style={(state) => [
        {
          width: size,
          height: size,
          minWidth: 44,
          minHeight: 44,
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor,
          opacity: isDisabled ? 0.4 : state.pressed ? 0.66 : 1,
        },
        typeof style === 'function' ? style(state) : style,
      ]}>
      <AppIcon name={icon} color={color} size={iconSize} />
    </Pressable>
  );
}
