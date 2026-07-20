import { useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Easing, ReduceMotion, useSharedValue, withTiming } from 'react-native-reanimated';

const ALWAYS_SHOW_OFFSET = 32;
const HIDE_AFTER_OFFSET = 80;
const DIRECTION_THRESHOLD = 6;

/**
 * Tracks scroll direction and exposes a 0–1 visibility value: scrolling down
 * hides (0), scrolling up or resting near the top shows (1). Attach `onScroll`
 * to a scrollable (with `scrollEventThrottle={16}`) and hand `visibility` to
 * `FloatingActionButton`.
 */
export function useScrollHide() {
  const visibility = useSharedValue(1);
  const lastOffset = useRef(0);
  const shown = useRef(true);

  const setShown = (next: boolean) => {
    if (shown.current === next) return;
    shown.current = next;
    visibility.set(withTiming(next ? 1 : 0, {
      duration: 200,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    }));
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = event.nativeEvent.contentOffset.y;
    const delta = offset - lastOffset.current;
    lastOffset.current = offset;
    if (offset <= ALWAYS_SHOW_OFFSET || delta < -DIRECTION_THRESHOLD) setShown(true);
    else if (delta > DIRECTION_THRESHOLD && offset > HIDE_AFTER_OFFSET) setShown(false);
  };

  return { visibility, onScroll };
}
