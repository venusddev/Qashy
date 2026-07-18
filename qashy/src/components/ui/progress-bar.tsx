import { useEffect, useRef, useState } from 'react';
import { type ColorValue } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useQashyTheme } from '@/theme/theme';

const fillSpring = {
  damping: 16,
  stiffness: 210,
  mass: 0.8,
  reduceMotion: ReduceMotion.System,
} as const;

export function ProgressBar({
  value,
  color,
  milestones = [1],
  onMilestone,
}: {
  value: number;
  color?: ColorValue;
  /** Ratios that trigger a celebratory pulse when crossed upward after mount. */
  milestones?: number[];
  onMilestone?: (milestone: number) => void;
}) {
  const theme = useQashyTheme();
  const clamped = Math.max(0, Math.min(1, value));
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? clamped : 0);
  const pulse = useSharedValue(1);
  const colorMix = useSharedValue(1);
  const fillColor = String(color ?? theme.accent);
  // Render-phase pair swap (same pattern as the transactions overlay state) so
  // a color change crossfades from the previously shown color.
  const [colorPair, setColorPair] = useState({ from: fillColor, to: fillColor });
  if (colorPair.to !== fillColor) {
    setColorPair({ from: colorPair.to, to: fillColor });
  }
  const mountedRef = useRef(false);
  const previousValueRef = useRef(value);
  const milestoneRef = useRef({ milestones, onMilestone });

  // Runs before the value effect below, so crossings always see the latest
  // milestone config without re-triggering on array identity changes.
  useEffect(() => {
    milestoneRef.current = { milestones, onMilestone };
  });

  useEffect(() => {
    if (colorPair.from === colorPair.to) return;
    colorMix.set(0);
    colorMix.set(withTiming(1, {
      duration: 260,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    }));
  }, [colorMix, colorPair]);

  useEffect(() => {
    const previous = previousValueRef.current;
    previousValueRef.current = value;
    if (!mountedRef.current) {
      mountedRef.current = true;
      progress.set(withTiming(clamped, {
        duration: 420,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }));
      return;
    }
    progress.set(withSpring(clamped, fillSpring));
    const crossed = milestoneRef.current.milestones.filter(
      (milestone) => previous < milestone && value >= milestone,
    );
    if (!crossed.length) return;
    milestoneRef.current.onMilestone?.(Math.max(...crossed));
    if (reduceMotion) return;
    pulse.set(withSequence(
      withTiming(1.45, { duration: 150, easing: Easing.out(Easing.cubic) }),
      withTiming(1, { duration: 240, easing: Easing.inOut(Easing.cubic) }),
    ));
  }, [clamped, progress, pulse, reduceMotion, value]);

  const trackStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: pulse.value }],
  }));
  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: progress.value }],
  }));
  const fillColorStyle = useAnimatedStyle(() => ({
    backgroundColor: colorPair.from === colorPair.to
      ? colorPair.to
      : interpolateColor(colorMix.value, [0, 1], [colorPair.from, colorPair.to]),
  }));

  return (
    <Animated.View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[
        { height: 9, borderRadius: 99, overflow: 'hidden', backgroundColor: theme.surfaceMuted },
        trackStyle,
      ]}>
      <Animated.View
        style={[
          {
            height: '100%',
            width: '100%',
            transformOrigin: 'left center',
          },
          fillStyle,
        ]}>
        <Animated.View style={[{ flex: 1, borderRadius: 99 }, fillColorStyle]} />
      </Animated.View>
    </Animated.View>
  );
}
