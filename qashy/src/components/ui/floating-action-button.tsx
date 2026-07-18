import { StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { IconButton } from '@/components/ui/icon-button';
import { hapticImpactLight } from '@/utils/haptics';

export function FloatingActionButton({
  label,
  icon = 'plus',
  visibility,
  onPress,
  style,
  ...props
}: Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  icon?: string;
  /** 0–1 shared value (see useScrollHide); the button tucks away toward 0. */
  visibility?: SharedValue<number>;
  style?: StyleProp<ViewStyle>;
}) {
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
          boxShadow: '0 4px 14px rgba(25,27,32,0.28)',
          opacity: state.pressed ? 0.82 : 1,
        })}
      />
    </Animated.View>
  );
}
