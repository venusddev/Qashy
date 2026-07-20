import { StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { IconButton } from '@/components/ui/icon-button';
import { useQashyTheme } from '@/theme/theme';
import { hapticImpactLight } from '@/utils/haptics';

export function FloatingActionButton({
  label,
  icon = 'plus',
  visibility,
  onPress,
  style,
  disabled = false,
  ...props
}: Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  icon?: string;
  /** 0–1 shared value (see useScrollHide); the button tucks away toward 0. */
  visibility?: SharedValue<number>;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useQashyTheme();
  const isDisabled = Boolean(disabled);
  // A near-black drop shadow disappears on dark surfaces, so deepen and spread
  // it instead of tinting the button itself.
  const shadow = theme.mode === 'dark'
    ? '0 6px 18px rgba(0,0,0,0.58)'
    : '0 4px 14px rgba(25,27,32,0.28)';
  const visibilityStyle = useAnimatedStyle(() => {
    if (!visibility) return {};
    const shown = visibility.value;
    return {
      opacity: shown,
      transform: [{ scale: 0.6 + 0.4 * shown }, { translateY: (1 - shown) * 12 }],
      pointerEvents: shown < 0.5 ? ('none' as const) : ('auto' as const),
    };
  });

  return (
    <Animated.View style={[StyleSheet.flatten(style), visibilityStyle]}>
      <IconButton
        {...props}
        disabled={isDisabled}
        onPress={(event) => {
          hapticImpactLight();
          onPress?.(event);
        }}
        label={label}
        icon={icon}
        variant="accent"
        size={58}
        iconSize={25}
        enteringVariant="zoom"
        enteringDelay={140}
        style={(state) => ({
          boxShadow: shadow,
          opacity: isDisabled ? 0.4 : state.pressed ? 0.82 : 1,
        })}
      />
    </Animated.View>
  );
}
