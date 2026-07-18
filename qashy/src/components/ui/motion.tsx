import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  type PressableProps,
  type PressableStateCallbackType,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeInLeft,
  FadeInRight,
  FadeInUp,
  FadeOut,
  FadeOutDown,
  FadeOutLeft,
  FadeOutRight,
  FadeOutUp,
  LinearTransition,
  ReduceMotion,
  ZoomIn,
  ZoomOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

const springConfig = {
  damping: 20,
  stiffness: 380,
  mass: 0.7,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
} as const;

const timingConfig = {
  duration: 150,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;

type MotionVariant = 'fade' | 'up' | 'down' | 'left' | 'right' | 'zoom';
const wrapperStyleKeys = [
  'alignSelf',
  'bottom',
  'display',
  'end',
  'left',
  'margin',
  'marginBlock',
  'marginBlockEnd',
  'marginBlockStart',
  'marginBottom',
  'marginEnd',
  'marginHorizontal',
  'marginInline',
  'marginInlineEnd',
  'marginInlineStart',
  'marginLeft',
  'marginRight',
  'marginStart',
  'marginTop',
  'marginVertical',
  'position',
  'right',
  'start',
  'top',
  'zIndex',
] as const satisfies readonly (keyof ViewStyle)[];

function enteringAnimation(variant: MotionVariant, delay: number, duration = 220) {
  const animation = variant === 'fade'
    ? FadeIn
    : variant === 'down'
      ? FadeInDown
      : variant === 'left'
        ? FadeInLeft
        : variant === 'right'
          ? FadeInRight
          : variant === 'zoom'
            ? ZoomIn
            : FadeInUp;
  return animation
    .duration(duration)
    .delay(delay)
    .easing(Easing.out(Easing.cubic))
    .reduceMotion(ReduceMotion.System);
}

function exitingAnimation(variant: MotionVariant) {
  const animation = variant === 'down'
    ? FadeOutDown
    : variant === 'left'
      ? FadeOutRight
      : variant === 'right'
        ? FadeOutLeft
        : variant === 'up'
          ? FadeOutUp
          : variant === 'zoom'
            ? ZoomOut
            : FadeOut;
  return animation
    .duration(140)
    .easing(Easing.in(Easing.cubic))
    .reduceMotion(ReduceMotion.System);
}

export function MotionView({
  variant = 'up',
  delay = 0,
  duration = 220,
  animateLayout = false,
  exit = false,
  ...props
}: ViewProps & {
  variant?: MotionVariant;
  delay?: number;
  duration?: number;
  animateLayout?: boolean;
  exit?: boolean;
}) {
  const entering = useMemo(() => enteringAnimation(variant, delay, duration), [delay, duration, variant]);
  const exiting = useMemo(() => exit ? exitingAnimation(variant) : undefined, [exit, variant]);
  const layout = useMemo(
    () => animateLayout
      ? LinearTransition.duration(180).easing(Easing.out(Easing.cubic)).reduceMotion(ReduceMotion.System)
      : undefined,
    [animateLayout],
  );

  return <Animated.View {...props} entering={entering} exiting={exiting} layout={layout} />;
}

export function MotionPressable({
  children,
  style,
  onPressIn,
  onPressOut,
  onHoverIn,
  onHoverOut,
  disabled = false,
  pressedScale = 0.975,
  hoverScale = 1.008,
  liftOnHover = true,
  active = false,
  enteringVariant,
  enteringDelay = 0,
  ...props
}: Omit<PressableProps, 'children' | 'style'> & {
  children?: ReactNode | ((state: PressableStateCallbackType) => ReactNode);
  style?: PressableProps['style'];
  pressedScale?: number;
  hoverScale?: number;
  liftOnHover?: boolean;
  active?: boolean;
  enteringVariant?: 'fade' | 'zoom';
  enteringDelay?: number;
}) {
  const reduceMotion = useReducedMotion();
  const [pressed, setPressed] = useState(Boolean(props.testOnly_pressed));
  const [hovered, setHovered] = useState(false);
  const scale = useSharedValue(1);
  const translateY = useSharedValue(0);

  useEffect(() => {
    if (!active || reduceMotion) return;
    scale.set(1.035);
    scale.set(withSpring(1, springConfig));
  }, [active, reduceMotion, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));
  const state: PressableStateCallbackType = { pressed, hovered };
  const resolvedStyle = typeof style === 'function' ? style(state) : style;
  const flattenedStyle = StyleSheet.flatten(resolvedStyle) ?? {};
  const wrapperStyle: ViewStyle = {};
  const pressableStyle: ViewStyle = { ...flattenedStyle };
  wrapperStyleKeys.forEach((key) => {
    const value = flattenedStyle[key];
    if (value === undefined) return;
    Object.assign(wrapperStyle, { [key]: value });
    delete pressableStyle[key];
  });
  const resolvedChildren = typeof children === 'function' ? children(state) : children;
  const entering = useMemo(
    () => enteringVariant ? enteringAnimation(enteringVariant, enteringDelay) : undefined,
    [enteringDelay, enteringVariant],
  );

  return (
    <Animated.View
      entering={entering}
      style={[wrapperStyle, animatedStyle]}>
      <Pressable
        {...props}
        disabled={disabled}
        onHoverIn={(event) => {
          setHovered(true);
          if (!pressed && !disabled) {
            scale.set(withTiming(hoverScale, timingConfig));
            translateY.set(withTiming(liftOnHover ? -1 : 0, timingConfig));
          }
          onHoverIn?.(event);
        }}
        onHoverOut={(event) => {
          setHovered(false);
          if (!pressed) {
            scale.set(withTiming(1, timingConfig));
            translateY.set(withTiming(0, timingConfig));
          }
          onHoverOut?.(event);
        }}
        onPressIn={(event) => {
          setPressed(true);
          if (!disabled) {
            scale.set(withSpring(pressedScale, springConfig));
            translateY.set(withTiming(0, timingConfig));
          }
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          setPressed(false);
          scale.set(withSpring(hovered ? hoverScale : 1, springConfig));
          translateY.set(withTiming(hovered && liftOnHover ? -1 : 0, timingConfig));
          onPressOut?.(event);
        }}
        style={pressableStyle}>
        {resolvedChildren}
      </Pressable>
    </Animated.View>
  );
}
