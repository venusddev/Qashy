import { Link, Slot, usePathname } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { useLocalization } from '@/localization/localization';
import {
  ContentWidthContext,
  NAV_RAIL_BREAKPOINT,
  NAV_SIDEBAR_BREAKPOINT,
  navigationRailWidth,
} from '@/theme/layout';
import { useQashyTheme } from '@/theme/theme';

// Icon names mirror the SF Symbols used by the native tabs in `_layout.tsx` so
// the same section reads the same on every platform.
const NAV_ITEMS = [
  { href: '/overview' as const, label: 'Overview', icon: 'house', match: '/overview' },
  { href: '/transactions' as const, label: 'Transactions', icon: 'list.bullet.rectangle', match: '/transactions' },
  { href: '/plan' as const, label: 'Plan', icon: 'chart.pie', match: '/plan' },
  { href: '/more' as const, label: 'More', icon: 'ellipsis.circle', match: '/more' },
];

const pressSpring = {
  damping: 20,
  stiffness: 380,
  mass: 0.7,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
} as const;

// The selected indicator travels between sections rather than each item fading
// its own background in and out. Two discrete fades read as two unrelated
// events; one continuous movement reads as a single surface responding, and it
// is the difference between the navigation looking animated and looking fluid.
const indicatorTiming = {
  duration: 260,
  easing: Easing.bezier(0.2, 0, 0, 1),
  reduceMotion: ReduceMotion.System,
} as const;

// Hover affordances fade in place rather than mounting and unmounting.
// Reanimated's web exit moves the leaving element into a clone and appends that
// clone as the *last* child of the pressable, so the opaque hover background —
// which paints behind the icon while it is a real child — reappeared on top of
// the icon for the length of its own fade. The icon blinked every time the
// pointer left an item, and again when a click made that item active and
// unmounted the background under it.
const hoverTiming = {
  duration: 120,
  easing: Easing.bezier(0.2, 0, 0, 1),
  reduceMotion: ReduceMotion.System,
} as const;

// The tooltip keeps its original asymmetry: it arrives at the standard enter
// duration and leaves at the faster exit one.
const tooltipInTiming = { ...hoverTiming, duration: 200 } as const;
const tooltipOutTiming = hoverTiming;
/** How far the tooltip slides in from, matching the shared motion system. */
const TOOLTIP_TRAVEL = 8;

type NavItem = typeof NAV_ITEMS[number];
type NavMetrics = Pick<LayoutRectangle, 'x' | 'y' | 'width' | 'height'>;

function isActiveItem(item: NavItem, pathname: string) {
  return pathname === item.match
    || pathname.startsWith(`${item.match}/`)
    || (item.match === '/overview' && pathname === '/');
}

function NavigationItem({
  item,
  active,
  compact,
  mobile,
  narrow,
  onMeasure,
}: {
  item: NavItem;
  active: boolean;
  compact: boolean;
  mobile: boolean;
  /** Viewports where a quarter of the bar is too tight for "Transactions". */
  narrow: boolean;
  onMeasure: (href: string, metrics: NavMetrics) => void;
}) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const [showTooltip, setShowTooltip] = useState(false);
  const currentPageProps = active ? { 'aria-current': 'page' as const } : {};
  const foreground = active ? theme.onAccentContainer : showTooltip ? theme.text : theme.textMuted;
  const pressScale = useSharedValue(1);
  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }],
  }));

  // The selected item already carries the accent indicator, so it never shows
  // the hover background underneath it.
  const highlighted = showTooltip && !active;
  const tooltipShown = compact && !mobile && showTooltip;
  const highlight = useSharedValue(0);
  const tooltipProgress = useSharedValue(0);

  useEffect(() => {
    highlight.set(withTiming(highlighted ? 1 : 0, hoverTiming));
  }, [highlight, highlighted]);

  useEffect(() => {
    tooltipProgress.set(withTiming(tooltipShown ? 1 : 0, tooltipShown ? tooltipInTiming : tooltipOutTiming));
  }, [tooltipProgress, tooltipShown]);

  const highlightStyle = useAnimatedStyle(() => ({ opacity: highlight.value }));
  const tooltipStyle = useAnimatedStyle(() => ({
    opacity: tooltipProgress.value,
    transform: [{ translateX: (1 - tooltipProgress.value) * TOOLTIP_TRAVEL }],
  }));
  return (
    <Link href={item.href} asChild>
      {/* Link asChild drops function-form styles on web, so this must stay a
          plain style object; animated feedback lives on the inner views. */}
      <Pressable
        {...currentPageProps}
        accessibilityHint={compact && !mobile ? t(item.label) : undefined}
        accessibilityLabel={t(item.label)}
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        aria-selected={active}
        onBlur={() => setShowTooltip(false)}
        onFocus={() => setShowTooltip(true)}
        onHoverIn={() => setShowTooltip(true)}
        onHoverOut={() => setShowTooltip(false)}
        onLayout={(event) => {
          const { x, y, width, height } = event.nativeEvent.layout;
          onMeasure(item.href, { x, y, width, height });
        }}
        onPressIn={() => pressScale.set(withSpring(0.95, pressSpring))}
        onPressOut={() => pressScale.set(withSpring(1, pressSpring))}
        style={{
          minHeight: 48,
          minWidth: mobile ? 64 : compact ? 52 : undefined,
          flex: mobile ? 1 : undefined,
          paddingHorizontal: mobile ? (narrow ? 2 : 4) : compact ? 12 : 16,
          borderRadius: 16,
          borderCurve: 'continuous',
          backgroundColor: 'transparent',
          position: 'relative',
          zIndex: showTooltip ? 20 : undefined,
        }}>
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              borderRadius: 16,
              borderCurve: 'continuous',
              backgroundColor: theme.surfaceMuted,
            },
            highlightStyle,
          ]}
        />
        <Animated.View
          style={[
            {
              flex: 1,
              alignSelf: 'stretch',
              flexDirection: mobile ? 'column' : !compact ? 'row' : 'column',
              alignItems: 'center',
              justifyContent: mobile ? 'center' : 'flex-start',
              gap: mobile ? 3 : 10,
            },
            contentStyle,
          ]}>
          <AppIcon name={item.icon} color={foreground as string} size={mobile ? 22 : 20} />
          {mobile || !compact ? (
            <AppText selectable={false} variant="label" numberOfLines={1} style={{ color: foreground, fontSize: mobile ? (narrow ? 10 : 11) : 15, letterSpacing: mobile && narrow ? -0.2 : undefined }}>
              {item.label}
            </AppText>
          ) : null}
        </Animated.View>
        {/* Mounted for the whole time the rail is compact, so only a breakpoint
            change adds or removes it. `aria-hidden` keeps a faded-out tooltip
            out of the accessibility tree exactly as unmounting used to. */}
        {compact && !mobile ? (
          <Animated.View
            aria-hidden={!showTooltip}
            pointerEvents="none"
            role="tooltip"
            style={[
              {
                position: 'absolute',
                left: 58,
                top: 7,
                minHeight: 36,
                justifyContent: 'center',
                paddingHorizontal: 12,
                borderRadius: 10,
                backgroundColor: theme.surfaceElevated,
                borderWidth: 1,
                borderColor: theme.border,
                boxShadow: '0 4px 14px rgba(25,27,32,0.16)',
              },
              tooltipStyle,
            ]}>
            <AppText selectable={false} variant="caption" numberOfLines={1}>{item.label}</AppText>
          </Animated.View>
        ) : null}
      </Pressable>
    </Link>
  );
}

/**
 * The items plus the indicator that slides between them.
 *
 * The items live in their own container rather than directly in the padded
 * navigation surface, so `onLayout` coordinates and the absolutely positioned
 * indicator resolve against exactly the same box — the bottom bar's top border
 * would otherwise offset one against the other.
 */
function NavigationBar({
  mobile,
  compact,
  narrow,
  pathname,
}: {
  mobile: boolean;
  compact: boolean;
  narrow: boolean;
  pathname: string;
}) {
  const theme = useQashyTheme();
  const reduceMotion = useReducedMotion();
  const [metrics, setMetrics] = useState<Record<string, NavMetrics>>({});
  const activeHref = NAV_ITEMS.find((item) => isActiveItem(item, pathname))?.href;
  const activeMetrics = activeHref ? metrics[activeHref] : undefined;

  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const shown = useSharedValue(0);

  useEffect(() => {
    // Both bars are always mounted and one is `display: none`, so the hidden
    // one measures zero. There is nothing to position until it is on screen.
    if (!activeMetrics || activeMetrics.width === 0 || activeMetrics.height === 0) return;
    // A first measurement has nowhere to slide from, so it is placed rather
    // than moved — otherwise the indicator flies in from the corner on load.
    const place = shown.get() === 0 || reduceMotion;
    const apply = (value: SharedValue<number>, next: number) => {
      value.set(place ? next : withTiming(next, indicatorTiming));
    };
    apply(x, activeMetrics.x);
    apply(y, activeMetrics.y);
    apply(width, activeMetrics.width);
    apply(height, activeMetrics.height);
    shown.set(place ? 1 : withTiming(1, indicatorTiming));
  }, [activeMetrics, height, reduceMotion, shown, width, x, y]);

  const indicatorStyle = useAnimatedStyle(() => ({
    opacity: shown.value,
    width: width.value,
    height: height.value,
    transform: [{ translateX: x.value }, { translateY: y.value }],
  }));

  const handleMeasure = useCallback((href: string, next: NavMetrics) => {
    setMetrics((current) => {
      const previous = current[href];
      if (previous
        && previous.x === next.x
        && previous.y === next.y
        && previous.width === next.width
        && previous.height === next.height) {
        return current;
      }
      return { ...current, [href]: next };
    });
  }, []);

  return (
    <View
      style={{
        position: 'relative',
        flexDirection: mobile ? 'row' : 'column',
        alignItems: mobile ? 'center' : 'stretch',
        flex: mobile ? 1 : undefined,
        gap: mobile ? 0 : 8,
        zIndex: mobile ? undefined : 10,
      }}>
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            borderRadius: 16,
            borderCurve: 'continuous',
            backgroundColor: theme.accentContainer,
          },
          indicatorStyle,
        ]}
      />
      {NAV_ITEMS.map((item) => (
        <NavigationItem
          key={item.label}
          item={item}
          active={item.href === activeHref}
          compact={compact}
          mobile={mobile}
          narrow={narrow}
          onMeasure={handleMeasure}
        />
      ))}
    </View>
  );
}

export default function WebTabsLayout() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const compact = width < NAV_SIDEBAR_BREAKPOINT;
  const mobile = width < NAV_RAIL_BREAKPOINT;
  const narrow = width < 360;
  // Screens size themselves against this rather than the window, so the rail
  // widening at 1200 no longer pushes their internal breakpoints around.
  const railWidth = navigationRailWidth(width);

  return (
    <View style={{ flex: 1, flexDirection: mobile ? 'column' : 'row', backgroundColor: theme.background }}>
      <View
        accessibilityLabel={t('Primary')}
        role="navigation"
        style={{
          display: mobile ? 'none' : 'flex',
          width: railWidth,
          // `viewport-fit=cover` means an installed PWA draws under the status
          // bar and the display cutouts, so the rail has to pad by real insets.
          paddingTop: 18 + insets.top,
          paddingBottom: 18 + insets.bottom,
          paddingLeft: 18 + insets.left,
          paddingRight: 18,
          borderRightWidth: 1,
          borderRightColor: theme.border,
          gap: 28,
        }}>
        <View style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: compact ? 'center' : 'flex-start', gap: 12 }}>
          <View style={{ width: 38, height: 38, borderRadius: 13, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center' }}>
            <AppText selectable={false} variant="headline" style={{ color: theme.onAccent }}>Q</AppText>
          </View>
          {!compact ? <AppText variant="headline">Qashy</AppText> : null}
        </View>
        <NavigationBar mobile={false} compact={compact} narrow={narrow} pathname={pathname} />
        {!compact ? (
          <View style={{ marginTop: 'auto', gap: 4 }}>
            <AppText variant="caption" muted>LOCAL-FIRST FINANCE</AppText>
            <AppText variant="caption" muted>Your data stays on this device.</AppText>
          </View>
        ) : null}
      </View>
      <ContentWidthContext value={Math.max(width - railWidth, 0)}>
        <View style={{ flex: 1 }}><Slot /></View>
      </ContentWidthContext>
      <View
        accessibilityLabel={t('Primary')}
        role="navigation"
        style={{
          display: mobile ? 'flex' : 'none',
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          minHeight: 64 + insets.bottom,
          backgroundColor: theme.surfaceElevated,
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 8 + insets.left,
          paddingRight: 8 + insets.right,
          paddingTop: 6,
          paddingBottom: Math.max(6, insets.bottom),
          borderTopWidth: 1,
          borderTopColor: theme.border,
          boxShadow: '0 -2px 12px rgba(25,27,32,0.06)',
        }}>
        <NavigationBar mobile compact={false} narrow={narrow} pathname={pathname} />
      </View>
    </View>
  );
}
