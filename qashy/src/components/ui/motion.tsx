import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const REST_STATE: PressableStateCallbackType = { pressed: false, hovered: false };
const PRESSED_STATE: PressableStateCallbackType = { pressed: true, hovered: false };
const HOVERED_STATE: PressableStateCallbackType = { pressed: false, hovered: true };

type MotionVariant = 'fade' | 'up' | 'down' | 'left' | 'right' | 'zoom';
// Moved onto the animated wrapper: box-model and flex participation belong to
// the outer element, otherwise the wrapper collapses to content size and a
// `flex: 1` pressable has nothing to fill.
const wrapperStyleKeys = [
  'alignSelf',
  'bottom',
  'display',
  'end',
  'flex',
  'flexBasis',
  'flexGrow',
  'flexShrink',
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

// Mirrored onto the wrapper but kept on the pressable, so the wrapper cannot
// shrink below an explicitly sized control and a percentage size still resolves
// against the real parent.
const mirroredStyleKeys = ['width', 'height'] as const satisfies readonly (keyof ViewStyle)[];

const wrapperStyleKeySet: ReadonlySet<string> = new Set<string>(wrapperStyleKeys);

/**
 * Reanimated can only carry primitives across to the UI thread. A PlatformColor
 * (Material You) is an opaque object, so a style that swaps one on press has to
 * stay on the JS thread.
 */
function isWorkletSafe(value: unknown) {
  return typeof value === 'number' || typeof value === 'string';
}

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
  const initiallyPressed = Boolean(props.testOnly_pressed);
  const scale = useSharedValue(1);
  const translateY = useSharedValue(0);
  const isPressed = useSharedValue(initiallyPressed ? 1 : 0);
  const isHovered = useSharedValue(0);
  // Read synchronously by the JS-thread handlers below; the shared values above
  // exist purely so styles can react without a React render.
  const pressedRef = useRef(initiallyPressed);
  const hoveredRef = useRef(false);
  const [jsPressed, setJsPressed] = useState(initiallyPressed);
  const [jsHovered, setJsHovered] = useState(false);

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

  const resolveStyle = (pressableState: PressableStateCallbackType): ViewStyle =>
    (StyleSheet.flatten(typeof style === 'function' ? style(pressableState) : style) ?? {}) as ViewStyle;

  // Evaluate the caller's style callback once per state up front. Everything a
  // press changes then becomes data the UI thread can pick between, instead of
  // something that needs a re-render to recompute.
  const restStyle = resolveStyle(REST_STATE);
  const pressedStyle = typeof style === 'function' ? resolveStyle(PRESSED_STATE) : restStyle;
  const hoveredStyle = typeof style === 'function' ? resolveStyle(HOVERED_STATE) : restStyle;
  const stateKeys = (Array.from(new Set([
    ...Object.keys(restStyle),
    ...Object.keys(pressedStyle),
    ...Object.keys(hoveredStyle),
  ])) as (keyof ViewStyle)[]).filter((key) => (
    !wrapperStyleKeySet.has(key)
    && (restStyle[key] !== pressedStyle[key] || restStyle[key] !== hoveredStyle[key])
  ));
  const canDriveFromUiThread = stateKeys.every((key) => (
    isWorkletSafe(restStyle[key]) && isWorkletSafe(pressedStyle[key]) && isWorkletSafe(hoveredStyle[key])
  ));
  // A function child, or a value Reanimated cannot carry, still needs the old
  // render-per-touch behaviour so consumers keep working.
  const usesJsState = typeof children === 'function' || (stateKeys.length > 0 && !canDriveFromUiThread);

  const state: PressableStateCallbackType = usesJsState
    ? { pressed: jsPressed, hovered: jsHovered }
    : REST_STATE;
  const flattenedStyle = usesJsState ? resolveStyle(state) : restStyle;
  const overrideKeys = usesJsState ? [] : (stateKeys as string[]);
  const restValues = overrideKeys.map((key) => restStyle[key as keyof ViewStyle]);
  const pressedValues = overrideKeys.map((key) => pressedStyle[key as keyof ViewStyle]);
  const hoveredValues = overrideKeys.map((key) => hoveredStyle[key as keyof ViewStyle]);

  const overrideStyle = useAnimatedStyle(() => {
    const pressedNow = isPressed.value > 0;
    const hoveredNow = isHovered.value > 0;
    const next: Record<string, unknown> = {};
    for (let index = 0; index < overrideKeys.length; index += 1) {
      next[overrideKeys[index]] = pressedNow
        ? pressedValues[index]
        : hoveredNow
          ? hoveredValues[index]
          : restValues[index];
    }
    return next as ViewStyle;
  });

  const wrapperStyle: ViewStyle = {};
  const pressableStyle: ViewStyle = { ...flattenedStyle };
  wrapperStyleKeys.forEach((key) => {
    const value = flattenedStyle[key];
    if (value === undefined) return;
    Object.assign(wrapperStyle, { [key]: value });
    delete pressableStyle[key];
  });
  mirroredStyleKeys.forEach((key) => {
    const value = flattenedStyle[key];
    if (value === undefined) return;
    Object.assign(wrapperStyle, { [key]: value });
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
      <AnimatedPressable
        {...props}
        disabled={disabled}
        onHoverIn={(event) => {
          hoveredRef.current = true;
          isHovered.set(1);
          if (usesJsState) setJsHovered(true);
          if (!pressedRef.current && !disabled) {
            scale.set(withTiming(hoverScale, timingConfig));
            translateY.set(withTiming(liftOnHover ? -1 : 0, timingConfig));
          }
          onHoverIn?.(event);
        }}
        onHoverOut={(event) => {
          hoveredRef.current = false;
          isHovered.set(0);
          if (usesJsState) setJsHovered(false);
          if (!pressedRef.current) {
            scale.set(withTiming(1, timingConfig));
            translateY.set(withTiming(0, timingConfig));
          }
          onHoverOut?.(event);
        }}
        onPressIn={(event) => {
          pressedRef.current = true;
          isPressed.set(1);
          if (usesJsState) setJsPressed(true);
          if (!disabled) {
            scale.set(withSpring(pressedScale, springConfig));
            translateY.set(withTiming(0, timingConfig));
          }
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          pressedRef.current = false;
          isPressed.set(0);
          if (usesJsState) setJsPressed(false);
          scale.set(withSpring(hoveredRef.current ? hoverScale : 1, springConfig));
          translateY.set(withTiming(hoveredRef.current && liftOnHover ? -1 : 0, timingConfig));
          onPressOut?.(event);
        }}
        style={[pressableStyle, overrideStyle]}>
        {resolvedChildren}
      </AnimatedPressable>
    </Animated.View>
  );
}
