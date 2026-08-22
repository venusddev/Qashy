import { useEffect, useRef, useState } from 'react';
import { type TextProps } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { AppText } from '@/components/ui/app-text';
import type { CurrencyCode } from '@/domain/models';
import { formatMoney } from '@/utils/money';

const COUNT_DURATION = 420;

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Rolls a minor-unit amount toward its target so value changes read as motion
 * instead of a snap. The first render shows the target immediately; only
 * subsequent changes animate. Reduced motion always snaps.
 */
export function useAnimatedMinorAmount(target: number) {
  const reduceMotion = useReducedMotion();
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const frameRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const from = displayRef.current;
    // A large jump (e.g. a new budget period or account switch) reads as a
    // snap, not motion; counting up through it would feel sluggish.
    const largeChange = Math.abs(target - from) > Math.max(Math.abs(from), Math.abs(target)) * 0.5;
    if (!mountedRef.current || reduceMotion || from === target || largeChange) {
      mountedRef.current = true;
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    const start = Date.now();
    const step = () => {
      const progress = Math.min(1, (Date.now() - start) / COUNT_DURATION);
      const value = progress >= 1
        ? target
        : Math.round(from + (target - from) * easeOutCubic(progress));
      displayRef.current = value;
      setDisplay(value);
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
      else frameRef.current = null;
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [reduceMotion, target]);

  return display;
}

export function AnimatedMoney({
  minor,
  currency,
  locale,
  compact = false,
  sign = false,
  ...props
}: TextProps & {
  minor: number;
  currency: CurrencyCode;
  locale: string;
  variant?: 'display' | 'title' | 'headline' | 'body' | 'caption' | 'label' | 'eyebrow' | 'money';
  muted?: boolean;
  /** Fixed-width digits. Implied by `display` and `money`; set it on the rest. */
  numeric?: boolean;
  compact?: boolean;
  sign?: boolean;
}) {
  const display = useAnimatedMinorAmount(minor);
  return (
    <AppText
      // Assistive tech should read the settled amount, not the mid-count value.
      accessibilityLabel={formatMoney(minor, currency, locale, { compact, sign })}
      // Always a formatted amount, never dictionary copy.
      literal
      {...props}>
      {formatMoney(display, currency, locale, { compact, sign })}
    </AppText>
  );
}
