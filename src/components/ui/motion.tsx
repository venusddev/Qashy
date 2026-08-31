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
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
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

// PressableStateCallbackType in RN 0.86 is { pressed: boolean } only. The motion
// system tracks hover separately via onHoverIn/Out and the shared values below, so
// extend the type locally rather than pretending RN provides it.
type ExtendedPressableState = PressableStateCallbackType & { hovered: boolean };

const REST_STATE: ExtendedPressableState = { pressed: false, hovered: false };
const PRESSED_STATE: ExtendedPressableState = { pressed: true, hovered: false };
const HOVERED_STATE: ExtendedPressableState = { pressed: false, hovered: true };

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

// Where each variant starts before it settles into place. The presets ship with
// a 25px offset and ZoomIn starts from scale 0, which is what made every mount
// look like it was being performed.
const ENTRANCE_START: Record<MotionVariant, { translateX: number; translateY: number; scale: number }> = {
  fade: { translateX: 0, translateY: 0, scale: 1 },
  up: { translateX: 0, translateY: -TRAVEL, scale: 1 },
  down: { translateX: 0, translateY: TRAVEL, scale: 1 },
  left: { translateX: -TRAVEL, translateY: 0, scale: 1 },
  right: { translateX: TRAVEL, translateY: 0, scale: 1 },
  zoom: { translateX: 0, translateY: 0, scale: 0.94 },
};

/**
 * The entrance, driven by a shared value rather than Reanimated's `entering`.
 *
 * Softening the presets used to mean `withInitialValues`, which makes Reanimated
 * generate a keyframe whose name is not in its built-in `Animations` registry.
 * On web that is the one branch of `setElementAnimation` that schedules cleanup,
 * and cleanup for an ENTERING animation calls `setElementPosition` — so roughly
 * 200ms after mount every softened element was permanently given
 * `position: absolute` and a snapshot `top/left/width/height`. Content dropped
 * out of flow across the whole site: button labels landed outside their button,
 * which then collapsed to its own padding.
 *
 * A shared value reaches the same start states without generating a keyframe,
 * and runs identically on the worklet path and on web. `exiting` and `layout`
 * stay on Reanimated: they need an element the tree no longer owns, and neither
 * goes through the branch above.
 */
function useEntrance(variant: MotionVariant, delay: number, duration: number, enabled: boolean) {
  const progress = useSharedValue(enabled ? 0 : 1);

  useEffect(() => {
    if (!enabled) return;
    progress.set(withDelay(delay, withTiming(1, {
      duration,
      easing: EASE_STANDARD,
      reduceMotion: ReduceMotion.System,
    })));
  }, [delay, duration, enabled, progress]);

  const start = ENTRANCE_START[variant];
  const style = useAnimatedStyle(() => {
    const remaining = 1 - progress.value;
    return {
      opacity: progress.value,
      transform: [
        { translateX: start.translateX * remaining },
        { translateY: start.translateY * remaining },
        { scale: 1 - (1 - start.scale) * remaining },
      ],
    };
  });

  // Elements that arrive with their screen never carry an opacity or transform
  // they did not ask for.
  return enabled ? style : null;
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
  const entranceStyle = useEntrance(variant, delay, duration, allowEntrance);
  const exiting = useMemo(() => exit ? exitingAnimation() : undefined, [exit]);
  const layout = useMemo(
    () => animateLayout
      ? LinearTransition.duration(motionDurations.layout).easing(EASE_STANDARD).reduceMotion(ReduceMotion.System)
      : undefined,
    [animateLayout],
  );

  if (!animateLayout) {
    const { style: plainStyle, ...plainProps } = props;
    return <Animated.View {...plainProps} exiting={exiting} style={[plainStyle, entranceStyle]} />;
  }

  // Reanimated layout transitions and the entrance both write `transform`.
  // Keeping them on one node makes one overwrite the other. The outer view owns
  // layout participation; the inner view owns visual motion. `collapsable={false}`
  // also keeps the wrapper alive for its child's exit.
  const { style, ...viewProps } = props;
  const { wrapperStyle, contentStyle } = splitWrapperStyle(style);
  return (
    <Animated.View collapsable={false} layout={layout} style={wrapperStyle}>
      <Animated.View
        {...viewProps}
        exiting={exiting}
        style={[contentStyle, entranceStyle]}
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
  children?: ReactNode | ((state: ExtendedPressableState) => ReactNode);
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

  const resolveStyle = (pressableState: ExtendedPressableState): ViewStyle =>
    (StyleSheet.flatten(
      typeof style === 'function'
        ? (style as unknown as (s: ExtendedPressableState) => ViewStyle)(pressableState)
        : style,
    ) ?? {}) as ViewStyle;

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

  const state: ExtendedPressableState = usesJsState
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
  const entranceStyle = useEntrance(
    enteringVariant ?? 'fade',
    enteringDelay,
    motionDurations.enter,
    allowEntrance,
  );

  return (
    <Animated.View
      collapsable={false}
      style={[wrapperStyle, entranceStyle]}>
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
