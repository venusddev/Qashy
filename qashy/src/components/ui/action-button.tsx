import * as Haptics from 'expo-haptics';
import { Pressable, type PressableProps } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { useQashyTheme } from '@/theme/theme';

export function ActionButton({ title, icon, variant = 'primary', onPress, style, ...props }: PressableProps & { title: string; icon?: string; variant?: 'primary' | 'secondary' | 'danger' }) {
  const theme = useQashyTheme();
  const backgroundColor = variant === 'primary' ? theme.accent : variant === 'danger' ? theme.negative : theme.surfaceMuted;
  const foreground = variant === 'primary' || variant === 'danger' ? theme.onAccent : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      {...props}
      onPress={(event) => {
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
          opacity: pressableState.pressed ? 0.76 : 1,
        },
        typeof style === 'function' ? style(pressableState) : style,
      ]}>
      {icon ? <AppIcon name={icon} color={foreground} size={18} /> : null}
      <AppText selectable={false} variant="label" style={{ color: foreground }}>{title}</AppText>
    </Pressable>
  );
}
