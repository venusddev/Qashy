import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  LinearTransition,
  ReduceMotion,
  ZoomIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

// ── The motion system ───────────────────────────────────────────────────────
// One curve family, two durations, one travel distance, no overshoot. Motion
// here exists to explain a change, never to announce itself: content settles
// into the place it already belongs instead of flying in from off-screen, and
// nothing bounces — an overshoot on a surface the user did not physically drag
// is the single thing that makes an interface read as a toy.
export const motionDurations = {
  /** Anything arriving or changing in place. */
  enter: 200,
  /** Anything leaving. Exits are always faster than entrances. */
  exit: 120,
  /** Reflow after an insert, delete, or resize. */
  layout: 200,
  /** A whole screen cross-fading in behind a navigation. */
  screen: 180,
} as const;

// How far anything travels while it fades. Small enough to read as a settle
// rather than a flight; the fade carries the change, the offset only hints at
// where it came from.
const TRAVEL = 8;

// Reanimated's web implementation runs entering/exiting/layout through CSS, and
// it can only translate a bare `WebEasings` name or an `Easing.bezier`. A
// composed easing like `Easing.out(Easing.cubic)` is neither, so it warned
// "Selected easing is not currently supported on web" for every animated mount
// — dozens per screen — and then silently ran the animation *linear*. Both
// curves below are `Easing.bezier`, so they resolve identically on the CSS path
// and the worklet path and can be shared by every animation in the app.
const EASE_STANDARD = Easing.bezier(0.2, 0, 0, 1);
const EASE_EXIT = Easing.bezier(0.4, 0, 1, 1);

const springConfig = {
  damping: 20,
  stiffness: 380,
  mass: 0.7,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
} as const;

const timingConfig = {
  duration: motionDurations.exit,
  easing: EASE_STANDARD,
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

function splitWrapperStyle(style: ViewProps['style']) {
  const flattenedStyle = (StyleSheet.flatten(style) ?? {}) as ViewStyle;
  const wrapperStyle: ViewStyle = {};
  const contentStyle: ViewStyle = { ...flattenedStyle };
  wrapperStyleKeys.forEach((key) => {
    const value = flattenedStyle[key];
    if (value === undefined) return;
    Object.assign(wrapperStyle, { [key]: value });
    delete contentStyle[key];
  });
  mirroredStyleKeys.forEach((key) => {
    const value = flattenedStyle[key];
    if (value === undefined) return;
    Object.assign(wrapperStyle, { [key]: value });
  });
  return { wrapperStyle, contentStyle };
}

/**
 * Reanimated can only carry primitives across to the UI thread. A PlatformColor
 * (Material You) is an opaque object, so a style that swaps one on press has to
 * stay on the JS thread.
 */
function isWorkletSafe(value: unknown) {
  return typeof value === 'number' || typeof value === 'string';
}

// The presets ship with a 25px offset and ZoomIn starts from scale 0, which is
// what made every mount look like it was being performed. `withInitialValues`
// is honoured on both the worklet path and the CSS path, so overriding the
// start state keeps one implementation for both platforms.
function enteringAnimation(variant: MotionVariant, delay: number, duration: number = motionDurations.enter) {
  // Every branch has to be a builder *instance* rather than the class, or the
  // union of them loses the chainable config methods below.
  const animation = variant === 'fade'
    ? FadeIn.withInitialValues({ opacity: 0 })
    : variant === 'down'
      ? FadeInDown.withInitialValues({ transform: [{ translateY: TRAVEL }] })
      : variant === 'left'
        ? FadeInLeft.withInitialValues({ transform: [{ translateX: -TRAVEL }] })
        : variant === 'right'
          ? FadeInRight.withInitialValues({ transform: [{ translateX: TRAVEL }] })
          : variant === 'zoom'
            ? ZoomIn.withInitialValues({ transform: [{ scale: 0.94 }] })
            : FadeInUp.withInitialValues({ transform: [{ translateY: -TRAVEL }] });
  return animation
    .duration(duration)
    .delay(delay)
    .easing(EASE_STANDARD)
    .reduceMotion(ReduceMotion.System);
}

// Every exit is a plain fade, whatever the entrance was. Direction is
// information about where content is *going*, and content being removed isn't
// going anywhere — the incoming element already carries the direction. Keeping
// exits uniform also sidesteps the presets' fixed 25px exit offset, which
// `withInitialValues` cannot reach because it only overrides the start state.
function exitingAnimation() {
  return FadeOut
    .duration(motionDurations.exit)
    .easing(EASE_EXIT)
    .reduceMotion(ReduceMotion.System);
}

type SettledRef = { current: boolean };

const ScreenEntranceContext = createContext<SettledRef | null>(null);

/**
 * Whether an element that is mounting right now has earned an entrance.
 *
 * Reanimated fires `entering` whenever a node mounts, and navigating to a tab
 * mounts every node on that screen at once — so the whole screen replayed its
 * choreography on every single visit. That reads as a performance rather than a
 * response. Inside a `ScreenTransition`, anything mounting as part of the
 * screen's first paint skips its entrance and simply arrives with the screen's
 * own cross-fade; anything mounting *later* — a new transaction, an expanded
 * section, a filter result — still animates, because there the motion is
 * feedback for something the user just did.
 *
 * The answer is captured once, at mount, so an element that arrived with the
 * screen cannot start animating later just because it re-rendered.
 */
function useEntranceAllowed(enabled: boolean) {
  const settled = useContext(ScreenEntranceContext);
  const [allowedAtMount] = useState(() => settled === null || settled.current);
  return enabled && allowedAtMount;
}

/**
 * Wraps a screen's content: cross-fades the screen itself and suppresses the
 * per-element entrances underneath it for that first paint.
 */
export function ScreenTransition({ style, ...props }: ViewProps) {
  const settled = useRef(false);

  useEffect(() => {
    // Two frames: one for this commit to paint, one for children that only
    // mount after measuring themselves (the charts size from `onLayout`).
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        settled.current = true;
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  const entering = useMemo(
    () => FadeIn.duration(motionDurations.screen).easing(EASE_STANDARD).reduceMotion(ReduceMotion.System),
    [],
  );

  return (
    <ScreenEntranceContext.Provider value={settled}>
      <Animated.View {...props} entering={entering} style={style} />
    </ScreenEntranceContext.Provider>
  );
}

export function MotionView({
  variant = 'up',
  delay = 0,
  duration = motionDurations.enter,
  animateLayout = false,
  exit = false,
  entrance = true,
  ...props
}: ViewProps & {
  variant?: MotionVariant;
  delay?: number;
  duration?: number;
  animateLayout?: boolean;
  exit?: boolean;
  /**
   * Opt out of the entrance entirely. For virtualised rows, where "mounting"
   * only means the row scrolled into the render window.
   */
  entrance?: boolean;
}) {
  const allowEntrance = useEntranceAllowed(entrance);
  const entering = useMemo(
    () => allowEntrance ? enteringAnimation(variant, delay, duration) : undefined,
    [allowEntrance, delay, duration, variant],
  );
  const exiting = useMemo(() => exit ? exitingAnimation() : undefined, [exit]);
  const layout = useMemo(
    () => animateLayout
      ? LinearTransition.duration(motionDurations.layout).easing(EASE_STANDARD).reduceMotion(ReduceMotion.System)
      : undefined,
    [animateLayout],
  );

  if (!animateLayout) {
    return <Animated.View {...props} entering={entering} exiting={exiting} />;
  }

  // Reanimated layout transitions and directional entering/exiting presets both
  // write `transform`. Keeping them on one node makes one overwrite the other.
  // The outer view owns layout participation; the inner view owns visual motion.
  // `collapsable={false}` also keeps the wrapper alive for its child's exit.
  const { style, ...viewProps } = props;
  const { wrapperStyle, contentStyle } = splitWrapperStyle(style);
  return (
    <Animated.View collapsable={false} layout={layout} style={wrapperStyle}>
      <Animated.View
        {...viewProps}
        entering={entering}
        exiting={exiting}
        style={contentStyle}
      />
    </Animated.View>
  );
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

  const { wrapperStyle, contentStyle: pressableStyle } = splitWrapperStyle(flattenedStyle);
  const resolvedChildren = typeof children === 'function' ? children(state) : children;
  const allowEntrance = useEntranceAllowed(Boolean(enteringVariant));
  const entering = useMemo(
    () => allowEntrance && enteringVariant ? enteringAnimation(enteringVariant, enteringDelay) : undefined,
    [allowEntrance, enteringDelay, enteringVariant],
  );

  return (
    <Animated.View
      collapsable={false}
      entering={entering}
      style={wrapperStyle}>
      <Animated.View style={animatedStyle}>
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
    </Animated.View>
  );
}
