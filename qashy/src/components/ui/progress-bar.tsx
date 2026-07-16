import { useEffect } from 'react';
import { View, type ColorValue } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useQashyTheme } from '@/theme/theme';

export function ProgressBar({ value, color }: { value: number; color?: ColorValue }) {
  const theme = useQashyTheme();
  const clamped = Math.max(0, Math.min(1, value));
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? clamped : 0);

  useEffect(() => {
    progress.set(withTiming(clamped, {
      duration: 420,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    }));
  }, [clamped, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: progress.value }],
  }));

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={{ height: 9, borderRadius: 99, overflow: 'hidden', backgroundColor: theme.surfaceMuted }}>
      <Animated.View
        style={[
          {
            height: '100%',
            width: '100%',
            transformOrigin: 'left center',
          },
          animatedStyle,
        ]}>
        <View style={{ flex: 1, borderRadius: 99, backgroundColor: color ?? theme.accent }} />
      </Animated.View>
    </View>
  );
}
